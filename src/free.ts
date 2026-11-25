import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { expandHome, KEY_FILE, type Config } from "./config.js";
import { sentence } from "./payments.js";
import type { GradeRequest } from "./tools.js";

/** Free checks per GitHub account, the minimum account age in days, and the caps per UTC day and in total. */
export const FREE = { perAccount: 2, minAccountDays: 30, perDay: 60, total: 250 } as const;
/** Where BrainChain's free checks are paid from: a route on the hosted watcher. */
export const FREE_URL = "https://watch.usebrainchain.com";
/** The GitHub sign-in `login` keeps, readable only by the account. Sent to BrainChain's free checks and nowhere else. */
export const LOGIN_FILE = "~/.brainchain/github.token";

const TOKEN = /^[A-Za-z0-9_]{20,255}$/;

/** A GitHub sign-in and the free-check service it was made for; only that service's GitHub app accepts the token. */
export interface Login {
  token: string;
  /** The free checks' address, as freeUrl reads it. */
  url: string;
  network: Config["name"];
}

/** Refusals that end the free path for now, after which the next grade needs a wallet. */
export const needsWallet = (reason: unknown) => ["used", "young", "daily", "total", "paused"].includes(String(reason));

export const LOGIN_COMMAND = "npx -y brainchain-mcp login";

export function readLogin(file = LOGIN_FILE): Login | undefined {
  let kept: Partial<Login> | null;
  try {
    kept = JSON.parse(readFileSync(expandHome(file), "utf8")) as Partial<Login> | null;
  } catch {
    return undefined;
  }
  const { token, url, network } = kept ?? {};
  if (typeof token !== "string" || !TOKEN.test(token) || typeof url !== "string" || !URL.canParse(url) || (network !== "mainnet" && network !== "testnet")) return undefined;
  return { token, url, network };
}

/** Written beside the file and renamed over it, readable only by this account. */
export function saveLogin(login: Login, file = LOGIN_FILE): void {
  if (!TOKEN.test(login.token)) throw new Error("GitHub answered with something that is not a token, so nothing was saved. Run login again.");
  const path = expandHome(file);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(`${path}.next`, `${JSON.stringify({ token: login.token, url: login.url, network: login.network })}\n`, { mode: 0o600 });
  renameSync(`${path}.next`, path);
}

/**
 * Where free checks are asked for: BRAINCHAIN_FREE_URL, or BrainChain's own on mainnet. Testnet has none of its own. The
 * sign-in travels with each request, so plain http is allowed only on this machine.
 */
export function freeUrl(env: Record<string, string | undefined>, network: Config["name"]): URL | undefined {
  const given = env.BRAINCHAIN_FREE_URL?.trim();
  if (!given) return network === "mainnet" ? new URL(FREE_URL) : undefined;
  const url = URL.canParse(given) ? new URL(given) : undefined;
  const local = url !== undefined && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!url || (url.protocol !== "https:" && !(url.protocol === "http:" && local))) throw new Error("BRAINCHAIN_FREE_URL must be an https URL, or http on localhost or 127.0.0.1.");
  return url;
}

const own = (url: string, network: string) => network === "mainnet" && url === new URL(FREE_URL).href;

/** The BRAINCHAIN_FREE_URL setting for printed commands; empty when the URL is the network's default. */
export function freeSetting(url: URL, network: Config["name"]): Record<string, string> {
  return own(url.href, network) ? {} : { BRAINCHAIN_FREE_URL: url.href.replace(/\/+$/, "") };
}

const named = (url: string, network: string) => (own(url, network) ? "BrainChain's free checks on mainnet" : `the free checks at ${url.replace(/\/+$/, "")} on ${network}`);

type Prices = Pick<Config, "token" | "chain" | "terms">;

/** The commands a reply quotes, with the settings this server runs with. */
export interface Commands {
  init: string;
  login: string;
}

/**
 * A wallet already there to pay from: the key file init saved, or a key setting in the shell `login` runs in. A server
 * with no key setting never pays from the saved file on its own, so it is named, not made again.
 */
export interface Wallet {
  saved?: boolean;
  setting?: string;
}

export const walletSaved = () => existsSync(expandHome(KEY_FILE));

/** After `lead`, the step to a wallet this server can pay from; `step` leads the way to set one up when there is none. */
function toWallet(config: Prices, init: string, lead: string, wallet: Wallet, step: string): string {
  if (wallet.setting) return `This shell sets ${wallet.setting}. ${lead}, add the server again with ${wallet.setting} in its settings, and it pays from that wallet.`;
  if (wallet.saved) return `A wallet is already set up at ${KEY_FILE}. ${lead}, add the server again with the line \`${init}\` prints, which sets BRAINCHAIN_PAYER_KEY_FILE.`;
  return `${lead}, ${step}run \`${init}\` in a terminal. It creates a wallet, says how much ${config.token} to send it on ${config.chain} (a grade costs ${config.terms.gradeCost}) and prints the line that adds it to this server.`;
}

/** Paying as you go, for a server with no wallet that cannot grade free. */
const payAsYouGo = (config: Prices, init: string, wallet: Wallet) => toWallet(config, init, "To pay as you go", wallet, "");

/** Setting up a wallet: the way to keep grading after the last free check, and to grade at all for an account the checks turned away. */
export function walletNext(config: Prices, init: string, reason: unknown, wallet: Wallet = {}): string {
  const lead = reason === "used" ? "To keep grading" : reason === "young" ? "To grade today" : "To grade now";
  return toWallet(config, init, lead, wallet, "set up a wallet: ");
}

/** `repeat` is "yours" for a request this account sent before, "earlier" for one another account's request graded. */
export function checksLeft(left: number, config: Prices, init: string, repeat?: "yours" | "earlier", wallet: Wallet = {}): string {
  const count = left > 0 ? `${left} free ${left === 1 ? "check" : "checks"} left on this GitHub account.` : `No free checks are left on this GitHub account. ${walletNext(config, init, "used", wallet)}`;
  if (repeat === "yours") return `You sent this grade before, so this is the same grade again and no free check was used. ${count}`;
  if (repeat === "earlier") return `This exact work was already graded; here is that grade. No free check was used. ${count}`;
  return left > 0 ? count : `That was the last free check on this GitHub account. ${walletNext(config, init, "used", wallet)}`;
}

/** What to change when the kept sign-in was made for a different free-check service than this server uses. */
export function signedInElsewhere(login: Login, config: Prices & Pick<Config, "name">, url: URL | undefined, init: string, wallet: Wallet = {}): string {
  const here = url ? `this server uses ${named(url.href, config.name)}` : `this server uses none: BRAINCHAIN_FREE_URL is not set, and ${config.name} has no free checks of its own`;
  return (
    `This server has no wallet, and the GitHub sign-in on this machine is for ${named(login.url, login.network)}, but ${here}. ` +
    `To use your free checks, add the server again with the line \`login\` printed, or run \`login\` with this server's BRAINCHAIN_NETWORK and BRAINCHAIN_FREE_URL. ${payAsYouGo(config, init, wallet)}`
  );
}

export interface FreeOptions {
  config: Config;
  url: URL;
  commands: Commands;
  login?: () => Login | undefined;
  fetch?: typeof fetch;
  /** Told each grade id the free checks answer with, so reading it back knows this server sent it. */
  track?: (grade: string) => void;
  /** Whether init's key file exists; this server pays from it only once its settings name it. */
  walletSaved?: () => boolean;
}

/**
 * A grade paid by BrainChain's free checks, for a server with no wallet: the sign-in from `login` goes with the request, and
 * BrainChain pays the grade route the usual price. The grade and its record are the same as any other.
 */
export function freeGrader({ config, url, commands, login = readLogin, fetch: fetchImpl = fetch, track, walletSaved: saved = walletSaved }: FreeOptions): (request: GradeRequest) => Promise<unknown> {
  const name = "BrainChain's free-check service";
  return async (request) => {
    const wallet = { saved: saved() };
    const kept = login();
    if (!kept) {
      throw new Error(`This server has no wallet to pay for grades. For ${FREE.perAccount} free checks, sign in with GitHub: run \`${commands.login}\` in a terminal. ${payAsYouGo(config, commands.init, wallet)}`);
    }
    if (kept.url !== url.href || kept.network !== config.name) throw new Error(signedInElsewhere(kept, config, url, commands.init, wallet));
    let response: Response;
    try {
      response = await fetchImpl(`${url.href.replace(/\/+$/, "")}/free/grade?network=${config.name}`, {
        method: "POST",
        headers: { authorization: `Bearer ${kept.token}`, "content-type": "application/json" },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(90_000),
      });
    } catch {
      throw new Error(`${name} could not be reached. Send the same grade again in a few minutes: if it went through, you get that grade back without using another free check. If it keeps failing, check your internet connection.`);
    }
    const body = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    if (!body || typeof body !== "object") throw new Error(`${name} answered ${response.status} with nothing readable. Try again in a minute.`);
    if (response.status === 404 && typeof body.reason !== "string") throw new Error(`BrainChain's free checks are not open right now. ${walletNext(config, commands.init, "closed", wallet)}`);
    if (!response.ok) {
      const why = typeof body.error === "string" && body.error.trim() ? sentence(body.error) : `${name} answered ${response.status}.`;
      throw new Error(needsWallet(body.reason) ? `${why} ${walletNext(config, commands.init, body.reason, wallet)}` : why);
    }
    if (typeof body.grade === "string") track?.(body.grade);
    const free = (body.free ?? {}) as { used?: number; left?: number; alreadyGraded?: boolean };
    const repeat = free.alreadyGraded === true ? "earlier" : body.duplicate === true ? "yours" : undefined;
    return { ...body, free: { ...free, note: checksLeft(free.left ?? 0, config, commands.init, repeat, wallet) } };
  };
}
