import { createPublicClient, decodeFunctionResult, encodeFunctionData, http, isAddressEqual, multicall3Abi, parseAbi, type Address, type Hash } from "viem";

import { endpointSaid, label, RETRY_MS, tooMany, tooSlow, type ChainHistory } from "../history.js";
import { approvalEvent, type MakerWallet } from "../makers.js";
import { MULTICALL3 } from "../premiums.js";
import { BASES } from "../watch/chain.js";

/** A log search that matched more than an answer holds, or took the endpoint too long, is read in halves. */
export async function allLogs<L>(read: (from: bigint, to: bigint) => Promise<L[]>, from: bigint, to: bigint): Promise<L[]> {
  try {
    return await read(from, to);
  } catch (error) {
    if (from >= to || !(tooMany(error) || tooSlow(error))) throw error;
    const middle = (from + to) / 2n;
    return [...(await allLogs(read, from, middle)), ...(await allLogs(read, middle + 1n, to))];
  }
}

export interface Pace {
  /** Blocks one request covers. */
  span: number;
  atOnce: number;
  /** The least time between two requests starting. */
  gap: number;
  sleep?: (ms: number) => Promise<void>;
  /** Asked before each piece: true stops the scan where it is, and what was written stands. */
  stop?: () => boolean;
}

const nap = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Reads blocks `from` to `to` a piece at a time, `atOnce` pieces in flight, and hands each piece's result to `write` in
 * block order, so whatever `write` keeps is complete up to the last block it was given. A piece that fails is tried again,
 * up to ten times. Returns the last block written.
 */
export async function inOrder<T>(from: number, to: number, pace: Pace, read: (from: number, to: number) => Promise<T>, write: (from: number, to: number, found: T) => Promise<void> | void): Promise<number> {
  const sleep = pace.sleep ?? nap;
  const done = new Map<number, { to: number; found: T }>();
  let next = from;
  let through = from - 1;
  let nextStart = 0;
  let failure: unknown;
  let writing = Promise.resolve();
  const flush = () => {
    writing = writing.then(async () => {
      for (let piece = done.get(through + 1); piece; piece = done.get(through + 1)) {
        done.delete(through + 1);
        await write(through + 1, piece.to, piece.found);
        through = piece.to;
      }
    });
    return writing;
  };
  const worker = async () => {
    while (next <= to && failure === undefined && !pace.stop?.()) {
      const low = next;
      const high = Math.min(low + pace.span - 1, to);
      next = high + 1;
      for (let tries = 1; ; tries++) {
        const wait = Math.max(0, nextStart - Date.now());
        nextStart = Math.max(Date.now(), nextStart) + pace.gap;
        if (wait > 0) await sleep(wait);
        try {
          done.set(low, { to: high, found: await read(low, high) });
          break;
        } catch (error) {
          if (tries >= 10) {
            failure ??= error;
            return;
          }
          await sleep(Math.min(30_000, 1_000 * tries));
        }
      }
      await flush();
    }
  };
  await Promise.all(Array.from({ length: pace.atOnce }, worker));
  await flush();
  // A scan that wrote some pieces before one kept failing stands where it got to, and the next build goes on from there.
  if (failure !== undefined && through === from - 1) throw failure;
  return through;
}

/** A followed wallet's approval of a token, as the scan found it: the first with a value above zero. */
export interface FoundApproval {
  token: Address;
  wallet: Address;
  spender: Address;
  block: number;
  index: number;
  transaction: Hash;
}

/**
 * Every followed wallet's approvals of any token in a range, from the Approval logs that name the wallet as owner. An
 * approval of zero takes an allowance away, and a wallet's ETH, WETH or USDG says nothing about a token, so neither counts.
 */
export async function approvalsIn(reader: ChainHistory, wallets: readonly MakerWallet[], from: number, to: number): Promise<FoundApproval[]> {
  const owners = wallets.map(({ wallet }) => wallet);
  const logs = await allLogs((low, high) => reader.getLogs({ event: approvalEvent, args: { owner: owners }, fromBlock: low, toBlock: high, strict: true }), BigInt(from), BigInt(to));
  return logs
    .filter(({ address, args }) => args.value > 0n && !BASES.has(address.toLowerCase()))
    .map(({ address, args, blockNumber, logIndex, transactionHash }) => ({ token: address, wallet: args.owner, spender: args.spender, block: Number(blockNumber), index: logIndex, transaction: transactionHash }));
}

/** Whether the wallet sent the transaction, or it was sent to the wallet or its Safe: a token's log alone can be written by anyone. */
export async function confirmedBy(reader: ChainHistory, maker: MakerWallet, transaction: Hash): Promise<boolean> {
  const sent = await reader.getTransaction({ hash: transaction });
  const ours = (address: Address | null) => address !== null && (isAddressEqual(address, maker.wallet) || (maker.safe !== undefined && isAddressEqual(address, maker.safe)));
  return isAddressEqual(sent.from, maker.wallet) || ours(sent.to);
}

/** The JSON-RPC calls of a batch the private endpoint takes at once. */
export const BATCH = 100;

/**
 * A reader that sends its calls to `url` in batches, for reads of many blocks at once. Only for a private endpoint: the
 * public one turns a batch of more than a few calls away.
 */
export function batchedReader(url: URL, fetchImpl: typeof fetch): ChainHistory {
  return createPublicClient({ transport: http(url.href, { batch: { batchSize: BATCH, wait: 20 }, fetchFn: fetchImpl, retryCount: 3, retryDelay: RETRY_MS, timeout: 60_000 }) });
}

/**
 * `read`, tried again after a growing wait when it fails: an endpoint holding to a rate per second turns away some of the
 * calls in a batch, and those are asked again.
 */
export async function again<T>(read: () => Promise<T>, tries = 6, sleep = nap): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      if (attempt >= tries) throw error;
      await sleep(500 * 2 ** attempt);
    }
  }
}

/** Each block's time in seconds, `atOnce` reads in flight: half a batch, so a busy endpoint is not sent bursts. */
export async function blockTimes(reader: ChainHistory, blocks: readonly number[], atOnce = BATCH / 2): Promise<Map<number, number>> {
  const times = new Map<number, number>();
  const wanted = [...new Set(blocks)];
  let next = 0;
  const worker = async () => {
    while (next < wanted.length) {
      const block = wanted[next++]!;
      const { timestamp } = await again(() => reader.getBlock({ blockNumber: BigInt(block) }));
      times.set(block, Number(timestamp));
    }
  };
  await Promise.all(Array.from({ length: Math.min(atOnce, wanted.length) }, worker));
  return times;
}

const namesAbi = parseAbi(["function symbol() view returns (string)", "function name() view returns (string)"]);

/** What a token calls itself, cleaned as any text a deployer wrote; empty where it gives no readable answer. */
export interface Names {
  symbol: string;
  name: string;
}

/**
 * Each token's symbol and name, many tokens to one call of Multicall3. A token that burns all the gas it is given takes
 * the whole call down with it, so a call that fails is read again in halves, down to the one token, which is given none.
 */
export async function namesOf(reader: ChainHistory, tokens: readonly Address[]): Promise<Names[]> {
  if (tokens.length === 0) return [];
  try {
    const answers = await reader.readContract({
      address: MULTICALL3,
      abi: multicall3Abi,
      functionName: "aggregate3",
      args: [tokens.flatMap((target) => (["symbol", "name"] as const).map((functionName) => ({ target, allowFailure: true, callData: encodeFunctionData({ abi: namesAbi, functionName }) })))],
    });
    return tokens.map((_, i) => {
      const text = (j: number, functionName: "symbol" | "name") => {
        const answer = answers[i * 2 + j];
        if (!answer?.success) return "";
        try {
          const value = decodeFunctionResult({ abi: namesAbi, functionName, data: answer.returnData });
          return typeof value === "string" ? value : "";
        } catch {
          return "";
        }
      };
      return { symbol: label(text(0, "symbol"), 20), name: label(text(1, "name"), 60) };
    });
  } catch (error) {
    if (tokens.length === 1) {
      if (endpointSaid(error, /out of gas|reverted|execution/i)) return [{ symbol: "", name: "" }];
      throw error;
    }
    const middle = tokens.length >> 1;
    return [...(await namesOf(reader, tokens.slice(0, middle))), ...(await namesOf(reader, tokens.slice(middle)))];
  }
}
