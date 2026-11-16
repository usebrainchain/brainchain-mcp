import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { getAddress, type Address } from "viem";

export const CUSTODY_NAME = "brainchain_custody_additions";

/** BitGo's public code: each token it supports is one entry in a list per chain. */
const REPO = "BitGo/BitGoJS";
/** The lists that hold Robinhood Chain tokens: the one BitGo's engineers edit and the one its asset service generates. */
export const TOKEN_LISTS = ["modules/statics/src/coins/hoodethTokens.ts", "modules/statics/src/coins/botTokens.ts"] as const;
export const DEFAULT_DAYS = 30;
export const MAX_DAYS = 90;
/** GitHub's page size for a branch's changes, and how many pages one answer may take before it is given up. */
export const PAGE = 100;
export const MAX_PAGES = 12;
/** GitHub allows 60 unauthenticated API requests an hour from one IP address, so the newest page of changes is kept this long. */
export const KEEP_MS = 10 * 60_000;
/** How many reads the reader keeps before it clears them. An answer takes about a dozen for each merge that added a token. */
export const MAX_KEPT = 400;
/** How long a host that refused a request is not asked again when it sends no reset time. */
export const REFUSED_MS = 60_000;
const REQUEST_MS = 15_000;
const ANSWER_MS = 45_000;
const PARALLEL = 6;
const DAY_MS = 86_400_000;

export const CUSTODY_TOOL: Tool = {
  name: CUSTODY_NAME,
  title: "Robinhood Chain tokens BitGo has recently started to support",
  description:
    "The Robinhood Chain tokens BitGo has recently started to support, read from BitGo's public code on GitHub. " +
    "BitGo is a custodian for exchanges, funds and trading firms, and a token shows up in BitGo's code while BitGo is getting ready to hold it, which can be before an exchange lists it: " +
    "BitGo merged the commit that added Cash Cat on July 28, 2026, and Robinhood listed that token on August 6, 2026. " +
    "That makes an entry worth a closer look, not a prediction: it does not say which client asked BitGo to support the token or why, and it does not mean an exchange will list it. " +
    "Looks back 30 days, or `days` from 1 to 90. `additions` has one entry, newest first, for each merge in that period that added a token, and leaves out a token BitGo has since removed. " +
    "Each entry gives `addedAt`, when the merge landed; `commit`, a link to its commit; and `tokens`, each with its `name`, `contract` address, `decimals` and `id`, BitGo's id for it, such as hoodeth:cashcat. " +
    "`additions` is empty if nothing was added. `readAt` is when the merges were read from GitHub and `since` is where the period starts. " +
    "Most of the tokens BitGo has added are stock tokens issued by Robinhood itself, which say nothing about a listing on an exchange, and some are added before their contract is deployed. " +
    "Nearly all of those have \"Robinhood\" in their `name`, but `name` is BitGo's label and not the token's name on chain, so a `name` without \"Robinhood\" does not prove a token comes from someone else: " +
    "look up the `contract` on a block explorer before treating a token as one Robinhood did not issue. " +
    "Free, no key and no payment. GitHub allows 60 unauthenticated API requests an hour from one IP address: 30 days usually takes two requests and 90 days about six, and when they are used up the tool says when to try again. " +
    "While the server runs, what it read from GitHub is kept for ten minutes: the same call again in that time makes no request and shows the same `readAt`. Not advice.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: {
    type: "object",
    properties: { days: { type: "integer", minimum: 1, maximum: MAX_DAYS, description: `Optional: how many days back to look, from 1 to ${MAX_DAYS}. Without it the tool looks back ${DEFAULT_DAYS} days.` } },
    additionalProperties: false,
  },
};

/** What a list says of one token. An entry whose details are in a form not read here keeps its id and has nothing else. */
export interface ListedToken {
  name?: string;
  contract?: Address;
  decimals?: number;
}

/** One list file: its Robinhood Chain tokens by the part of BitGo's id after `hoodeth:`, and every such id the file mentions anywhere. */
export interface TokenList {
  tokens: Map<string, ListedToken>;
  mentioned: Set<string>;
}

export interface CustodyToken extends ListedToken {
  /** BitGo's id for the token, such as hoodeth:cashcat. */
  id: string;
}

/** One change to BitGo's master branch and the tokens it added. `commit` links the commit the branch pointed to after it. */
export interface CustodyAddition {
  addedAt: string;
  commit: string;
  tokens: CustodyToken[];
}

export interface CustodyBoard {
  chain: "Robinhood Chain";
  source: string;
  readAt: string;
  since: string;
  additions: CustodyAddition[];
}

/** One change to BitGo's master branch, a merge or a push: when it happened, in milliseconds, and the commits the branch pointed to before and after. */
export interface BranchChange {
  at: number;
  before: string;
  after: string;
}

export interface BitGoReader {
  /** Up to `PAGE` changes to master, newest first, with when GitHub was read and the next page's address. With no argument, the newest page. */
  changes(page?: string): Promise<{ changes: BranchChange[]; readAt: number; next?: string }>;
  /** A list as it stood at a commit; undefined where there was none to read. */
  list(file: string, commit: string): Promise<TokenList | undefined>;
}

/** A failure whose message is already written for the person asking, so it goes out as it is. */
export class CustodyError extends Error {}

export const MOVED =
  "BitGo has moved or reformatted its token lists, so this version of brainchain-mcp cannot read them. Update brainchain-mcp to the latest version. " +
  "If this is the latest, report it at https://github.com/usebrainchain/brainchain-mcp/issues.";

/** A string literal, which is kept, or a comment, which is dropped: an entry BitGo has commented out is not one it supports. */
const COMMENTS = /('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\[\s\S])*`)|\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/g;
/** An entry of any list: a call whose first two arguments are BitGo's own id for the asset and its public id. */
const ANY_ENTRY = /\(\s*'[0-9a-f-]{36}',\s*'[\w.$-]+:/;
/** A Robinhood Chain mainnet entry. The testnet's ids start with thoodeth and BitGo's off-chain mirrors with ofchoodeth. An id is printable ASCII, so it goes out as it is. */
const ENTRY = /\(\s*'[0-9a-f-]{36}',\s*'hoodeth:([!-&(-[\]-~]{1,60})'/g;
/** Every mention of a Robinhood Chain mainnet id, wherever it stands. */
const MENTION = /'hoodeth:([^']*)'/g;
/** What follows the id in an ERC-20 entry: the name, the decimals and the contract. */
const DETAILS = /\s*,\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)")\s*,\s*(\d{1,2})\s*,\s*'(0x[0-9a-fA-F]{40})'/y;

/** Text from BitGo's code as one short line. An agent reads it as data, so nothing in it may pass for layout, and it is cut between characters. */
const line = (text: string, max: number) => [...text.replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\s]+/gu, " ").trim()].slice(0, max).join("").trim();

/** A string literal's text as JavaScript reads it, as far as a name needs: a quote, a backslash, a character by its code. */
const unescaped = (literal: string) =>
  literal.replace(/\\(?:u\{([0-9a-fA-F]{1,6})\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|([\s\S]))/g, (_, point?: string, u?: string, x?: string, other?: string) => {
    if (other !== undefined) return /[nrtvfb0]/.test(other) ? " " : other;
    const code = parseInt((point ?? u ?? x)!, 16);
    return code > 0x10ffff ? " " : String.fromCodePoint(code);
  });

/** One of BitGo's lists, read for its Robinhood Chain tokens. Undefined for a file with no entry of any chain in the form read here, which is how a list rewritten in another form looks. */
export function tokenList(text: string): TokenList | undefined {
  const source = text.replace(COMMENTS, (_, literal?: string) => literal ?? " ");
  if (!ANY_ENTRY.test(source)) return undefined;
  const tokens = new Map<string, ListedToken>();
  for (const entry of source.matchAll(ENTRY)) {
    DETAILS.lastIndex = entry.index + entry[0].length;
    const details = DETAILS.exec(source);
    if (!details) {
      tokens.set(entry[1]!, {});
      continue;
    }
    const name = line(unescaped(details[1] ?? details[2] ?? ""), 80);
    tokens.set(entry[1]!, { ...(name ? { name } : {}), contract: getAddress(details[4]!), decimals: Number(details[3]) });
  }
  return { tokens, mentioned: new Set([...source.matchAll(MENTION)].map((mention) => mention[1]!)) };
}

/** The changes to master since `since`, newest first, the commit master points to now, and when GitHub was read for it. */
async function changesSince(reader: BitGoReader, since: number): Promise<{ head: string; readAt: number; recent: BranchChange[] }> {
  const recent: BranchChange[] = [];
  let newest: { head: string; readAt: number } | undefined;
  let page: string | undefined;
  for (let pages = 1; pages <= MAX_PAGES; pages++) {
    const { changes, readAt, next } = await reader.changes(page);
    if (!newest && !changes[0]) throw new CustodyError(MOVED);
    newest ??= { head: changes[0]!.after, readAt };
    recent.push(...changes.filter((change) => change.at >= since));
    if (!next || changes.some((change) => change.at < since)) return { ...newest, recent };
    page = next;
  }
  throw new CustodyError(`BitGo merged into its master branch more than ${(MAX_PAGES * PAGE).toLocaleString("en-US")} times in that period, more than this tool reads. Try again with a smaller \`days\`.`);
}

/**
 * Both lists as they stood at a commit, as one. Throws `MOVED` where a list is missing or mentions a Robinhood Chain id that
 * neither list holds as an entry: a missing list would make every token look new at the next commit, and an id read only as a
 * mention would drop its token and report nothing added. Both lists are older than `MAX_DAYS` days.
 */
async function tokensAt(reader: BitGoReader, commit: string): Promise<Map<string, ListedToken>> {
  const lists = await Promise.all(TOKEN_LISTS.map((file) => reader.list(file, commit)));
  const tokens = new Map(lists.flatMap((list) => [...(list?.tokens ?? [])]));
  if (lists.some((list) => !list || [...list.mentioned].some((id) => !tokens.has(id)))) throw new CustodyError(MOVED);
  return tokens;
}

/**
 * The tokens on BitGo's lists now that were on neither list `days` days ago, each under a change to master that added it.
 *
 * It reads master's own history, not the commits behind it: a commit is often made on a branch days before it is merged,
 * and a branch can drop a token and put it back without master ever losing it. The change is found by halving the period,
 * so 64 changes cost about eight states for one token, not 64. A token that master gained, lost and gained again within
 * the period is listed once, under one of the two gains.
 */
export async function custodyAdditions(reader: BitGoReader, days: number, now = new Date()): Promise<CustodyBoard> {
  const since = now.getTime() - days * DAY_MS;
  const { head, readAt, recent } = await changesSince(reader, since);
  const held = await tokensAt(reader, head);
  if (held.size === 0) throw new CustodyError(MOVED);

  // States run from 0, master as the period opened, to steps.length, master now.
  const steps = [...recent].reverse();
  const state = (index: number) => tokensAt(reader, index === 0 ? steps[0]!.before : steps[index - 1]!.after);
  const added = new Map<number, string[]>();
  async function locate(low: number, high: number, ids: string[]): Promise<void> {
    if (high - low === 1) {
      added.set(high, ids);
      return;
    }
    const middle = (low + high) >> 1;
    const there = await state(middle);
    const [early, late] = [ids.filter((id) => there.has(id)), ids.filter((id) => !there.has(id))];
    await Promise.all([early.length > 0 && locate(low, middle, early), late.length > 0 && locate(middle, high, late)]);
  }
  if (steps.length > 0) {
    const before = await state(0);
    const fresh = [...held.keys()].filter((id) => !before.has(id));
    if (fresh.length > 0) await locate(0, steps.length, fresh);
  }

  const additions = [...added]
    .sort(([first], [second]) => second - first)
    .map(([index, ids]) => ({
      addedAt: new Date(steps[index - 1]!.at).toISOString(),
      commit: `https://github.com/${REPO}/commit/${steps[index - 1]!.after}`,
      tokens: ids.sort().map((id) => ({ id: `hoodeth:${id}`, ...held.get(id) })),
    }));
  return {
    chain: "Robinhood Chain",
    source: `https://github.com/${REPO}/tree/master/modules/statics/src/coins`,
    readAt: new Date(readAt).toISOString(),
    since: new Date(since).toISOString(),
    additions,
  };
}

const SHA = /^[0-9a-f]{40}$/;
const NOT_CHANGES = "GitHub's answer was not a list of changes to a branch.";

/** GitHub's list of a branch's changes, checked field by field: it is another party's answer and is read as data. */
export function listChanges(body: unknown): BranchChange[] {
  if (!Array.isArray(body)) throw new Error(NOT_CHANGES);
  return body.map((entry: unknown) => {
    const { timestamp, before, after } = (entry ?? {}) as { timestamp?: unknown; before?: unknown; after?: unknown };
    const at = typeof timestamp === "string" ? Date.parse(timestamp) : NaN;
    if (Number.isNaN(at) || typeof before !== "string" || !SHA.test(before) || typeof after !== "string" || !SHA.test(after)) throw new Error(NOT_CHANGES);
    return { at, before, after };
  });
}

const FIRST_PAGE = `https://api.github.com/repos/${REPO}/activity?ref=master&per_page=${PAGE}`;

/** The next page's address from GitHub's link header, accepted only on api.github.com, since the reader follows it. */
function nextPage(response: Response): string | undefined {
  const next = /<([^<>]+)>;\s*rel="next"/.exec(response.headers.get("link") ?? "")?.[1];
  return next?.startsWith("https://api.github.com/") ? next : undefined;
}

/** A 403 or 429 from GitHub: the message for the caller, and the reset time if GitHub sent one. */
function refusal(response: Response): { message: string; until?: number } | undefined {
  if (response.status !== 403 && response.status !== 429) return undefined;
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  if (response.headers.get("x-ratelimit-remaining") === "0" && reset > 0) {
    const message = `GitHub allows 60 unauthenticated API requests an hour from one IP address, and this address has used them up. Try again after ${new Date(reset * 1000).toISOString().slice(11, 16)} UTC.`;
    return { message, until: reset * 1000 };
  }
  return { message: "GitHub is temporarily refusing requests from this IP address. Try again in a minute." };
}

/**
 * Reads BitGo's code from GitHub with no key. A commit and an older page of changes never change, so both are kept until
 * `MAX_KEPT` reads; the newest page is kept for `KEEP_MS`. A read that failed or found no list is not kept. A host that
 * refuses a request is not asked again until the reset time it sent, or for `REFUSED_MS`.
 */
export function bitGoReader(fetchImpl: typeof fetch = fetch, clock: () => number = Date.now): BitGoReader {
  const kept = new Map<string, { until: number; value: Promise<unknown> }>();
  const refused = new Map<string, { until: number; message: string }>();
  const waiting: (() => void)[] = [];
  let open = 0;

  function read<T>(url: string, accept: string, keepFor: (value: T) => number, parse: (response: Response) => Promise<T>): Promise<T> {
    const earlier = kept.get(url);
    if (earlier && clock() < earlier.until) return earlier.value as Promise<T>;
    if (kept.size >= MAX_KEPT) kept.clear();
    const { host } = new URL(url);
    const value = (async () => {
      while (open >= PARALLEL) await new Promise<void>((resolve) => waiting.push(resolve));
      open++;
      try {
        const blocked = refused.get(host);
        if (blocked && clock() < blocked.until) throw new CustodyError(blocked.message);
        const response = await fetchImpl(url, { headers: { Accept: accept, "User-Agent": "brainchain-mcp" }, signal: AbortSignal.timeout(REQUEST_MS) });
        try {
          const refusing = refusal(response);
          if (refusing) {
            refused.set(host, { until: refusing.until ?? clock() + REFUSED_MS, message: refusing.message });
            throw new CustodyError(refusing.message);
          }
          return await parse(response);
        } finally {
          // A body left unread holds its connection open.
          if (!response.bodyUsed) await response.body?.cancel().catch(() => {});
        }
      } finally {
        open--;
        waiting.shift()?.();
      }
    })();
    const entry = { until: Infinity, value };
    kept.set(url, entry);
    const drop = () => {
      if (kept.get(url) === entry) kept.delete(url);
    };
    value.then((result) => {
      entry.until = clock() + keepFor(result);
      if (entry.until <= clock()) drop();
    }, drop);
    return value;
  }

  const statusError = (response: Response) => Object.assign(new Error(`GitHub answered ${response.status}.`), { status: response.status });

  return {
    changes: (page = FIRST_PAGE) =>
      read(
        page,
        "application/vnd.github+json",
        () => (page === FIRST_PAGE ? KEEP_MS : Infinity),
        async (response) => {
          // GitHub answers these for a repository or a branch it does not have.
          if (response.status === 404 || response.status === 422) throw new CustodyError(MOVED);
          if (response.status !== 200) throw statusError(response);
          const next = nextPage(response);
          const changes = listChanges(await response.json().catch(() => Promise.reject(new Error(NOT_CHANGES))));
          return { changes, readAt: clock(), ...(next ? { next } : {}) };
        },
      ),
    list: (file, commit) => {
      if (!SHA.test(commit)) return Promise.reject(new Error(`Not a commit: ${commit}`));
      return read(
        `https://raw.githubusercontent.com/${REPO}/${commit}/${file}`,
        "text/plain",
        (list) => (list ? Infinity : 0),
        async (response) => {
          if (response.status === 404) return undefined;
          if (response.status !== 200) throw statusError(response);
          return tokenList(await response.text());
        },
      );
    },
  };
}

/** `work`, or a `CustodyError` once it has run for `ms`. The work is left to finish: what it reads is kept for the next call. */
export async function within<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CustodyError("BitGo's code on GitHub is taking too long to read. Try again in a minute.")), ms);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

let reader: BitGoReader | undefined;

export function readCustodyAdditions(days: number): Promise<CustodyBoard> {
  reader ??= bitGoReader();
  return within(ANSWER_MS, custodyAdditions(reader, days));
}
