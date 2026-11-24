// BrainChain's free first checks. The sponsor is an ordinary x402 payer: for a GitHub account old enough, it pays the
// grade route the usual price from BrainChain's own wallet, so the grade, its record and its decision are the same as
// any paid one. It keeps each account's id and how many checks it used, and the day's and all-time counts; never the
// sign-in itself, which is read once against GitHub per request and dropped.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { privateKeyToAccount } from "viem/accounts";

import { expandHome, PRICE, resolveConfig, type Config } from "./config.js";
import { FREE, LOGIN_COMMAND } from "./free.js";
import { createDesk, firstLine, type Signer } from "./payments.js";
import { gradeInput } from "./tools.js";

const GITHUB_API = "https://api.github.com";
const DAY_MS = 86_400_000;

export interface Answer {
  status: number;
  body: Record<string, unknown>;
}

export interface Sponsor {
  /** What a client needs before it signs in: the network the checks pay on and the GitHub app to sign in with. */
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
  fetch?: typeof fetch;
  now?: () => number;
  say?: (line: string) => void;
}

interface Counts {
  accounts: Record<string, number>;
  days: Record<string, number>;
  total: number;
}

interface Account {
  id: string;
  login: string;
  createdAt: number;
}

const answer = (status: number, reason: string, error: string): Answer => ({ status, body: { reason, error } });

/**
 * The sponsor's payment settings: USDC on Base, exactly a grade's price at a time, and its own budget and daily limit set
 * to the checks it may give, so a fault in the counts below still cannot spend more.
 */
export function sponsorConfig(network: string | undefined, dir: string): Config {
  return resolveConfig({
    BRAINCHAIN_NETWORK: network,
    BRAINCHAIN_PAY_ON: "base",
    BRAINCHAIN_MAX_PRICE_UNITS: String(PRICE.grade),
    BRAINCHAIN_BUDGET_UNITS: String(PRICE.grade * BigInt(FREE.total)),
    BRAINCHAIN_DAILY_UNITS: String(PRICE.grade * BigInt(FREE.perDay)),
    BRAINCHAIN_STATE_DIR: dir,
  });
}

export function createSponsor({ config, signer, clientId, dir, fetch: fetchImpl = fetch, now = Date.now, say = () => {} }: SponsorOptions): Sponsor {
  const file = join(dir, "free-checks.json");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const counts: Counts = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Counts) : { accounts: {}, days: {}, total: 0 };
  const desk = createDesk({ config, signer, approveCommand: "", fetch: fetchImpl });
  const today = () => new Date(now()).toISOString().slice(0, 10);
  const left = (id: string) => Math.max(0, FREE.perAccount - (counts.accounts[id] ?? 0));

  function save(): void {
    const day = today();
    for (const kept of Object.keys(counts.days)) if (kept < day) delete counts.days[kept];
    writeFileSync(`${file}.next`, `${JSON.stringify(counts)}\n`);
    renameSync(`${file}.next`, file);
  }

  function count(id: string, day: string, by: 1 | -1): void {
    counts.accounts[id] = Math.max(0, (counts.accounts[id] ?? 0) + by);
    if (counts.accounts[id] === 0) delete counts.accounts[id];
    counts.days[day] = Math.max(0, (counts.days[day] ?? 0) + by);
    if (counts.days[day] === 0) delete counts.days[day];
    counts.total = Math.max(0, counts.total + by);
  }

  /** Counted and written before the payment is signed, and in one turn, so two requests at once cannot both take the last check. */
  function take(id: string, day: string): void {
    count(id, day, 1);
    try {
      save();
    } catch (error) {
      count(id, day, -1);
      throw error;
    }
  }

  /** A check given back stays in memory if the file cannot take it, and is written with the next change. */
  function give(id: string, day: string): void {
    count(id, day, -1);
    try {
      save();
    } catch (error) {
      say(`free checks: a check given back is not on disk yet (${firstLine(error)})`);
    }
  }

  async function account(token: string | undefined): Promise<Account | Answer> {
    if (!token) return answer(401, "login", `Sign in with GitHub first: run \`${LOGIN_COMMAND}\` in a terminal.`);
    let response: Response;
    try {
      response = await fetchImpl(`${GITHUB_API}/user`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "brainchain-free-checks" },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      say(`free checks: GitHub did not answer (${firstLine(error)})`);
      return answer(503, "unavailable", "GitHub could not be reached to check your sign-in, and no free check was used. Try again in a minute.");
    }
    if (response.status === 401) return answer(401, "login", `Your GitHub sign-in has expired or was revoked. Run \`${LOGIN_COMMAND}\` again.`);
    const user = response.ok ? ((await response.json().catch(() => undefined)) as Record<string, unknown> | undefined) : undefined;
    const createdAt = Date.parse(String(user?.created_at));
    if (!user || typeof user.id !== "number" || typeof user.login !== "string" || Number.isNaN(createdAt)) {
      say(`free checks: GitHub answered ${response.status}`);
      return answer(503, "unavailable", "GitHub did not confirm your sign-in just now, and no free check was used. Try again in a minute.");
    }
    return { id: String(user.id), login: user.login, createdAt };
  }

  /** Why this account can take no free check now, or nothing when it can. */
  function refusal({ id, login, createdAt }: Account): Answer | undefined {
    if (now() - createdAt < FREE.minAccountDays * DAY_MS) {
      return answer(403, "young", `Free checks are for GitHub accounts older than ${FREE.minAccountDays} days, and @${login} was created on ${new Date(createdAt).toISOString().slice(0, 10)}.`);
    }
    if (left(id) === 0) return answer(403, "used", `@${login} has used its ${FREE.perAccount} free checks.`);
    if (counts.total >= FREE.total) return answer(403, "total", "All of BrainChain's free checks have been given out.");
    if ((counts.days[today()] ?? 0) >= FREE.perDay) return answer(429, "daily", "Today's free checks are all taken. More open at 00:00 UTC.");
    return undefined;
  }

  return {
    info: () => ({ network: config.name, chain: config.chain, clientId, ...FREE, open: counts.total < FREE.total }),

    async me(token) {
      const user = await account(token);
      if ("status" in user) return user;
      const refused = refusal(user);
      return { status: 200, body: { login: user.login, left: refused?.body.reason === "young" ? 0 : left(user.id), ...(refused ? refused.body : {}) } };
    },

    async grade(token, body, network) {
      if (network !== null && network !== config.name) {
        return answer(409, "network", `These free checks pay for grades on BrainChain ${config.name}, and this server is set to ${network}.`);
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
      const refused = refusal(user);
      if (refused) return refused;

      const day = today();
      try {
        take(user.id, day);
      } catch (error) {
        say(`free checks: the counts could not be written (${firstLine(error)})`);
        return answer(503, "unavailable", "The free check could not be started just now, and none was used. Try again in a few minutes.");
      }
      let reply: Record<string, unknown>;
      try {
        reply = (await desk.grade(request)) as Record<string, unknown>;
      } catch (error) {
        give(user.id, day);
        // Said in the log, not to the user: it names the sponsor's limits and wallet.
        say(`free checks: a grade was not paid (${firstLine(error)})`);
        return answer(503, "unavailable", "The free check could not be paid just now, and none was used. Try again in a few minutes.");
      }
      // A repeat answered from the first grade, and a payment that did not go through, cost nothing.
      if (reply.duplicate === true || reply.state === "failed") give(user.id, day);
      say(`free checks: grade ${String(reply.grade)} ${reply.possiblyCharged ? `possibly charged (${firstLine(reply.error)})` : String(reply.state)}${reply.duplicate ? ", a repeat" : ""}`);
      return { status: 200, body: { ...reply, free: { used: FREE.perAccount - left(user.id), left: left(user.id) } } };
    },
  };
}

/**
 * The sponsor a watcher runs, from BRAINCHAIN_SPONSOR_KEY_FILE (the paying wallet's key) and GITHUB_CLIENT_ID (the GitHub
 * OAuth app's client id; device flow needs no secret). Neither set is no sponsor. Throws what is wrong with either.
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
  const config = sponsorConfig(env.BRAINCHAIN_NETWORK?.trim() || undefined, dir);
  options.say?.(`Free checks are on: grades on BrainChain ${config.name}, paid in ${config.token} on ${config.chain} from ${signer.address}, at most ${FREE.perDay} a day and ${FREE.total} in all.`);
  return createSponsor({ config, signer, clientId, dir, ...options });
}
