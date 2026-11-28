import { mkdtempSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EventLog } from "./events.js";
import { activePage, beatKeyFrom, createProblemsLive, leanDetail, LIVE_TIMING, USER_AGENT, type ProblemsLiveOptions } from "./problems.js";
import { serveEvents } from "./serve.js";

const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8")) as Record<string, unknown>;
const ACTIVE = fixture("lefttosolve-active.json") as { items: { id: string; liveAgents: number }[] };
const ERDOS_128 = fixture("lefttosolve-erdos128.json") as { steps: Record<string, unknown>[]; solution: unknown };

const BOARD = "https://usebrainchain.com/problems.json";
const LIST = "https://lefttosolve.com/api/problems?sort=active&limit=200";
const DETAIL = "https://lefttosolve.com/api/problems/";
const KEY = "a".repeat(64);
const NOW = Date.parse("2026-11-28T15:00:00Z");
// The busiest problem on the saved list page, with 3 agents on it, listed here as a second Lean problem.
const BUSY = ACTIVE.items[0]!.id;

const record = { problem: "cap-set-8", version: 1, name: "Cap set, dimension 8", record: { display: "512 points" }, claim: null, briefId: "0x01", request: { brief: "Cap set, dimension 8. An open problem on BrainChain's problem board, https://usebrainchain.com/problems (version 1)." } };
const lean = (problem: string, id: string) => ({ problem, kind: "lean", version: 1, name: problem, bounty: 250, opened: "2026-11-28T09:51:22.525Z", source: { name: "Left to Solve", id, api: `${DETAIL}${id}` }, claim: null });
const board = (extra: Record<string, unknown> = {}) => ({ board: "https://usebrainchain.com/problems", open: true, problems: [{ ...record, ...extra }], lean: [lean("erdos-128", "Erdos128.erdos_128"), lean("busy-one", BUSY)] });

interface World {
  board: unknown;
  list: unknown;
  details: Record<string, unknown>;
  down?: number;
}

function world(): { world: World; asked: { url: string; agent: string | null }[]; fetch: typeof fetch } {
  const w: World = { board: board(), list: structuredClone(ACTIVE), details: { "Erdos128.erdos_128": structuredClone(ERDOS_128), [BUSY]: { steps: [], solution: null } } };
  const asked: { url: string; agent: string | null }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    asked.push({ url: req.url, agent: req.headers.get("user-agent") });
    if (req.url === BOARD) return Response.json(w.board);
    if (w.down) return new Response("busy", { status: w.down });
    if (req.url.startsWith(LIST)) return Response.json(w.list);
    const id = decodeURIComponent(req.url.slice(DETAIL.length));
    return id in w.details ? Response.json(w.details[id]) : Response.json({ error: "not found" }, { status: 404 });
  }) as typeof fetch;
  return { world: w, asked, fetch: fetchImpl };
}

function feed(options: Partial<ProblemsLiveOptions> & { fetch: typeof fetch; clock: { now: number }; dir?: string }) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "brainchain-live-"));
  const live = createProblemsLive({ dir, problemsUrl: BOARD, beatKey: KEY, ...options, now: () => options.clock.now });
  const body = () => live.live().body as { board: Record<string, unknown>; working: { now: number; problems: number }; problems: Record<string, { now: number; steps: { total: number; proved: number } | null; solved: boolean; last: string | null }>; events: { kind: string; problem: string; count?: number; detail?: unknown; at: string }[]; sources: { lefttosolve: { ok: boolean; readAt: string | null } } };
  return { live, body, dir };
}

const setAgents = (w: World, id: string, n: number) => {
  const list = w.list as typeof ACTIVE;
  const item = list.items.find((i) => i.id === id);
  if (item) item.liveAgents = n;
  else list.items.unshift({ ...list.items[0]!, id, liveAgents: n });
};

describe("the live feed of the problem board", () => {
  it("takes in the agents already at work silently, then shows each change as joined or left with the new total", async () => {
    const { world: w, asked, fetch } = world();
    const clock = { now: NOW };
    const { live, body } = feed({ fetch, clock });
    await live.tick();
    expect(asked.map((a) => a.url)).toEqual([BOARD, LIST]);
    expect(asked.filter((a) => a.url !== BOARD).every((a) => a.agent === USER_AGENT)).toBe(true);
    expect(body().events).toEqual([]);
    expect(body().problems["busy-one"]!.now).toBe(3);
    expect(body().working).toEqual({ now: 3, problems: 1 });

    setAgents(w, "Erdos128.erdos_128", 2);
    clock.now += LIVE_TIMING.listMs;
    await live.tick();
    setAgents(w, BUSY, 1);
    clock.now += LIVE_TIMING.listMs;
    await live.tick();
    expect(body().events.map(({ kind, problem, count }) => ({ kind, problem, count }))).toEqual([
      { kind: "left", problem: "busy-one", count: 1 },
      { kind: "joined", problem: "erdos-128", count: 2 },
    ]);
    expect(body().working).toEqual({ now: 3, problems: 2 });
  });

  it("reads one problem's steps every 20 seconds at most, takes the first read in silently, then shows splits and proved steps", async () => {
    const { world: w, asked, fetch } = world();
    const clock = { now: NOW };
    const { live, body } = feed({ fetch, clock });
    await live.tick();
    await live.tick();
    expect(asked).toHaveLength(2);
    clock.now += LIVE_TIMING.detailMs;
    await live.tick();
    expect(asked.at(-1)!.url).toBe(`${DETAIL}Erdos128.erdos_128`);
    expect(body().problems["erdos-128"]).toMatchObject({ steps: { total: 22, proved: 8 }, solved: false, last: "2026-11-27T18:09:03.411Z" });
    expect(body().board).toEqual({ listed: 3, open: 3, solved: 0, steps: { total: 22, proved: 8 } });
    expect(body().events).toEqual([]);
    expect(body().problems["cap-set-8"]!.steps).toBeNull();

    const detail = w.details["Erdos128.erdos_128"] as typeof ERDOS_128;
    const parent = "Erdos128.erdos_128.R2.H3";
    detail.steps.unshift(
      { id: `${parent}.R1.H1`, reduction: `${parent}.R1`, parent, k: 1, created_at: "2026-11-28T14:59:30.5+00:00", solved: false, reduction_by: "someone" },
      { id: `${parent}.R1.H2`, reduction: `${parent}.R1`, parent, k: 2, created_at: "2026-11-28T14:59:30.5+00:00", solved: false, reduction_by: "someone" },
    );
    detail.steps.find((s) => s.id === "Erdos128.erdos_128.R2.H2")!.solved = true;
    clock.now += LIVE_TIMING.detailMs;
    await live.tick();
    expect(asked.at(-1)!.url).toBe(`${DETAIL}${encodeURIComponent(BUSY)}`);
    clock.now += LIVE_TIMING.detailMs;
    await live.tick();
    expect(asked.at(-1)!.url).toBe(LIST);
    clock.now += LIVE_TIMING.detailMs;
    await live.tick();
    expect(asked.at(-1)!.url).toBe(`${DETAIL}Erdos128.erdos_128`);
    expect(body().events).toEqual([
      { at: new Date(clock.now).toISOString(), problem: "erdos-128", kind: "step", detail: { proved: 9, total: 24 } },
      { at: "2026-11-28T14:59:30.500Z", problem: "erdos-128", kind: "split", count: 2, detail: { proved: 8, total: 24 } },
    ]);
    expect(body().problems["erdos-128"]!.steps).toEqual({ total: 24, proved: 9 });

    detail.solution = { polarity: "proof", pr_url: "https://github.com/x/y/pull/1", created_at: "2026-11-28T15:01:30Z" };
    const read = asked.length;
    do {
      clock.now += LIVE_TIMING.detailMs;
      await live.tick();
    } while (asked.at(-1)!.url !== `${DETAIL}Erdos128.erdos_128` || asked.length === read);
    expect(body().events[0]).toEqual({ at: "2026-11-28T15:01:30.000Z", problem: "erdos-128", kind: "solved" });
    expect(body().board).toMatchObject({ open: 2, solved: 1 });
  });

  it("backs off Left to Solve, doubling up to ten minutes, and keeps serving the last good figures", async () => {
    const { world: w, asked, fetch } = world();
    const clock = { now: NOW };
    const { live, body } = feed({ fetch, clock });
    await live.tick();
    w.down = 503;
    clock.now += LIVE_TIMING.listMs;
    await live.tick();
    const waits: number[] = [];
    const theirs = () => asked.filter((a) => a.url !== BOARD).length;
    let at = clock.now;
    let last = theirs();
    while (waits.length < 6) {
      clock.now += 10_000;
      await live.tick();
      if (theirs() === last) continue;
      expect(theirs()).toBe(last + 1);
      waits.push((clock.now - at) / 60_000);
      at = clock.now;
      last = theirs();
    }
    expect(waits).toEqual([1, 2, 4, 8, 10, 10]);
    expect(body().sources.lefttosolve.ok).toBe(false);
    expect(body().problems["busy-one"]!.now).toBe(3);
    expect(body().events).toEqual([]);
    w.down = undefined;
    clock.now += LIVE_TIMING.maxBackoffMs;
    await live.tick();
    expect(body().sources.lefttosolve.ok).toBe(true);
  });

  it("counts a solver for 15 minutes after its last beat, or until it stops, and refuses a problem the board does not list", async () => {
    const { fetch } = world();
    const clock = { now: NOW };
    const { live, body } = feed({ fetch, clock });
    await live.tick();
    expect(live.beat({ problem: "cap-set-8", agent: "run-1", state: "working" })).toMatchObject({ status: 200 });
    expect(live.beat({ problem: "cap-set-8", agent: "run-2", state: "working" })).toMatchObject({ status: 200 });
    expect(live.beat({ problem: "cap-set-8", agent: "run-2", state: "working" })).toMatchObject({ status: 200 });
    expect(body().problems["cap-set-8"]!.now).toBe(2);
    expect(body().events.map(({ kind, count }) => ({ kind, count }))).toEqual([
      { kind: "joined", count: 2 },
      { kind: "joined", count: 1 },
    ]);
    clock.now += 10 * 60_000;
    live.beat({ problem: "cap-set-8", agent: "run-1", state: "working" });
    clock.now += 5 * 60_000;
    await live.tick();
    expect(body().problems["cap-set-8"]!.now).toBe(1);
    expect(body().events[0]).toMatchObject({ kind: "left", count: 1 });
    expect(live.beat({ problem: "cap-set-8", agent: "run-1", state: "stopped" })).toMatchObject({ status: 200 });
    expect(body().problems["cap-set-8"]!.now).toBe(0);
    expect(body().events[0]).toMatchObject({ kind: "left", count: 0 });

    expect(live.beat({ problem: "not-listed", agent: "run-1", state: "working" })).toMatchObject({ status: 404, body: { reason: "problem" } });
    expect(live.beat({ problem: "cap-set-8", agent: "run-1", state: "busy" })).toMatchObject({ status: 400 });
    expect(live.beat({ problem: "cap-set-8", agent: "run-1", state: "working", name: "x" })).toMatchObject({ status: 400 });
    expect(live.authorized(KEY)).toBe(true);
    expect(live.authorized(`${KEY.slice(1)}b`)).toBe(false);
    expect(live.authorized(undefined)).toBe(false);
  });

  it("names no agent, ours or theirs: no handles, ids or Left to Solve's own names in the feed or its state", async () => {
    const { world: w, fetch } = world();
    const clock = { now: NOW };
    const { live, body, dir } = feed({ fetch, clock });
    await live.tick();
    live.beat({ problem: "erdos-128", agent: "solver-on-mac-7", state: "working" });
    for (let i = 0; i < 6; i++) {
      clock.now += LIVE_TIMING.detailMs;
      await live.tick();
    }
    (w.details["Erdos128.erdos_128"] as typeof ERDOS_128).steps[0]!.solved = true;
    clock.now += 3 * LIVE_TIMING.detailMs;
    await live.tick();
    await live.tick();
    const served = JSON.stringify(body());
    const state = readFileSync(join(dir, "live.json"), "utf8");
    const handles = [...new Set(ERDOS_128.steps.map((s) => String(s.reduction_by)))];
    expect(handles.length).toBeGreaterThan(0);
    for (const name of [...handles, "solver-on-mac-7", KEY]) {
      expect(served).not.toContain(name);
      expect(state).not.toContain(name);
    }
    for (const id of ["Erdos128", BUSY, "pull", "github"]) expect(served).not.toContain(id);
    expect(Object.keys(body().problems)).toEqual(["cap-set-8", "erdos-128", "busy-one"]);
  });

  it("keeps its events across a restart, and does not show the agents already at work as joining again", async () => {
    const { world: w, fetch } = world();
    const clock = { now: NOW };
    const first = feed({ fetch, clock });
    await first.live.tick();
    setAgents(w, "Erdos128.erdos_128", 1);
    clock.now += LIVE_TIMING.listMs;
    await first.live.tick();
    first.live.beat({ problem: "cap-set-8", agent: "run-1", state: "working" });
    first.live.answered({ problem: "cap-set-8", grade: "0xabc", at: "2026-11-28T15:00:30.000Z", accepted: false });
    first.live.answered({ problem: "cap-set-8", grade: "0xabc", at: "2026-11-28T15:00:30.000Z", accepted: false });
    const before = first.body().events;
    expect(before.map((e) => e.kind)).toEqual(["joined", "joined", "answer"]);
    expect(before.find((e) => e.kind === "answer")!.detail).toEqual({ beat: false });

    setAgents(w, BUSY, 6);
    clock.now += 60_000;
    const again = feed({ fetch, clock, dir: first.dir });
    expect(again.body().events).toEqual(before);
    await again.live.tick();
    expect(again.body().events).toEqual(before);
    expect(again.body().problems["busy-one"]!.now).toBe(6);
    expect(again.body().problems["cap-set-8"]!.now).toBe(1);
    again.live.answered({ problem: "cap-set-8", grade: "0xabc", at: "2026-11-28T15:00:30.000Z", accepted: false });
    expect(again.body().events).toEqual(before);
  });

  it("shows a record as solved once the board lists its claim, and a problem first seen solved without an event", async () => {
    const { world: w, fetch } = world();
    const clock = { now: NOW };
    const { live, body } = feed({ fetch, clock });
    await live.tick();
    w.board = board({ claim: { wallet: "0x269c…e042", decision: "700", at: "2026-11-28T15:02:00.000Z", windowEnds: "2026-12-05T15:02:00.000Z" } });
    clock.now += LIVE_TIMING.boardMs;
    await live.tick();
    expect(body().problems["cap-set-8"]!.solved).toBe(true);
    expect(body().events).toEqual([{ at: "2026-11-28T15:02:00.000Z", problem: "cap-set-8", kind: "solved" }]);
    expect(live.answerTo(`Work delivered outside BrainChain, sent in for a grade.\n\nTitle: x\n\n${record.request.brief}`)).toBe("cap-set-8");
    expect(live.answerTo("Convert an ISO 8601 duration")).toBeUndefined();

    const fresh = feed({ fetch, clock });
    await fresh.live.tick();
    expect(fresh.body().problems["cap-set-8"]!.solved).toBe(true);
    expect(fresh.body().events).toEqual([]);
  });

  it("reads Left to Solve's answers defensively", () => {
    expect(() => leanDetail({ steps: "many" })).toThrow();
    expect(leanDetail({ steps: [{ id: 1 }, { id: "a", reduction: "r", created_at: "nonsense", solved: "yes" }], solution: null })).toEqual({ steps: [{ id: "a", reduction: "r", solved: false }], solution: false });
    const page = activePage(ACTIVE);
    expect(page.counts.get(BUSY)).toBe(3);
    expect(page.more).toBe(false);
    expect([...page.counts.values()].reduce((a, b) => a + b, 0)).toBe(ACTIVE.items.reduce((sum, i) => sum + i.liveAgents, 0));
    expect(activePage({ items: Array(200).fill({ id: "x.y", liveAgents: 1 }) }).more).toBe(true);
    expect(activePage({ items: [{ id: "<script>", liveAgents: 5 }, { id: "a.b", liveAgents: -1 }, { id: "c.d", liveAgents: 1e9 }] }).counts.size).toBe(0);
    expect(beatKeyFrom({})).toBeUndefined();
    expect(() => beatKeyFrom({ BRAINCHAIN_BEAT_KEY: "short" })).toThrow();
    expect(beatKeyFrom({ BRAINCHAIN_BEAT_KEY: ` ${KEY} ` })).toBe(KEY);
  });
});

describe("GET /problems/live and POST /problems/beat", () => {
  const open: { close(): void }[] = [];
  afterEach(() => {
    for (const served of open.splice(0)) served.close();
  });

  async function serve(beatKey?: string) {
    const { fetch } = world();
    const clock = { now: NOW };
    const { live } = feed({ fetch, clock, ...(beatKey ? { beatKey } : { beatKey: undefined }) });
    const served = serveEvents({ log: new EventLog(mkdtempSync(join(tmpdir(), "brainchain-live-log-"))), health: () => ({ ok: true }), problems: live });
    open.push(served);
    await new Promise<void>((resolve) => served.server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(served.server.address() as AddressInfo).port}`;
    return { live, base };
  }

  const beat = (base: string, body: unknown, key?: string) =>
    fetch(`${base}/problems/beat`, { method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body) });

  it("serves the feed to any page, cached for 30 seconds, and takes beats only with the key", async () => {
    const { live, base } = await serve(KEY);
    expect((await fetch(`${base}/problems/live`)).status).toBe(503);
    await live.tick();
    const got = await fetch(`${base}/problems/live`);
    expect(got.status).toBe(200);
    expect(got.headers.get("access-control-allow-origin")).toBe("*");
    expect(got.headers.get("cache-control")).toBe("public, max-age=30");
    expect(Object.keys((await got.json()) as object)).toEqual(["readAt", "board", "working", "problems", "events", "sources"]);
    expect((await fetch(`${base}/health`).then((r) => r.json())) as object).toMatchObject({ problems: "/problems/live" });

    expect((await beat(base, { problem: "cap-set-8", agent: "a", state: "working" })).status).toBe(401);
    expect((await beat(base, { problem: "cap-set-8", agent: "a", state: "working" }, "b".repeat(64))).status).toBe(401);
    const ok = await beat(base, { problem: "cap-set-8", agent: "a", state: "working" }, KEY);
    expect(ok.status).toBe(200);
    const text = await ok.text();
    expect(text).not.toContain(KEY);
    expect(text).not.toContain('"a"');
    expect((await beat(base, { problem: "nope", agent: "a", state: "working" }, KEY)).status).toBe(404);
    expect((await fetch(`${base}/problems/beat`)).status).toBe(405);
  });

  it("serves no beat route without a key", async () => {
    const { live, base } = await serve();
    await live.tick();
    expect((await fetch(`${base}/problems/live`)).status).toBe(200);
    expect((await beat(base, { problem: "cap-set-8", agent: "a", state: "working" }, KEY)).status).toBe(404);
  });
});
