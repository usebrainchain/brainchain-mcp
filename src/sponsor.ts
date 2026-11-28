// BrainChain's free first checks. The sponsor is an ordinary x402 payer: for a GitHub account old enough, it pays the
// grade route the usual price from BrainChain's own wallet, so the grade, its record and its decision are the same as
// any paid one. It keeps each account's id and how many checks it used, the day's and all-time counts, and each counted
// grade's id with a hash of its request; never the sign-in itself, which is read once against GitHub per request and dropped.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { privateKeyToAccount } from "viem/accounts";

import { expandHome, PRICE, REPOST_AFTER_MINUTES, resolveConfig, type Config } from "./config.js";
import { FREE } from "./free.js";
import { canonicalStringify, createDesk, firstLine, NoGrade, PaymentRefused, type Signer } from "./payments.js";
import { answer, signedIn, type Answer, type GitHubAccount } from "./signin.js";
import { gradeInput } from "./tools.js";

const DAY_MS = 86_400_000;
/** A grade the desk has no record of this long after its check was taken was never charged: no authorization lasts that long. */
const SETTLE_MS = REPOST_AFTER_MINUTES * 60_000;
/** How long the checks stay paused after the wallet refuses a payment because it is empty or over its own limits. */
export const PAUSE_MS = 10 * 60_000;

export interface Sponsor {
  /** What a client needs before it signs in: the network the checks pay on, the GitHub app to sign in with, the limits and whether they are open. */
  info(): Record<string, unknown>;
  /** The signed-in account and how many free checks it has left. Uses none. */
  me(token: string | undefined): Promise<Answer>;
  grade(token: string | undefined, body: unknown, network: string | null): Promise<Answer>;
}

export interface SponsorOptions {
  /** The network and desk the checks pay, always in USDC on Base. */
  config: Config;
  signer: Signer;
  clientId: string;
  /** Where the counts are kept. */
  dir: string;
  /** The operator's caps in place of FREE's; FREE's by default. */
  caps?: Caps;
  fetch?: typeof fetch;
  now?: () => number;
  say?: (line: string) => void;
}

/** Caps for listed UTC days, in place of FREE.perDay on those days only, and the cap in all. */
export interface Caps {
  days: Record<string, number>;
  total: number;
}

const DEFAULT_CAPS: Caps = { days: {}, total: FREE.total };

/** A listed day's cap stops mattering once the day is past, so a launch's caps need no removing. */
const dayCap = (caps: Caps, day: string) => caps.days[day] ?? FREE.perDay;

/** BRAINCHAIN_FREE_DAY_CAPS, such as `2026-11-30=200,2026-12-01=200`, and BRAINCHAIN_FREE_TOTAL; throws what is wrong with either. */
export function freeCaps(env: Record<string, string | undefined>): Caps {
  const days: Record<string, number> = {};
  for (const pair of (env.BRAINCHAIN_FREE_DAY_CAPS ?? "").split(",").map((part) => part.trim()).filter(Boolean)) {
    const [, day, cap] = /^(\d{4}-\d{2}-\d{2})=(\S+)$/.exec(pair) ?? [];
    if (!day || cap === undefined) throw new Error(`BRAINCHAIN_FREE_DAY_CAPS takes comma-separated YYYY-MM-DD=N pairs, such as 2026-11-30=200, and "${pair}" is not one.`);
    const date = new Date(`${day}T00:00:00Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== day) throw new Error(`BRAINCHAIN_FREE_DAY_CAPS names ${day}, which is not a calendar day.`);
    if (!/^[1-9]\d*$/.test(cap)) throw new Error(`BRAINCHAIN_FREE_DAY_CAPS gives ${day} a cap of ${cap}; a cap must be a whole number above zero.`);
    if (day in days) throw new Error(`BRAINCHAIN_FREE_DAY_CAPS lists ${day} twice.`);
    days[day] = Number(cap);
  }
  const total = env.BRAINCHAIN_FREE_TOTAL?.trim();
  if (total && !/^[1-9]\d*$/.test(total)) throw new Error("BRAINCHAIN_FREE_TOTAL must be a whole number above zero.");
  return { days, total: total ? Number(total) : FREE.total };
}

/** A counted grade: open until the desk has graded it, and kept after that so a repeat is answered from it. */
interface Entry {
  account: string;
  /** sha256 of the request; the request itself is not kept. */
  hash: string;
  grade?: string;
  at: number;
  graded?: true;
}

interface Counts {
  accounts: Record<string, number>;
  days: Record<string, number>;
  total: number;
  grades: Entry[];
}

const PAUSED = "BrainChain's free checks are paused. Try again later.";

/**
 * The sponsor's payment settings: USDC on Base, exactly a grade's price at a time. What caps the spending is the counts
 * file, which survives a restart, and the wallet's balance. The daily limit, kept on disk, also caps a day's spending at
 * the highest day's cap that can apply; the budget lives in memory and resets on restart, so it bounds one run only.
 */
export function sponsorConfig(network: string | undefined, dir: string, caps: Caps = DEFAULT_CAPS): Config {
  const perDay = Math.max(FREE.perDay, ...Object.values(caps.days));
  return resolveConfig({
    BRAINCHAIN_NETWORK: network,
    BRAINCHAIN_PAY_ON: "base",
    BRAINCHAIN_MAX_PRICE_UNITS: String(PRICE.grade),
    BRAINCHAIN_BUDGET_UNITS: String(PRICE.grade * BigInt(caps.total)),
    BRAINCHAIN_DAILY_UNITS: String(PRICE.grade * BigInt(perDay)),
    BRAINCHAIN_STATE_DIR: dir,
  });
}

export function createSponsor({ config, signer, clientId, dir, caps = DEFAULT_CAPS, fetch: fetchImpl = fetch, now = Date.now, say = () => {} }: SponsorOptions): Sponsor {
  const file = join(dir, "free-checks.json");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const counts: Counts = { accounts: {}, days: {}, total: 0, grades: [], ...(existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Partial<Counts>) : {}) };
  const desk = createDesk({ config, signer, approveCommand: "", fetch: fetchImpl });
  const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10);
  const today = () => dayOf(now());
  const left = (id: string) => Math.max(0, FREE.perAccount - (counts.accounts[id] ?? 0));
  let pausedUntil = 0;
  const paused = () => now() < pausedUntil;

  function save(): void {
    const day = today();
    for (const kept of Object.keys(counts.days)) if (kept < day) delete counts.days[kept];
    writeFileSync(`${file}.next`, `${JSON.stringify(counts)}\n`);
    renameSync(`${file}.next`, file);
  }

  /** What could not be written now is written with the next change; what is in memory is right either way. */
  function keep(what: string): void {
    try {
      save();
    } catch (error) {
      say(`free checks: ${what} is not on disk yet (${firstLine(error)})`);
    }
  }

  function count(id: string, day: string, by: 1 | -1): void {
    counts.accounts[id] = Math.max(0, (counts.accounts[id] ?? 0) + by);
    if (counts.accounts[id] === 0) delete counts.accounts[id];
    counts.days[day] = Math.max(0, (counts.days[day] ?? 0) + by);
    if (counts.days[day] === 0) delete counts.days[day];
    counts.total = Math.max(0, counts.total + by);
  }

  /** Counted and saved synchronously, before the payment is signed, so two requests at once cannot both take the last check. */
  function take(account: string, hash: string): Entry {
    const entry: Entry = { account, hash, at: now() };
    count(account, dayOf(entry.at), 1);
    counts.grades.push(entry);
    try {
      save();
    } catch (error) {
      count(account, dayOf(entry.at), -1);
      counts.grades.pop();
      throw error;
    }
    return entry;
  }

  /** For a grade that was never charged. A second call for the same entry does nothing. */
  function give(entry: Entry): void {
    const at = counts.grades.indexOf(entry);
    if (at === -1) return;
    counts.grades.splice(at, 1);
    count(entry.account, dayOf(entry.at), -1);
    keep("a check given back");
  }

  function record(entry: Entry, grade: unknown, graded: boolean): void {
    if (typeof grade !== "string" || !counts.grades.includes(entry)) return;
    entry.grade = grade;
    if (graded) entry.graded = true;
    keep(`grade ${grade}`);
  }

  /**
   * Settles an account's open grades with the desk before its checks are counted. A graded one closes; one the desk
   * failed, or still has no record of SETTLE_MS after its check was taken, gives the check back, and the desk frees the
   * wallet's hold on it as it reads it. Returns what the desk said, by grade id.
   */
  async function reconcile(account: string): Promise<Map<string, unknown>> {
    const read = new Map<string, unknown>();
    for (const entry of counts.grades.filter((kept) => kept.account === account && !kept.graded)) {
      const late = now() - entry.at >= SETTLE_MS;
      // No grade id: the watcher stopped between taking the check and signing, or is signing now.
      if (!entry.grade) {
        if (late) give(entry);
        continue;
      }
      let view: Record<string, unknown>;
      try {
        view = (await desk.getGrade(entry.grade)) as Record<string, unknown>;
      } catch (error) {
        if (error instanceof NoGrade && late) give(entry);
        continue;
      }
      read.set(entry.grade, view);
      if (view.state === "failed") give(entry);
      else if (view.state === "graded") record(entry, entry.grade, true);
    }
    return read;
  }

  /** What `account` has used and has left, and whether the reply is a grade another account's request made. */
  const tally = (account: string, alreadyGraded: boolean) => ({ used: FREE.perAccount - left(account), left: left(account), ...(alreadyGraded ? { alreadyGraded: true } : {}) });

  /** A request sent before, by this account or another, answered from its entry without signing again. */
  async function repeat(entry: Entry, read: Map<string, unknown>, account: string): Promise<Answer> {
    if (!entry.grade) return answer(409, "pending", "This grade is already being paid for. Send it again in a few minutes to read it; that does not use another free check.");
    const view = read.get(entry.grade) ?? (await desk.getGrade(entry.grade).catch(() => undefined));
    const known = view && typeof view === "object" ? view : { error: "The desk has no record of this grade yet.", done: false, next: "Read it with brainchain_get_grade in a minute.", retryAfterSeconds: 60 };
    return { status: 200, body: { ...known, grade: entry.grade, statusUrl: `${config.desk}/x402/grades/${entry.grade}`, duplicate: true, free: tally(account, entry.account !== account) } };
  }

  const account = (token: string | undefined) => signedIn(token, { clientId, fetch: fetchImpl, untouched: "no free check was used", label: "free checks", say });


  /** Why this account can take no free check now, or nothing when it can. */
  function refusal({ id, login, createdAt }: GitHubAccount): Answer | undefined {
    if (now() - createdAt < FREE.minAccountDays * DAY_MS) {
      return answer(403, "young", `Free checks are for GitHub accounts older than ${FREE.minAccountDays} days. @${login} was created on ${dayOf(createdAt)}, so it qualifies on ${dayOf(createdAt + FREE.minAccountDays * DAY_MS)}.`);
    }
    if (left(id) === 0) return answer(403, "used", `@${login} has used its ${FREE.perAccount} free checks.`);
    if (counts.total >= caps.total) return answer(403, "total", "All of BrainChain's free checks have been given out.");
    if (paused()) return answer(503, "paused", PAUSED);
    const perDay = dayCap(caps, today());
    if ((counts.days[today()] ?? 0) >= perDay) return answer(429, "daily", `Today's ${perDay} free checks are all taken. More open at 00:00 UTC.`);
    return undefined;
  }

  return {
    info: () => ({ network: config.name, chain: config.chain, clientId, ...FREE, perDay: dayCap(caps, today()), total: caps.total, open: counts.total < caps.total && !paused(), paused: paused() }),

    async me(token) {
      const user = await account(token);
      if ("status" in user) return user;
      await reconcile(user.id);
      const refused = refusal(user);
      return { status: 200, body: { login: user.login, left: refused?.body.reason === "young" ? 0 : left(user.id), ...(refused ? refused.body : {}) } };
    },

    async grade(token, body, network) {
      if (network !== null && network !== config.name) {
        return answer(409, "network", `These free checks pay for grades on BrainChain ${config.name}, and this server is set to ${network}. To use them, set BRAINCHAIN_NETWORK=${config.name} in this server's environment.`);
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) return answer(400, "request", "Send the grade as a JSON object: brief, result, and optionally title, levels and pass.");
      let request;
      try {
        request = gradeInput(body as Record<string, unknown>);
      } catch (error) {
        return answer(400, "request", firstLine(error));
      }
      const user = await account(token);
      if ("status" in user) return user;
      const read = await reconcile(user.id);
      const hash = createHash("sha256").update(canonicalStringify(request)).digest("hex");
      const earlier = counts.grades.find((entry) => entry.account === user.id && entry.hash === hash);
      if (earlier) return repeat(earlier, read, user.id);
      // The desk answers the same work from this wallet with its earlier grade and charges nothing, so another account's
      // grade of it is answered from that grade before any limit is looked at, unless the desk failed it.
      const other = counts.grades.find((entry) => entry.hash === hash && entry.grade !== undefined);
      if (other) {
        const theirs = await repeat(other, read, user.id);
        if (theirs.body.state !== "failed") return theirs;
      }
      const refused = refusal(user);
      if (refused) return refused;

      let entry: Entry;
      try {
        entry = take(user.id, hash);
      } catch (error) {
        say(`free checks: the counts could not be written (${firstLine(error)})`);
        return answer(503, "unavailable", "The free check could not be started just now, and none was used. Try again in a few minutes.");
      }
      let reply: Record<string, unknown>;
      try {
        reply = (await desk.grade(request)) as Record<string, unknown>;
      } catch (error) {
        // The desk throws only for a payment it never took.
        give(entry);
        // Said in the log, not to the user: it names the sponsor's limits and wallet.
        say(`free checks: a grade was not paid (${firstLine(error)})`);
        if (!(error instanceof PaymentRefused)) return answer(503, "unavailable", "The free check could not be paid just now, and none was used. Try again in a few minutes.");
        pausedUntil = now() + PAUSE_MS;
        return answer(503, "paused", PAUSED);
      }
      // A repeat the desk answered from an earlier grade, and a payment that did not go through, cost nothing.
      if (reply.duplicate === true || reply.state === "failed") give(entry);
      else record(entry, reply.grade, reply.state === "graded");
      say(`free checks: grade ${String(reply.grade)} ${reply.possiblyCharged ? `possibly charged (${firstLine(reply.error)})` : String(reply.state)}${reply.duplicate ? ", a repeat" : ""}`);
      return { status: 200, body: { ...reply, free: tally(user.id, reply.duplicate === true) } };
    },
  };
}

/**
 * The sponsor a watcher runs, from BRAINCHAIN_SPONSOR_KEY_FILE (the paying wallet's key) and GITHUB_CLIENT_ID (the GitHub
 * OAuth app's client id; device flow needs no secret), with BRAINCHAIN_FREE_DAY_CAPS and BRAINCHAIN_FREE_TOTAL in place of
 * FREE's caps. Returns undefined when neither of the first two is set; throws when only one is set or any is unusable.
 */
export function sponsorFrom(env: Record<string, string | undefined>, dir: string, options: Pick<SponsorOptions, "fetch" | "now" | "say"> = {}): Sponsor | undefined {
  const file = env.BRAINCHAIN_SPONSOR_KEY_FILE?.trim();
  const clientId = env.GITHUB_CLIENT_ID?.trim();
  if (!file && !clientId) return undefined;
  if (!file || !clientId) throw new Error("Free checks need BRAINCHAIN_SPONSOR_KEY_FILE, the paying wallet's key, and GITHUB_CLIENT_ID, the GitHub OAuth app's client id. Set both, or neither.");
  if (!/^[\w.-]{8,64}$/.test(clientId)) throw new Error("GITHUB_CLIENT_ID is not a GitHub client id.");
  let key: string;
  try {
    key = readFileSync(expandHome(file), "utf8").trim().replace(/^0x/i, "");
  } catch (error) {
    throw new Error(`BRAINCHAIN_SPONSOR_KEY_FILE could not be read (${(error as NodeJS.ErrnoException).code ?? firstLine(error)}).`);
  }
  if (!/^[0-9a-f]{64}$/i.test(key)) throw new Error("BRAINCHAIN_SPONSOR_KEY_FILE must hold only a private key, 64 hex characters with or without 0x.");
  const signer = privateKeyToAccount(`0x${key}`);
  const caps = freeCaps(env);
  const config = sponsorConfig(env.BRAINCHAIN_NETWORK?.trim() || undefined, dir, caps);
  const today = new Date((options.now ?? Date.now)()).toISOString().slice(0, 10);
  const listed = Object.entries(caps.days).filter(([day]) => day >= today).sort(([a], [b]) => a.localeCompare(b)).map(([day, cap]) => `${cap} on ${day}`);
  options.say?.(
    `Free checks are on: grades on BrainChain ${config.name}, paid in ${config.token} on ${config.chain} from ${signer.address}, at most ${FREE.perDay} a day${listed.length ? ` (${listed.join(", ")})` : ""} and ${caps.total} in all.`,
  );
  return createSponsor({ config, signer, clientId, dir, caps, ...options });
}
