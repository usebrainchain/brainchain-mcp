import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { expandHome, type Config } from "./config.js";
import { brief, sentence } from "./payments.js";
import type { GradeRequest } from "./tools.js";

/** The free first checks, as the owner set them on 2026-11-24: per GitHub account, for accounts this old, per UTC day and in all. */
export const FREE = { perAccount: 2, minAccountDays: 30, perDay: 60, total: 250 } as const;
/** Where BrainChain's free checks are paid from: a route on the hosted watcher. */
export const FREE_URL = "https://watch.usebrainchain.com";
/** The GitHub sign-in `login` keeps, readable only by the account. Sent to BrainChain's free checks and nowhere else. */
export const LOGIN_FILE = "~/.brainchain/github.token";

const TOKEN = /^[A-Za-z0-9_]{20,255}$/;

/** Refusals that end the free path for now, after which the next grade needs a wallet. */
export const needsWallet = (reason: unknown) => ["used", "young", "daily", "total"].includes(String(reason));

export const LOGIN_COMMAND = "npx -y brainchain-mcp login";

export function readLogin(file = LOGIN_FILE): string | undefined {
  let token: string;
  try {
    token = readFileSync(expandHome(file), "utf8").trim();
  } catch {
    return undefined;
  }
  return TOKEN.test(token) ? token : undefined;
}

/** Written beside the file and renamed over it, readable only by this account. */
export function saveLogin(token: string, file = LOGIN_FILE): void {
  if (!TOKEN.test(token)) throw new Error("GitHub answered with something that is not a token, so nothing was saved. Run login again.");
  const path = expandHome(file);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(`${path}.next`, `${token}\n`, { mode: 0o600 });
  renameSync(`${path}.next`, path);
}

/**
 * Where free checks are asked for: BRAINCHAIN_FREE_URL, or BrainChain's own on mainnet. Testnet has none of its own. The
 * sign-in travels with each request, so plain http is allowed only on this machine.
 */
export function freeUrl(env: Record<string, string | undefined>, network: Config["name"]): URL | undefined {
  const given = env.BRAINCHAIN_FREE_URL?.trim();
  if (!given) return network === "mainnet" ? new URL(FREE_URL) : undefined;
  if (!URL.canParse(given)) throw new Error("BRAINCHAIN_FREE_URL must be an https URL, or http on localhost or 127.0.0.1.");
  const url = new URL(given);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error("BRAINCHAIN_FREE_URL must be an https URL, or http on localhost or 127.0.0.1.");
  return url;
}

type Prices = Pick<Config, "token" | "chain" | "terms">;

const setUp = (config: Prices) =>
  `run \`npx -y brainchain-mcp init\` in a terminal. It creates a wallet, says how much ${config.token} to send it on ${config.chain} (a grade costs ${config.terms.gradeCost}) and prints the line that adds it to this server.`;

/** What to do once the free checks are over: set up a wallet with init and add it to the server. */
export const walletNext = (config: Prices) => `To keep grading, set up a wallet: ${setUp(config)}`;

export function checksLeft(left: number, config: Prices): string {
  if (left > 0) return `${left} free ${left === 1 ? "check" : "checks"} left on this GitHub account.`;
  return `That was the last free check on this GitHub account. ${walletNext(config)}`;
}

export interface FreeOptions {
  config: Config;
  url: URL;
  login?: () => string | undefined;
  fetch?: typeof fetch;
}

/**
 * A grade paid by BrainChain's free checks, for a server with no wallet: the sign-in from `login` goes with the request, and
 * BrainChain pays the grade route the usual price. The grade and its record are the same as any other.
 */
export function freeGrader({ config, url, login = readLogin, fetch: fetchImpl = fetch }: FreeOptions): (request: GradeRequest) => Promise<unknown> {
  const next = walletNext(config);
  const name = "BrainChain's free checks";
  return async (request) => {
    const token = login();
    if (!token) {
      throw new Error(`This server has no wallet to pay for grades. To grade ${FREE.perAccount} times free, sign in with GitHub: run \`${LOGIN_COMMAND}\` in a terminal. To pay as you go, ${setUp(config)}`);
    }
    let response: Response;
    try {
      response = await fetchImpl(`${url.href.replace(/\/+$/, "")}/free/grade?network=${config.name}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(90_000),
      });
    } catch (error) {
      // A grade that went through is answered again for the same request, without using another check.
      throw new Error(`${name} did not answer (${brief(error).replace(/\.$/, "")}). Send the same grade again in a minute: if it went through, you get that grade back without using another free check.`);
    }
    const body = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    if (!body || typeof body !== "object") throw new Error(`${name} answered ${response.status} with nothing readable. Try again in a minute.`);
    if (response.status === 404 && typeof body.reason !== "string") throw new Error(`${name} are not open right now. ${next}`);
    if (!response.ok) {
      const why = typeof body.error === "string" && body.error.trim() ? sentence(body.error) : `${name} answered ${response.status}.`;
      throw new Error(needsWallet(body.reason) ? `${why} ${next}` : why);
    }
    const free = (body.free ?? {}) as { used?: number; left?: number };
    return { ...body, free: { ...free, note: checksLeft(free.left ?? 0, config) } };
  };
}
