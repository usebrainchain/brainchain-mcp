import { BaseError, createPublicClient, decodeFunctionResult, encodeFunctionData, http, HttpRequestError, multicall3Abi, parseAbi, parseAbiItem, RpcRequestError, zeroAddress, type Address, type Hash, type PublicClient } from "viem";

import { line, within } from "./custody.js";
import { MULTICALL3, ROBINHOOD_RPC } from "./premiums.js";

/** The most blocks Robinhood Chain's public endpoint searches for one contract's logs in a request. */
export const STRETCH_BLOCKS = 10_000_000n;
/** A stretch that ended this many blocks ago is read once and kept. Blocks come about ten a second, so this is an hour. */
export const SETTLED_BLOCKS = 36_000n;
/** How many stretches are kept before they are cleared. A first answer takes a dozen for each thing it looks for. */
export const MAX_KEPT = 5_000;
/** The endpoint turns away an address that sends about 25 requests in a burst, so they go out one at a time, this far apart. */
export const GAP_MS = 150;
/** A request the endpoint turned away is sent again after this long, then twice, four and eight times as long: it can refuse for a few seconds. */
export const RETRY_MS = 500;
/** `decimals()` returns a uint8, so more than 255 is no token's answer, and writing a balance out takes time that grows with it. */
const MAX_DECIMALS = 255;
const REQUEST_MS = 15_000;
/** How long one answer may take, the wait behind other answers included. */
export const ANSWER_MS = 45_000;

const READS = ["getBlock", "getBlockNumber", "getCode", "getLogs", "getTransaction", "readContract"] as const;
/** What the tools that read the chain's past need of it. */
export type ChainHistory = Pick<PublicClient, (typeof READS)[number]>;

/** What was found in each stretch of blocks already read, by what was looked for. */
export type Kept<T> = Map<string, Promise<T | undefined>>;

/** As `CustodyError`: a message already written for the person asking. */
export class ChainError extends Error {}

/** Whether the endpoint itself answered with an error whose text matches. */
export const endpointSaid = (error: unknown, text: RegExp) => error instanceof BaseError && error.walk((cause) => cause instanceof RpcRequestError && text.test(cause.details)) !== null;
/** The endpoint returns at most 10,000 logs for a request and refuses one that matches more. */
export const tooMany = (error: unknown) => endpointSaid(error, /exceeds limit/i);
/** It also gives up on a search that takes it too long, as ten million blocks of a busy token can. */
export const tooSlow = (error: unknown) => endpointSaid(error, /timed out/i);

/**
 * A token's name for itself is whatever its deployer wrote, and an agent reads it. It goes out as one short line with
 * nothing that passes for markup and no letter that shows as blank.
 */
export const label = (text: string, max: number) => line(text.replace(/[<>[\]`\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180f\u2800\u3164\ufe00-\ufe0f\uffa0\u{e0000}-\u{e0fff}]/gu, " "), max);

const tokenAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
]);
type TokenRead = "decimals" | "totalSupply" | "name" | "symbol" | "balanceOf";

export interface TokenFacts {
  decimals: number;
  supply: bigint;
  /** What the contract calls itself, cleaned; empty where it gives no readable answer. */
  name: string;
  symbol: string;
  /** What each of `holders` holds, in the order they were given. */
  balances: bigint[];
}

/** What a tool that needs a token says of an address that holds no contract. */
export const noContract = (token: Address) =>
  new ChainError(
    `There is no contract at ${token} on Robinhood Chain. If the address came from brainchain_custody_additions, the token may not be deployed yet: BitGo lists some tokens before their contract exists. Otherwise check the address.`,
  );

const notToken = (token: Address) => new ChainError(`The contract at ${token} on Robinhood Chain does not behave like a token: its decimals, its total supply or a balance could not be read. Check that this is the token's own contract address.`);

/**
 * What a token says about itself, and what each of `holders` has of it, in one request; undefined for an address that
 * holds no contract. Everything the contract answers is read as untrusted data: a read that failed or came back in
 * another form than its type counts as missing.
 */
export async function tokenFacts(reader: ChainHistory, token: Address, holders: readonly Address[] = [], blockNumber?: bigint): Promise<TokenFacts | undefined> {
  const reads: { functionName: TokenRead; args?: [Address] }[] = [
    { functionName: "decimals" },
    { functionName: "totalSupply" },
    { functionName: "name" },
    { functionName: "symbol" },
    ...holders.map((holder) => ({ functionName: "balanceOf" as const, args: [holder] as [Address] })),
  ];
  // One call to Multicall3 and not viem's multicall, which reports a request the endpoint refused as every read having failed.
  const answers = await reader
    .readContract({
      address: MULTICALL3,
      abi: multicall3Abi,
      functionName: "aggregate3",
      args: [reads.map((read) => ({ target: token, allowFailure: true, callData: encodeFunctionData({ abi: tokenAbi, ...read }) }))],
      ...(blockNumber === undefined ? {} : { blockNumber }),
    })
    .catch((error: unknown) => {
      // A contract that burns all the gas it is given takes the whole call down with it.
      throw endpointSaid(error, /out of gas|reverted/i) ? notToken(token) : error;
    });
  const [decimals, supply, name, symbol, ...balances] = reads.map(({ functionName }, i): unknown => {
    const answer = answers[i];
    if (!answer?.success) return undefined;
    try {
      return decodeFunctionResult({ abi: tokenAbi, functionName, data: answer.returnData });
    } catch {
      return undefined;
    }
  });
  const held = balances.filter((balance) => typeof balance === "bigint");
  if (typeof decimals !== "number" || decimals > MAX_DECIMALS || typeof supply !== "bigint" || held.length !== holders.length) {
    const code = await reader.getCode({ address: token });
    if (code && code !== "0x") throw notToken(token);
    return undefined;
  }
  return { decimals, supply, name: typeof name === "string" ? label(name, 60) : "", symbol: typeof symbol === "string" ? label(symbol, 20) : "", balances: held };
}

interface Placed {
  blockNumber: bigint;
  logIndex: number;
}

/**
 * The earliest of the logs between two blocks that `wanted` accepts. `read` fetches the logs of a range; a range with more
 * logs than the endpoint returns, or one it takes too long to search, is halved. A single block that still has too many
 * throws `full()`.
 */
export async function earliestLog<L extends Placed>(read: (from: bigint, to: bigint) => Promise<L[]>, from: bigint, to: bigint, wanted: (log: L) => boolean, full: () => Error): Promise<L | undefined> {
  const logs = await read(from, to).catch((error: unknown) => {
    if (from < to && (tooMany(error) || tooSlow(error))) return undefined;
    throw tooMany(error) ? full() : error;
  });
  if (!logs) {
    const middle = (from + to) / 2n;
    return (await earliestLog(read, from, middle, wanted, full)) ?? earliestLog(read, middle + 1n, to, wanted, full);
  }
  const accepted = logs.filter(wanted);
  if (accepted.length === 0) return undefined;
  return accepted.reduce((earliest, log) => (log.blockNumber < earliest.blockNumber || (log.blockNumber === earliest.blockNumber && log.logIndex < earliest.logIndex) ? log : earliest));
}

/**
 * The first thing `find` turns up, looking through the chain a stretch of `STRETCH_BLOCKS` at a time from the stretch that
 * holds `start` up to `newest`. The endpoint keeps no state from the past, so the logs are the only history there is.
 * A stretch that ended `SETTLED_BLOCKS` ago cannot change and is kept in `kept` under `key`, so asking again reads only
 * the newest stretch. `find` is given a whole stretch, so what it finds may lie before `start` in the first one.
 */
export async function firstSince<T>(kept: Kept<T>, key: string, newest: bigint, find: (from: bigint, to: bigint) => Promise<T | undefined>, start = 0n): Promise<T | undefined> {
  function stretch(from: bigint): Promise<T | undefined> {
    const to = from + STRETCH_BLOCKS - 1n;
    if (to + SETTLED_BLOCKS > newest) return find(from, to < newest ? to : newest);
    return remember(kept, `${key}:${from}`, () => find(from, to));
  }
  for (let from = (start / STRETCH_BLOCKS) * STRETCH_BLOCKS; from <= newest; from += STRETCH_BLOCKS) {
    const found = await stretch(from);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** What `read` finds, kept under `name`. A read that fails is dropped, so the next answer asks again. */
function remember<T>(kept: Map<string, Promise<T>>, name: string, read: () => Promise<T>): Promise<T> {
  const earlier = kept.get(name);
  if (earlier) return earlier;
  if (kept.size >= MAX_KEPT) kept.clear();
  const reading = read();
  kept.set(name, reading);
  reading.catch(() => {
    if (kept.get(name) === reading) kept.delete(name);
  });
  return reading;
}

/** When a block was made. The endpoint sends every log with a block time of zero, so the time comes from the block. */
export async function blockTime(reader: ChainHistory, blockNumber: bigint): Promise<string> {
  const block = await reader.getBlock({ blockNumber });
  return new Date(Number(block.timestamp) * 1000).toISOString();
}

/** A point in the chain's past: a block, or a time in milliseconds, which stands for the last block made by then. */
export type Moment = { block: bigint } | { time: number };

/** As `noContract`: what a tool that reads the past says of a block the chain has not made. */
const notYet = (block: bigint, newest: bigint) => new ChainError(`Block ${block} is not on Robinhood Chain yet: the newest block is ${newest}.`);

/**
 * The block `moment` stands for and when it was made. For a time that is the last block made at or before it. Blocks
 * come at an uneven pace, a hundred in the chain's first week and about ten a second now, so a guess from the times on
 * either side alternates with a halving: that keeps the search within twice the halvings alone, about 55 reads, and
 * usually ends it in a dozen. The times of settled blocks are kept in `kept`, since a search for a nearby time asks for
 * the same blocks.
 */
export async function blockOf(reader: ChainHistory, moment: Moment, newest: bigint, kept: Map<string, Promise<bigint>>): Promise<{ block: bigint; at: string }> {
  const stamp = (block: bigint) => {
    const read = () => reader.getBlock({ blockNumber: block }).then(({ timestamp }) => timestamp);
    return block + SETTLED_BLOCKS > newest ? read() : remember(kept, String(block), read);
  };
  const dated = (block: bigint, seconds: bigint) => ({ block, at: new Date(Number(seconds) * 1000).toISOString() });
  if ("block" in moment) {
    if (moment.block > newest) throw notYet(moment.block, newest);
    return dated(moment.block, await stamp(moment.block));
  }
  const wanted = BigInt(Math.floor(moment.time / 1000));
  let [low, high] = [0n, newest];
  let [lowAt, highAt] = [await stamp(low), await stamp(high)];
  if (highAt <= wanted) return dated(high, highAt);
  if (lowAt > wanted) throw new ChainError(`${new Date(moment.time).toISOString()} is before Robinhood Chain's first block.`);
  for (let halve = false; high - low > 1n; halve = !halve) {
    const guess = halve ? (low + high) / 2n : low + ((wanted - lowAt) * (high - low)) / (highAt - lowAt);
    const probe = guess <= low ? low + 1n : guess >= high ? high - 1n : guess;
    const at = await stamp(probe);
    if (at <= wanted) [low, lowAt] = [probe, at];
    else [high, highAt] = [probe, at];
  }
  return dated(low, lowAt);
}

/** Something that happened in a block: when, in which block, and the transaction it was part of. */
export interface Dated {
  at: string;
  block: number;
  transaction: Hash;
}

export interface Mint extends Dated {
  to: Address;
}

const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

/** The first time tokens of `token` were created: its first transfer out of the zero address. Nothing for a token that has minted none. */
export function firstMint(reader: ChainHistory, token: Address, newest: bigint, kept: Kept<Mint>): Promise<Mint | undefined> {
  return firstSince(kept, `${token}:mint`, newest, async (from, to) => {
    const log = await earliestLog(
      (low, high) => reader.getLogs({ address: token, event: transferEvent, args: { from: zeroAddress }, fromBlock: low, toBlock: high, strict: true }),
      from,
      to,
      (mint) => mint.args.value > 0n,
      () => new ChainError(`The contract at ${token} logged more than 10,000 mints in a single block, more than this tool can read.`),
    );
    return log && { at: await blockTime(reader, log.blockNumber), block: Number(log.blockNumber), transaction: log.transactionHash, to: log.args.to };
  });
}

/**
 * How much of `token` the token's Transfer logs say `holder` was sent (`side` "to") or sent out (`side` "from") from one
 * block to another. A range with more logs than the endpoint returns, or one it takes too long to search, is halved. A
 * range that has settled is kept, halves included, so an answer that ran out of time goes on from where it stopped.
 */
export function transferred(reader: ChainHistory, token: Address, holder: Address, side: "from" | "to", from: bigint, to: bigint, newest: bigint, kept: Map<string, Promise<bigint>>): Promise<bigint> {
  const read = async (): Promise<bigint> => {
    const logs = await reader.getLogs({ address: token, event: transferEvent, args: side === "to" ? { to: holder } : { from: holder }, fromBlock: from, toBlock: to, strict: true }).catch((error: unknown) => {
      if (from < to && (tooMany(error) || tooSlow(error))) return undefined;
      throw tooMany(error) ? new ChainError(`The contract at ${token} logged more than 10,000 transfers ${side} ${holder} in a single block, more than this tool can read, so it cannot give a past balance for this token. Trying again will not change that.`) : error;
    });
    if (logs) return logs.reduce((sum, log) => sum + log.args.value, 0n);
    const middle = (from + to) / 2n;
    return (await transferred(reader, token, holder, side, from, middle, newest, kept)) + (await transferred(reader, token, holder, side, middle + 1n, to, newest, kept));
  };
  return to + SETTLED_BLOCKS > newest ? read() : remember(kept, `${token}:${holder}:${side}:${from}-${to}`, read);
}

/**
 * The start of the first stretch in which `token` logged a transfer: no wallet held any of it before, so a wallet's
 * transfers are read from there. A stretch too full to return, or too slow to search, has transfers, and counts.
 */
export function transfersStart(reader: ChainHistory, token: Address, newest: bigint, kept: Kept<bigint>): Promise<bigint | undefined> {
  return firstSince(kept, `${token}:transfers`, newest, (from, to) =>
    reader.getLogs({ address: token, event: transferEvent, fromBlock: from, toBlock: to, strict: true }).then(
      (logs) => (logs.length > 0 ? from : undefined),
      (error: unknown) => {
        if (tooMany(error) || tooSlow(error)) return from;
        throw error;
      },
    ),
  );
}

/** `fetchImpl` with one request out at a time and `gap` milliseconds before the next. */
export function paced(fetchImpl: typeof fetch = fetch, gap = GAP_MS): typeof fetch {
  let last: Promise<unknown> = Promise.resolve();
  return (input, init) => {
    const turn = last.then(() => fetchImpl(input, init));
    const rest = () => new Promise((resolve) => setTimeout(resolve, gap));
    last = turn.then(rest, rest);
    return turn;
  };
}

export function chainHistory(rpc = ROBINHOOD_RPC, fetchImpl: typeof fetch = fetch): ChainHistory {
  return createPublicClient({ transport: http(rpc, { fetchFn: paced(fetchImpl), retryCount: 4, retryDelay: RETRY_MS, timeout: REQUEST_MS }) });
}

/**
 * After a lot of reading, more of it on a busy token, the endpoint answers every request from the address with 429 for
 * some minutes: four when it was measured on 2026-11-17. Sending more in that time gets nothing.
 */
export const TURNED_AWAY =
  "Robinhood Chain's public endpoint is turning this server's requests away, which it does for a few minutes after a lot of reading. What was read is kept: ask again in five minutes and it goes on from there.";
const turnedAway = (error: unknown) => error instanceof BaseError && error.walk((cause) => cause instanceof HttpRequestError && cause.status === 429) !== null;

export const STILL_READING =
  "This token's history on Robinhood Chain was not read within 45 seconds, the wait behind earlier answers included. What was read is kept: ask again and it goes on from there.";

/** `reader`, refusing every read once `until` has passed, so an answer nobody is waiting for stops at its next request. */
function expiring(reader: ChainHistory, until: number, clock: () => number): ChainHistory {
  type Read = (...args: unknown[]) => Promise<unknown>;
  const guarded = (read: Read): Read => (...args) => (clock() >= until ? Promise.reject(new ChainError(STILL_READING)) : read(...args));
  return Object.fromEntries(READS.map((name) => [name, guarded(reader[name].bind(reader) as Read)])) as ChainHistory;
}

let shared: ChainHistory | undefined;
let busy: Promise<unknown> = Promise.resolve();

/**
 * Runs `answer` against the one reader the server shares, after whatever answer was asked for before it: requests go out
 * one by one, so answers read side by side would all come late together. The caller hears `STILL_READING` after
 * `ANSWER_MS`, the wait included, and the answer stops at its next request; what it read by then is kept. The next answer
 * starts when the caller has heard, not when the last request of an answer that ran out of time comes back: the endpoint
 * can take a minute to refuse one for good.
 */
export function inTurn<T>(answer: (reader: ChainHistory) => Promise<T>, clock: () => number = Date.now): Promise<T> {
  shared ??= chainHistory();
  const reader = expiring(shared, clock() + ANSWER_MS, clock);
  const reading = busy
    .then(() => answer(reader))
    .catch((error: unknown) => {
      throw turnedAway(error) ? new ChainError(TURNED_AWAY) : error;
    });
  const heard = within(ANSWER_MS, reading, new ChainError(STILL_READING));
  busy = heard.catch(() => {});
  return heard;
}
