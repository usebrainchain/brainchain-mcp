// The live side of BrainChain's problem board, for usebrainchain.com/problems: how many agents are at work on each
// problem now, how far each Lean problem's proof has come, and what changed lately. Lean problems are worked on an outside
// board, Left to Solve, which is read gently: one list of the problems agents are on a minute, and one problem's steps every
// 20 seconds at most, never its desk or verdict routes. BrainChain's own solvers say they are at work with POST
// /problems/beat. No agent is ever named: the feed holds slugs, counts and times, and the state holds agents only hashed.
import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { firstLine } from "../payments.js";
import { answer, type Answer } from "../signin.js";

export const LEFT_TO_SOLVE = "https://lefttosolve.com";
export const USER_AGENT = "BrainChainWatcher (+https://usebrainchain.com/problems)";

export interface LiveTiming {
  /** How often the list of problems agents are on is read. */
  listMs: number;
  /** The least time between two reads of a problem's steps. */
  detailMs: number;
  /** How long a read of BrainChain's board is used before it is read again. */
  boardMs: number;
  /** After a failed read Left to Solve is left alone this long, then twice as long, up to `maxBackoffMs`. */
  firstBackoffMs: number;
  maxBackoffMs: number;
  /** How long a solver counts as at work after its last beat, the rule Left to Solve uses for its own count. */
  beatMs: number;
}

export const LIVE_TIMING: LiveTiming = { listMs: 60_000, detailMs: 20_000, boardMs: 5 * 60_000, firstBackoffMs: 60_000, maxBackoffMs: 10 * 60_000, beatMs: 15 * 60_000 };
/** The most events the feed keeps, newest first. */
export const MAX_EVENTS = 60;
const REQUEST_MS = 10_000;
const MAX_BODY = 2_000_000;
/** The list is read a page of this many at a time; a further page only while the last one still has an agent on it. */
const PAGE = 200;
const MAX_PAGES = 5;
const MAX_STEPS = 2_000;
/** A host that says how long to wait is believed up to this long. */
const MAX_RETRY_AFTER_MS = 60 * 60_000;
const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;
const SOURCE_ID = /^[\w.'-]{1,200}$/;

export type LiveKind = "joined" | "left" | "split" | "step" | "answer" | "solved";

export interface LiveEvent {
  at: string;
  problem: string;
  kind: LiveKind;
  count?: number;
  detail?: { proved: number; total: number } | { beat: false };
}

/** An answer to a record problem the call index found in BrainChain's DecisionLog. */
export interface RecordAnswer {
  problem: string;
  grade: string;
  at: string;
  accepted: boolean;
}

interface Listed {
  slug: string;
  kind: "record" | "lean";
  /** Left to Solve's id for a Lean problem. */
  id?: string;
  /** The line a record problem's brief opens with, which a grade's recorded brief holds. */
  line?: string;
  claimed: boolean;
  claimedAt?: string;
}

interface Progress {
  /** Set once Left to Solve's steps for the problem have been read, so the first read is taken in silently. */
  read?: boolean;
  reductions?: string[];
  proved?: string[];
  steps?: { total: number; proved: number };
  solution?: boolean;
  claimed?: boolean;
  solved?: boolean;
  last?: string;
}

interface Beat {
  problem: string;
  /** HMAC of the agent's id, keyed with the beat key: the id itself is never kept. */
  agent: string;
  at: number;
}

interface Kept {
  board?: { at: string; problems: Listed[] };
  events: LiveEvent[];
  problems: Record<string, Progress>;
  beats: Beat[];
  /** The grades already shown as answers, so a call index that reads a span again shows none twice. */
  answers: string[];
}

export interface ProblemsLiveOptions {
  /** Where the feed's state is kept. */
  dir: string;
  problemsUrl: string;
  /** BRAINCHAIN_BEAT_KEY: beats are taken only with it, and without one POST /problems/beat is not served. */
  beatKey?: string;
  fetch?: typeof fetch;
  now?: () => number;
  say?: (line: string) => void;
  timing?: Partial<LiveTiming>;
}

export interface ProblemsLive {
  /** GET /problems/live. */
  live(): Answer;
  /** Whether POST /problems/beat is served. */
  readonly beats: boolean;
  /** Whether a request carries the beat key, compared in constant time. */
  authorized(token: string | undefined): boolean;
  /** POST /problems/beat, once `authorized` has passed. */
  beat(body: unknown): Answer;
  /** For the call index: whether a grade's recorded brief is an answer to a record problem, and which. */
  answerTo(brief: string): string | undefined;
  /** An answer the call index found, shown once. */
  answered(found: RecordAnswer): void;
  /** One round: the board when due, then at most one read of Left to Solve, then the counts. */
  tick(): Promise<void>;
  start(): void;
  stop(): void;
  status(): Record<string, unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const iso = (value: unknown): string | undefined => {
  if (typeof value !== "string" || value.length > 40) return undefined;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : new Date(at).toISOString();
};
const later = (a: string | undefined, b: string | undefined) => (!a ? b : !b ? a : a > b ? a : b);

/** The problems BrainChain's board lists, records and Lean, from problems.json. Throws when it is not the format this knows. */
export function boardProblems(body: unknown): Listed[] {
  if (!isRecord(body) || !Array.isArray(body.problems)) throw new Error("the problem board is not in the format this version knows");
  const entries = [...body.problems, ...(Array.isArray(body.lean) ? body.lean : [])];
  const seen = new Set<string>();
  return entries.flatMap((p): Listed[] => {
    if (!isRecord(p) || typeof p.problem !== "string" || !SLUG.test(p.problem) || seen.has(p.problem)) return [];
    seen.add(p.problem);
    const claim = isRecord(p.claim) ? p.claim : undefined;
    const claimedAt = iso(claim?.at);
    const claimed = { claimed: claim !== undefined, ...(claimedAt ? { claimedAt } : {}) };
    if (p.kind === "lean") {
      const id = isRecord(p.source) && typeof p.source.id === "string" && SOURCE_ID.test(p.source.id) ? p.source.id : undefined;
      return id ? [{ slug: p.problem, kind: "lean", id, ...claimed }] : [];
    }
    return isText(p.name) && p.name.length <= 200 ? [{ slug: p.problem, kind: "record", line: `${p.name}. An open problem on BrainChain's problem board`, ...claimed }] : [];
  });
}

/** What Left to Solve says about one problem: its steps and whether it is solved. Throws when it is not readable. */
export function leanDetail(body: unknown): { steps: { id: string; reduction: string; created?: string; solved: boolean }[]; solution: boolean; solvedAt?: string } {
  if (!isRecord(body) || !Array.isArray(body.steps)) throw new Error("Left to Solve's problem is not in the format this version knows");
  const steps = body.steps.slice(0, MAX_STEPS).flatMap((s) => {
    if (!isRecord(s) || !isText(s.id) || s.id.length > 300 || !isText(s.reduction) || s.reduction.length > 300) return [];
    const created = iso(s.created_at);
    return [{ id: s.id, reduction: s.reduction, ...(created ? { created } : {}), solved: s.solved === true }];
  });
  const solution = body.solution !== null && body.solution !== undefined;
  const solvedAt = solution && isRecord(body.solution) ? iso(body.solution.created_at) : undefined;
  return { steps, solution, ...(solvedAt ? { solvedAt } : {}) };
}

/** Each problem's agents from one page of `GET /api/problems?sort=active`, and whether its last item still had any. */
export function activePage(body: unknown): { counts: Map<string, number>; more: boolean; items: number } {
  if (!isRecord(body) || !Array.isArray(body.items)) throw new Error("Left to Solve's list is not in the format this version knows");
  const counts = new Map<string, number>();
  const items = body.items.slice(0, PAGE);
  for (const item of items) {
    if (!isRecord(item) || typeof item.id !== "string" || !SOURCE_ID.test(item.id)) continue;
    const n = item.liveAgents;
    if (typeof n === "number" && Number.isSafeInteger(n) && n > 0 && n <= 100_000) counts.set(item.id, n);
  }
  const last = items.at(-1);
  return { counts, more: items.length === PAGE && isRecord(last) && typeof last.liveAgents === "number" && last.liveAgents > 0, items: items.length };
}

class ReadError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/** A JSON answer, read within the time limit and the size cap. Left to Solve is read without following a redirect. */
async function readJson(fetchImpl: typeof fetch, url: string, headers: Record<string, string>, redirect: RequestRedirect = "follow"): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { accept: "application/json", ...headers }, redirect, signal: AbortSignal.timeout(REQUEST_MS) });
  } catch (error) {
    throw new ReadError(firstLine(error));
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    const retry = Number(response.headers.get("retry-after"));
    throw new ReadError(`answered ${response.status}`, response.status, retry > 0 ? Math.min(retry * 1000, MAX_RETRY_AFTER_MS) : undefined);
  }
  if (Number(response.headers.get("content-length") ?? 0) > MAX_BODY) {
    await response.body?.cancel().catch(() => {});
    throw new ReadError("answered more than the watcher reads");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for await (const chunk of (response.body ?? []) as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > MAX_BODY) throw new ReadError("answered more than the watcher reads");
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) {
    if (error instanceof ReadError) throw error;
    throw new ReadError(`answered something that is not JSON (${firstLine(error)})`);
  }
}

export function createProblemsLive({ dir, problemsUrl, beatKey, fetch: fetchImpl = fetch, now = Date.now, say = () => {}, timing = {} }: ProblemsLiveOptions): ProblemsLive {
  const t = { ...LIVE_TIMING, ...timing };
  const file = join(dir, "live.json");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const kept: Kept = { events: [], problems: {}, beats: [], answers: [] };
  if (existsSync(file)) {
    try {
      const read = JSON.parse(readFileSync(file, "utf8")) as Partial<Kept>;
      Object.assign(kept, {
        ...(isRecord(read.board) && Array.isArray(read.board.problems) ? { board: read.board } : {}),
        events: Array.isArray(read.events) ? read.events.slice(0, MAX_EVENTS) : [],
        problems: isRecord(read.problems) ? read.problems : {},
        beats: Array.isArray(read.beats) ? read.beats : [],
        answers: Array.isArray(read.answers) ? read.answers : [],
      });
    } catch (error) {
      say(`problems: ${file} could not be read (${firstLine(error)}), so the feed starts again from nothing`);
    }
  }
  let boardAt = kept.board ? Date.parse(kept.board.at) : 0;
  let boardTried = 0;
  // Left to Solve: each Lean problem's agents from the last good list, and how its reads are going.
  let counts: Map<string, number> | undefined;
  let listAt = 0;
  let askedAt = 0;
  let readAt: string | undefined;
  let failures = 0;
  let waitUntil = 0;
  let lastError: string | undefined;
  let turn = 0;
  // What the counts were at the last round, per problem. Empty after a start, so the first round is taken in silently.
  const shown = new Map<string, { lts?: number; ours: number }>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticking = false;

  const listed = () => kept.board?.problems ?? [];
  const progress = (slug: string) => (kept.problems[slug] ??= {});

  function save(): void {
    try {
      writeFileSync(`${file}.next`, `${JSON.stringify(kept)}\n`, { mode: 0o600 });
      renameSync(`${file}.next`, file);
    } catch (error) {
      say(`problems: the feed's state could not be saved (${firstLine(error)})`);
    }
  }

  function add(events: LiveEvent[]): void {
    if (!events.length) return;
    for (const event of events) progress(event.problem).last = later(progress(event.problem).last, event.at);
    kept.events = [...events, ...kept.events].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, MAX_EVENTS);
  }

  const ours = (at: number) => {
    const counted = new Map<string, number>();
    for (const beat of kept.beats) if (at - beat.at < t.beatMs) counted.set(beat.problem, (counted.get(beat.problem) ?? 0) + 1);
    return counted;
  };

  /** The counts now; a change since the last round is an event, and a problem's first round, or Left to Solve's, is not. */
  function settle(): void {
    const at = now();
    const before = kept.beats.length;
    kept.beats = kept.beats.filter((beat) => at - beat.at < t.beatMs);
    const mine = ours(at);
    const events: LiveEvent[] = [];
    const stamp = new Date(at).toISOString();
    for (const p of listed()) {
      const cur = { ...(p.kind === "lean" && counts ? { lts: counts.get(p.id!) ?? 0 } : {}), ours: mine.get(p.slug) ?? 0 };
      const prev = shown.get(p.slug);
      shown.set(p.slug, cur);
      if (!prev) continue;
      const change = cur.ours - prev.ours + (prev.lts === undefined || cur.lts === undefined ? 0 : cur.lts - prev.lts);
      if (change !== 0) events.push({ at: stamp, problem: p.slug, kind: change > 0 ? "joined" : "left", count: (cur.lts ?? 0) + cur.ours });
    }
    for (const slug of shown.keys()) if (!listed().some((p) => p.slug === slug)) shown.delete(slug);
    add(events);
    if (events.length || kept.beats.length !== before) save();
  }

  /** A problem's solved state from either source; it turning true is an event unless the problem is new to the feed. */
  function solvedNow(slug: string, quiet: boolean, at: string, events: LiveEvent[]): void {
    const k = progress(slug);
    const solved = k.solution === true || k.claimed === true;
    if (solved && !k.solved && !quiet) events.push({ at, problem: slug, kind: "solved" });
    k.solved = solved;
  }

  async function readBoard(): Promise<void> {
    boardTried = now();
    let problems: Listed[];
    try {
      problems = boardProblems(await readJson(fetchImpl, problemsUrl, {}));
    } catch (error) {
      say(`problems: BrainChain's board could not be read (${firstLine(error)}); the feed keeps the board it read last`);
      return;
    }
    const at = now();
    const events: LiveEvent[] = [];
    for (const p of problems) {
      const fresh = kept.problems[p.slug] === undefined;
      const k = progress(p.slug);
      k.claimed = p.claimed;
      solvedNow(p.slug, fresh, p.claimedAt ?? new Date(at).toISOString(), events);
    }
    kept.board = { at: new Date(at).toISOString(), problems };
    boardAt = at;
    add(events);
    save();
  }

  function failed(error: unknown): void {
    failures += 1;
    const backoff = Math.min(t.firstBackoffMs * 2 ** (failures - 1), t.maxBackoffMs);
    const asked = error instanceof ReadError ? error.retryAfterMs ?? 0 : 0;
    waitUntil = now() + Math.max(backoff, asked);
    lastError = firstLine(error);
    say(`problems: Left to Solve ${lastError}; left alone until ${new Date(waitUntil).toISOString()}, the feed keeps its last figures`);
  }

  const ltsHeaders = { "user-agent": USER_AGENT };

  async function readList(): Promise<void> {
    listAt = now();
    askedAt = listAt;
    const found = new Map<string, number>();
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = `${LEFT_TO_SOLVE}/api/problems?sort=active&limit=${PAGE}${page ? `&offset=${page * PAGE}` : ""}`;
      const read = activePage(await readJson(fetchImpl, url, ltsHeaders, "error"));
      for (const [id, n] of read.counts) found.set(id, n);
      if (!read.more) break;
    }
    counts = found;
    readAt = new Date(now()).toISOString();
  }

  async function readDetail(problem: Listed): Promise<void> {
    askedAt = now();
    let body: unknown;
    try {
      body = await readJson(fetchImpl, `${LEFT_TO_SOLVE}/api/problems/${encodeURIComponent(problem.id!)}`, ltsHeaders, "error");
    } catch (error) {
      // A problem Left to Solve does not have is passed over, and does not hold back the others.
      if (error instanceof ReadError && error.status === 404) return void say(`problems: Left to Solve has no problem ${problem.id}, listed as ${problem.slug}`);
      throw error;
    }
    const { steps, solution, solvedAt } = leanDetail(body);
    const k = progress(problem.slug);
    const at = new Date(now()).toISOString();
    const reductions = new Map<string, { created?: string; steps: number }>();
    for (const step of steps) {
      const r = reductions.get(step.reduction) ?? { steps: 0 };
      r.steps += 1;
      if (step.created && (!r.created || step.created < r.created)) r.created = step.created;
      reductions.set(step.reduction, r);
    }
    const proved = steps.filter((step) => step.solved).map((step) => step.id);
    const events: LiveEvent[] = [];
    if (k.read) {
      const knownReductions = new Set(k.reductions ?? []);
      const knownProved = new Set(k.proved ?? []);
      const fresh = [...reductions].filter(([id]) => !knownReductions.has(id)).sort(([, a], [, b]) => (a.created ?? at).localeCompare(b.created ?? at));
      let total = steps.length - fresh.reduce((sum, [, r]) => sum + r.steps, 0);
      let done = proved.filter((id) => knownProved.has(id)).length;
      for (const [, r] of fresh) {
        total += r.steps;
        events.push({ at: r.created && r.created < at ? r.created : at, problem: problem.slug, kind: "split", count: r.steps, detail: { proved: done, total } });
      }
      for (const _ of proved.filter((id) => !knownProved.has(id))) {
        done += 1;
        events.push({ at, problem: problem.slug, kind: "step", detail: { proved: done, total } });
      }
    } else {
      // Taken in silently, with the problem's newest step as its last activity.
      k.last = later(k.last, [...reductions.values()].reduce<string | undefined>((newest, r) => later(newest, r.created), undefined));
    }
    k.reductions = [...reductions.keys()];
    k.proved = proved;
    k.steps = { total: steps.length, proved: proved.length };
    k.solution = solution;
    solvedNow(problem.slug, !k.read, solvedAt && solvedAt < at ? solvedAt : at, events);
    if (solvedAt) k.last = later(k.last, solvedAt);
    k.read = true;
    add(events);
    save();
  }

  async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      const at = now();
      if (at - boardAt >= t.boardMs && at - boardTried >= t.firstBackoffMs) await readBoard();
      const lean = listed().filter((p) => p.kind === "lean");
      // One request to Left to Solve at a time, 20 seconds apart at least: the list when it is due, else one problem's steps.
      if (lean.length && now() >= waitUntil && now() - askedAt >= t.detailMs) {
        try {
          if (now() - listAt >= t.listMs) await readList();
          else await readDetail(lean[turn++ % lean.length]!);
          failures = 0;
          lastError = undefined;
        } catch (error) {
          failed(error);
        }
      }
      settle();
    } finally {
      ticking = false;
    }
  }

  const key = beatKey ? Buffer.from(beatKey) : undefined;
  const hashed = (agent: string) => createHmac("sha256", key!).update(agent).digest("hex").slice(0, 32);

  function feed() {
    const at = now();
    const mine = ours(at);
    const problems: Record<string, { kind: "record" | "lean"; now: number; steps: { total: number; proved: number } | null; solved: boolean; last: string | null }> = {};
    let total = 0;
    let proved = 0;
    let solved = 0;
    let working = 0;
    let busy = 0;
    for (const p of listed()) {
      const k = kept.problems[p.slug] ?? {};
      const n = (p.kind === "lean" && counts ? counts.get(p.id!) ?? 0 : 0) + (mine.get(p.slug) ?? 0);
      const steps = p.kind === "lean" && k.steps ? { total: k.steps.total, proved: k.steps.proved } : null;
      problems[p.slug] = { kind: p.kind, now: n, steps, solved: k.solved === true, last: k.last ?? null };
      total += steps?.total ?? 0;
      proved += steps?.proved ?? 0;
      solved += k.solved ? 1 : 0;
      working += n;
      busy += n > 0 ? 1 : 0;
    }
    const lean = listed().some((p) => p.kind === "lean");
    return {
      readAt: new Date(at).toISOString(),
      board: { listed: listed().length, open: listed().length - solved, solved, steps: { total, proved } },
      working: { now: working, problems: busy },
      problems,
      events: kept.events.map(({ at, problem, kind, count, detail }) => ({ at, problem, kind, ...(count !== undefined ? { count } : {}), ...(detail ? { detail } : {}) })),
      sources: { lefttosolve: { readAt: readAt ?? null, ok: !lean || (readAt !== undefined && failures === 0) }, brainchain: { readAt: kept.board!.at } },
    };
  }

  return {
    live: () => (kept.board ? { status: 200, body: feed() } : answer(503, "unavailable", "The live figures are not in yet: BrainChain's problem board has not been read. Try again in a minute.")),
    beats: key !== undefined,

    authorized(token) {
      if (!key || token === undefined) return false;
      const given = Buffer.from(token);
      return given.length === key.length && timingSafeEqual(given, key);
    },

    beat(body) {
      if (!key) return answer(404, "beats", "This watcher takes no beats.");
      if (!isRecord(body)) return answer(400, "request", "Send the beat as a JSON object: problem, agent and state.");
      const { problem, agent, state, ...rest } = body;
      const extra = Object.keys(rest);
      if (extra.length) return answer(400, "request", `Unknown field${extra.length === 1 ? "" : "s"}: ${extra.slice(0, 5).join(", ")}. A beat takes problem, agent and state.`);
      if (typeof agent !== "string" || agent.length < 1 || agent.length > 200 || /[\p{Cc}]/u.test(agent)) return answer(400, "agent", "agent must be an opaque id for the solver, 1 to 200 characters, the same in each of its beats.");
      if (state !== "working" && state !== "stopped") return answer(400, "state", 'state must be "working" or "stopped".');
      if (!kept.board) return answer(503, "unavailable", "BrainChain's problem board has not been read yet. Try again in a minute.");
      if (typeof problem !== "string" || !listed().some((p) => p.slug === problem)) {
        return answer(404, "problem", `BrainChain's board lists no problem named ${typeof problem === "string" ? problem.slice(0, 80) : "that"}. It lists ${listed().map((p) => p.slug).join(", ") || "none"}.`);
      }
      const id = hashed(agent);
      const at = now();
      kept.beats = kept.beats.filter((beat) => !(beat.problem === problem && beat.agent === id));
      if (state === "working") kept.beats.push({ problem, agent: id, at });
      save();
      settle();
      return { status: 200, body: { problem, state, ...(state === "working" ? { countedUntil: new Date(at + t.beatMs).toISOString() } : {}) } };
    },

    answerTo(brief) {
      return listed().find((p) => p.kind === "record" && p.line && brief.includes(p.line))?.slug;
    },

    answered({ problem, grade, at, accepted }) {
      if (kept.answers.includes(grade) || !listed().some((p) => p.slug === problem && p.kind === "record")) return;
      kept.answers = [...kept.answers, grade].slice(-1000);
      add([{ at: iso(at) ?? new Date(now()).toISOString(), problem, kind: "answer", ...(accepted ? {} : { detail: { beat: false as const } }) }]);
      save();
    },

    tick,
    start() {
      void tick();
      timer = setInterval(() => void tick(), t.detailMs);
      timer.unref();
    },
    stop() {
      clearInterval(timer);
    },
    status: () => ({
      board: kept.board ? { readAt: kept.board.at, problems: listed().length } : null,
      lefttosolve: { readAt: readAt ?? null, failures, ...(waitUntil > now() ? { waitingUntil: new Date(waitUntil).toISOString() } : {}), ...(lastError ? { lastError } : {}) },
      beats: key ? kept.beats.length : "off",
      events: kept.events.length,
    }),
  };
}

/** The beat key from BRAINCHAIN_BEAT_KEY, or none; throws what is wrong with one that is set. */
export function beatKeyFrom(env: Record<string, string | undefined>): string | undefined {
  const key = env.BRAINCHAIN_BEAT_KEY?.trim();
  if (!key) return undefined;
  if (!/^[\w-]{32,255}$/.test(key)) throw new Error("BRAINCHAIN_BEAT_KEY must be 32 to 255 letters, digits, - or _, such as 32 random bytes in hex.");
  return key;
}
