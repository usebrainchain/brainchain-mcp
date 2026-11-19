import { formatUnits, getAddress, isAddressEqual, zeroAddress, type Address, type Hash } from "viem";

import { blockTime, ChainError, earliestLog, firstSince, tokenFacts, tooMany, tooSlow, transferEvent, transfersStart, type ChainHistory, type Dated, type Kept } from "../history.js";
import { approvalEvent, firstApprovals, who, type Approval, type MakerWallet } from "../makers.js";
import { initializeEvent, poolCreatedEvent, UNISWAP_V3, UNISWAP_V4 } from "../readiness.js";
import type { EventToken, Found } from "./events.js";
import type { Poller } from "./watcher.js";

export const CHAIN_INTERVAL = 15_000;
/** Without a contract address, Robinhood Chain's public endpoint searches at most 30,000 blocks in one request (read 2026-11-19). */
export const SPAN = 30_000n;
/**
 * What most pools are paired against: ETH, WETH and USDG, the three most paired on Robinhood Chain on 2026-11-19. A new pool
 * is news about the token on the other side, so no event is ever about one of these.
 */
export const BASES: ReadonlySet<string> = new Set([zeroAddress, "0x0bd7d308f8e1639fab988df18a8011f41eacad73", "0x5fc5360d0400a0fd4f2af552add042d716f1d168"]);

export interface Receipt extends Dated {
  from: Address;
  value: bigint;
  confirmed: boolean;
}

/** How a wallet's first approval and first receipt of a token are found. A test passes its own. */
export interface Firsts {
  /** The wallet's first approval of the token, whenever it was made. */
  approval(token: Address, maker: MakerWallet, newest: bigint): Promise<Approval | undefined>;
  /** The wallet's first receipt of the token between two blocks, or "earlier" when it had received some before `from`. */
  receipt(token: Address, maker: MakerWallet, from: bigint, to: bigint): Promise<Receipt | "earlier" | undefined>;
}

export interface ChainKept {
  approvals: Kept<Approval>;
  starts: Kept<bigint>;
  received: Kept<true>;
}

export const chainKept = (): ChainKept => ({ approvals: new Map(), starts: new Map(), received: new Map() });

/** Whether `maker` sent the transaction, or it was sent to the wallet or its Safe: the token's log alone can be written by anyone who deployed it. */
async function own(reader: ChainHistory, maker: MakerWallet, transaction: Hash): Promise<boolean> {
  const sent = await reader.getTransaction({ hash: transaction });
  const ours = (address: Address | null) => address !== null && (isAddressEqual(address, maker.wallet) || (maker.safe !== undefined && isAddressEqual(address, maker.safe)));
  return isAddressEqual(sent.from, maker.wallet) || ours(sent.to);
}

const transfersTo = (reader: ChainHistory, token: Address, maker: MakerWallet, from: bigint, to: bigint) =>
  reader.getLogs({ address: token, event: transferEvent, args: { to: maker.wallet }, fromBlock: from, toBlock: to, strict: true });

/**
 * Whether the wallet received any of `token` up to block `through`. Only whether, not when: a stretch the endpoint finds
 * too full or too slow to search has transfers in it, so a busy token is settled in a request or two rather than by a
 * search through millions of blocks for the oldest one.
 */
async function receivedBy(reader: ChainHistory, token: Address, maker: MakerWallet, kept: ChainKept, through: bigint): Promise<boolean> {
  const start = await transfersStart(reader, token, through, kept.starts);
  if (start === undefined) return false;
  const found = await firstSince(
    kept.received,
    `${token}:${maker.wallet}:received`,
    through,
    (from, to) =>
      transfersTo(reader, token, maker, from, to).then(
        (logs) => (logs.some((log) => log.args.value > 0n) ? (true as const) : undefined),
        (error: unknown) => {
          if (tooMany(error) || tooSlow(error)) return true as const;
          throw error;
        },
      ),
    start,
  );
  return found === true;
}

export function chainFirsts(reader: ChainHistory, kept: ChainKept): Firsts {
  return {
    approval: async (token, maker, newest) => (await firstApprovals(reader, token, [maker], kept, newest))[0],
    async receipt(token, maker, from, to) {
      if (from > 0n && (await receivedBy(reader, token, maker, kept, from - 1n))) return "earlier";
      const log = await earliestLog(
        (low, high) => transfersTo(reader, token, maker, low, high),
        from,
        to,
        (transfer) => transfer.args.value > 0n,
        () => new ChainError(`The contract at ${token} logged more than 10,000 transfers to ${maker.wallet} in a single block.`),
      );
      if (!log) return undefined;
      return { at: await blockTime(reader, log.blockNumber), block: Number(log.blockNumber), transaction: log.transactionHash, from: log.args.from, value: log.args.value, confirmed: await own(reader, maker, log.transactionHash) };
    },
  };
}

/** Every log in a range, halving a range the endpoint finds too full or too slow to search. */
async function allLogs<L>(read: (from: bigint, to: bigint) => Promise<L[]>, from: bigint, to: bigint): Promise<L[]> {
  try {
    return await read(from, to);
  } catch (error) {
    if (from >= to || !(tooMany(error) || tooSlow(error))) throw error;
    const middle = (from + to) / 2n;
    return [...(await allLogs(read, from, middle)), ...(await allLogs(read, middle + 1n, to))];
  }
}

export interface ChainOptions {
  reader: ChainHistory;
  wallets: readonly MakerWallet[];
  /** The lowercased addresses of the tokens the log has a public trace for. A pool is reported only for one of these. */
  watched: () => ReadonlySet<string>;
  firsts: Firsts;
  interval?: number;
}

interface ChainState {
  /** The last block read, and the one the watcher started from: nothing before it is reported as new. */
  block?: number;
  startBlock?: number;
  /** Token and wallet pairs whose first approval or first receipt is already settled. */
  settled?: string[];
}

/**
 * Reads only new blocks, at most `SPAN` at a time, for three things: a pool created on Uniswap v3 or v4 for a token with a
 * public trace, paired with ETH, WETH, USDG or another such token; and a followed wallet's first approval, or first
 * receipt, of any token. The first read only notes the newest block: what came before is the baseline. A first approval
 * older than the blocks being read is recorded as baseline, and a wallet that had received a token before them is noted as
 * settled, so neither is reported as new.
 */
export function chainPoller({ reader, wallets, watched, firsts, interval = CHAIN_INTERVAL }: ChainOptions): Poller {
  const facts = new Map<string, Promise<{ token: EventToken; decimals?: number }>>();
  const describe = (address: Address) => {
    const key = address.toLowerCase();
    let known = facts.get(key);
    if (!known) {
      known = tokenFacts(reader, address).then(
        (read) => ({ token: { address, symbol: read?.symbol || null, name: read?.name || null }, ...(read ? { decimals: read.decimals } : {}) }),
        () => ({ token: { address, symbol: null, name: null } }),
      );
      facts.set(key, known);
    }
    return known;
  };
  const makerOf = (wallet: Address) => wallets.find((maker) => isAddressEqual(maker.wallet, wallet))!;

  return {
    name: "chain",
    interval,
    async poll(context) {
      const state = context.state as ChainState;
      const newest = await reader.getBlockNumber();
      if (state.block === undefined) {
        state.block = state.startBlock = Number(newest);
        context.log(`starting at block ${newest}.`);
        return;
      }
      const from = BigInt(state.block) + 1n;
      if (from > newest) return;
      const to = from + SPAN - 1n < newest ? from + SPAN - 1n : newest;
      // Each find is recorded as it is made, so a read the endpoint cuts short keeps what it settled: the next try skips it.
      const settled = new Set(state.settled ?? []);
      const record = async (row: Found, key?: string) => {
        await context.record([row]);
        if (!key) return;
        settled.add(key);
        state.settled = [...settled];
      };
      const times = new Map<bigint, Promise<string>>();
      const timeOf = (block: bigint) => {
        if (!times.has(block)) times.set(block, blockTime(reader, block));
        return times.get(block)!;
      };

      const pools = await allLogs((low, high) => reader.getLogs({ address: [UNISWAP_V3, UNISWAP_V4], events: [poolCreatedEvent, initializeEvent], fromBlock: low, toBlock: high, strict: true }), from, to);
      const tracked = watched();
      for (const log of pools) {
        const pool =
          log.eventName === "PoolCreated"
            ? { venue: "Uniswap v3", pair: [log.args.token0, log.args.token1], detail: { pool: log.args.pool, fee: log.args.fee, tickSpacing: log.args.tickSpacing } }
            : { venue: "Uniswap v4", pair: [log.args.currency0, log.args.currency1], detail: { pool: log.args.id, fee: log.args.fee, tickSpacing: log.args.tickSpacing, hooks: log.args.hooks } };
        const sides = pool.pair.map((address) => address.toLowerCase());
        for (const side of [0, 1]) {
          const [mine, other] = [sides[side]!, sides[1 - side]!];
          if (BASES.has(mine) || !tracked.has(mine) || !(BASES.has(other) || tracked.has(other))) continue;
          const { token } = await describe(getAddress(mine));
          await record({
            kind: "pool.created",
            token,
            source: pool.venue,
            ref: log.transactionHash,
            at: await timeOf(log.blockNumber),
            detail: { venue: pool.venue, ...pool.detail, pairedWith: other === zeroAddress ? "ETH" : getAddress(other), block: Number(log.blockNumber), transaction: log.transactionHash },
          });
        }
      }

      const owners = wallets.map(({ wallet }) => wallet);
      const approvals = await allLogs((low, high) => reader.getLogs({ event: approvalEvent, args: { owner: owners }, fromBlock: low, toBlock: high, strict: true }), from, to);
      const receipts = await allLogs((low, high) => reader.getLogs({ event: transferEvent, args: { to: owners }, fromBlock: low, toBlock: high, strict: true }), from, to);
      const seen = [
        ...approvals.map(({ address, args }) => ({ kind: "maker.approval" as const, key: "approval", address, wallet: args.owner, value: args.value })),
        ...receipts.map(({ address, args }) => ({ kind: "maker.receipt" as const, key: "receipt", address, wallet: args.to, value: args.value })),
      ];
      for (const { kind, address, wallet, value, ...rest } of seen) {
        const key = `${rest.key}:${address.toLowerCase()}:${wallet.toLowerCase()}`;
        // A zero approval takes an allowance away, and a zero transfer moves nothing.
        if (value === 0n || settled.has(key)) continue;
        const maker = makerOf(wallet);
        const contract = getAddress(address);
        const first = kind === "maker.approval" ? await firsts.approval(contract, maker, to) : await firsts.receipt(contract, maker, from, to);
        if (!first) continue;
        if (first === "earlier") {
          settled.add(key);
          state.settled = [...settled];
          continue;
        }
        const { token, decimals } = await describe(contract);
        const what = "spender" in first ? { spender: first.spender } : { from: first.from, amount: decimals === undefined ? first.value.toString() : formatUnits(first.value, decimals) };
        const detail = { maker: who(maker), ...what, confirmed: first.confirmed, block: first.block, transaction: first.transaction };
        await record({ kind, token, source: "Robinhood Chain", ref: first.transaction, at: first.at, detail, ...(BigInt(first.block) < from ? { baseline: true as const } : {}) }, key);
      }

      state.block = Number(to);
      return to < newest;
    },
  };
}
