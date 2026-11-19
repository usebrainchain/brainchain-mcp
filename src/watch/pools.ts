import { closeSync, existsSync, fstatSync, ftruncateSync, openSync, readFileSync, readSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { getAddress, zeroAddress, type Address } from "viem";

import { tooMany, tooSlow, type ChainHistory } from "../history.js";
import { USDG, WETH } from "../marketcap.js";
import { initializeEvent, poolCreatedEvent, UNISWAP_V3, UNISWAP_V4 } from "../readiness.js";

/**
 * Every Uniswap v3 and v4 pool on Robinhood Chain, kept on disk: `pools.jsonl` holds one pool a line, in the order they
 * were added, and `pools.checkpoint.json` the block through which every pool is in it. The watcher fills it once from the
 * contracts' deployment, ten thousand blocks a request, and then from the blocks its chain poll reads anyway; a token's
 * pools are then a lookup and not a search of the chain's history.
 */

/** One pool, as a line of `pools.jsonl`. */
export interface IndexedPool {
  version: 3 | 4;
  /** A v3 pool's address, or a v4 pool's id in the pool manager. */
  pool: string;
  currency0: Address;
  currency1: Address;
  /** In hundredths of a basis point, as the pool takes it. */
  fee: number;
  tickSpacing: number;
  /** A v4 pool's hooks contract: the zero address for none. */
  hooks?: Address;
  /** The block it was created in. */
  block: number;
}

export interface PoolCheckpoint {
  /** The first block searched: the v3 factory's deployment, before the v4 pool manager's. */
  from: number;
  /** Every pool created from `from` through this block is in the file. */
  through: number;
  /** Blocks the chain poll added above a fill still running; joined to `through` when the fill reaches them. */
  live?: { from: number; through: number };
  /** The file's length at this checkpoint: anything after it was written by a run that stopped before its next checkpoint. */
  bytes: number;
  pools: number;
  updatedAt: string;
}

export const POOLS_FILE = "pools.jsonl";
export const CHECKPOINT_FILE = "pools.checkpoint.json";
/** The block the Uniswap v3 factory was deployed in; the v4 pool manager came at 9,070. */
export const INDEX_FROM = 8_930;
/** Chainstack's limit on the blocks one log search covers. */
export const PIECE = 10_000;
/** How many pieces of the fill are in flight at once, and the least time between two starting. */
export const FILL_AT_ONCE = 4;
export const FILL_GAP_MS = 200;
/** Lines appended since the index was last sorted, past which a lookup sorts it again. */
const TAIL = 20_000;
/** Longer than any line the index writes. */
const MAX_LINE = 600;

const BASE = new Set([zeroAddress, WETH.toLowerCase(), USDG.toLowerCase()]);
const isBase = (address: string) => BASE.has(address.toLowerCase());

/** A pool log as viem decodes it from the v3 factory or the v4 pool manager. */
export type PoolLog =
  | { eventName: "PoolCreated"; blockNumber: bigint; args: { token0: Address; token1: Address; fee: number; tickSpacing: number; pool: Address } }
  | { eventName: "Initialize"; blockNumber: bigint; args: { id: `0x${string}`; currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address } };

export function poolOf(log: PoolLog): IndexedPool {
  if (log.eventName === "PoolCreated") {
    const { token0, token1, fee, tickSpacing, pool } = log.args;
    return { version: 3, pool: getAddress(pool), currency0: getAddress(token0), currency1: getAddress(token1), fee, tickSpacing, block: Number(log.blockNumber) };
  }
  const { id, currency0, currency1, fee, tickSpacing, hooks } = log.args;
  return { version: 4, pool: id, currency0: getAddress(currency0), currency1: getAddress(currency1), fee, tickSpacing, hooks: getAddress(hooks), block: Number(log.blockNumber) };
}

/** The pools created in a range, in chain order; a range with more logs than one answer holds is read in halves. */
export async function poolsIn(reader: ChainHistory, from: bigint, to: bigint): Promise<IndexedPool[]> {
  try {
    const logs = await reader.getLogs({ address: [UNISWAP_V3, UNISWAP_V4], events: [poolCreatedEvent, initializeEvent], fromBlock: from, toBlock: to, strict: true });
    return (logs as unknown as PoolLog[]).map(poolOf);
  } catch (error) {
    if (from >= to || !(tooMany(error) || tooSlow(error))) throw error;
    const middle = (from + to) / 2n;
    return [...(await poolsIn(reader, from, middle)), ...(await poolsIn(reader, middle + 1n, to))];
  }
}

/** An address's first sixteen hex digits, as two numbers: the key the index sorts and searches by. */
const prefix = (address: string): [number, number] => [parseInt(address.slice(2, 10), 16) >>> 0, parseInt(address.slice(10, 18), 16) >>> 0];
const CURRENCIES = /"currency0":"(0x[0-9a-fA-F]{40})","currency1":"(0x[0-9a-fA-F]{40})"/;

export interface FillStatus {
  through: number;
  target: number;
  requests: number;
  startedAt: string;
  doneAt?: string;
}

/**
 * The index: the file, and in memory each pool's token other than ETH, WETH or USDG by its first sixteen hex digits and
 * where its line starts, sorted, so a token's pools are found by reading a few lines. Pools between two of those three are
 * few and kept whole.
 */
export class PoolIndex {
  private readonly path: string;
  private readonly checkpointPath: string;
  private readonly fd: number;
  private checkpoint: PoolCheckpoint;
  private size = 0;
  private hi = new Uint32Array(1 << 16);
  private lo = new Uint32Array(1 << 16);
  private at = new Uint32Array(1 << 16);
  private count = 0;
  private sorted = 0;
  private bases: IndexedPool[] = [];
  private filling?: FillStatus;
  private filled = false;

  constructor(
    dir: string,
    private readonly say: (line: string) => void = () => {},
  ) {
    this.path = join(dir, POOLS_FILE);
    this.checkpointPath = join(dir, CHECKPOINT_FILE);
    const fresh: PoolCheckpoint = { from: INDEX_FROM, through: INDEX_FROM - 1, bytes: 0, pools: 0, updatedAt: new Date().toISOString() };
    let saved: PoolCheckpoint | undefined;
    try {
      saved = existsSync(this.checkpointPath) ? (JSON.parse(readFileSync(this.checkpointPath, "utf8")) as PoolCheckpoint) : undefined;
    } catch {
      saved = undefined;
    }
    this.fd = openSync(this.path, "a+");
    const length = fstatSync(this.fd).size;
    // Lines past the checkpoint come from a run that stopped before saying it had them: they are read again.
    if (!saved || length < saved.bytes) {
      if (length > 0) ftruncateSync(this.fd, 0);
      this.checkpoint = fresh;
    } else {
      if (length > saved.bytes) ftruncateSync(this.fd, saved.bytes);
      this.checkpoint = saved;
    }
    this.load();
    this.filled = this.checkpoint.through > INDEX_FROM && !this.checkpoint.live;
  }

  /** Reads the file's lines into the in-memory index. */
  private load(): void {
    const chunk = Buffer.alloc(1 << 20);
    let offset = 0;
    let rest = "";
    let restAt = 0;
    for (;;) {
      const read = readSync(this.fd, chunk, 0, chunk.length, offset);
      if (read === 0) break;
      const text = rest + chunk.toString("latin1", 0, read);
      let start = 0;
      for (let end = text.indexOf("\n"); end !== -1; end = text.indexOf("\n", start)) {
        this.note(text.slice(start, end), restAt + start);
        start = end + 1;
      }
      restAt += start;
      rest = text.slice(start);
      offset += read;
    }
    this.size = offset;
    this.sort();
  }

  /** Adds one line, written at `at`, to the in-memory index. */
  private note(line: string, at: number): void {
    const found = CURRENCIES.exec(line);
    if (!found) return;
    const [, currency0, currency1] = found;
    const sides = [currency0!, currency1!].filter((currency) => !isBase(currency));
    if (sides.length === 0) this.bases.push(JSON.parse(line) as IndexedPool);
    for (const side of new Set(sides.map((side) => side.toLowerCase()))) {
      if (this.count === this.hi.length) {
        for (const name of ["hi", "lo", "at"] as const) {
          const grown = new Uint32Array(this[name].length * 2);
          grown.set(this[name]);
          this[name] = grown;
        }
      }
      [this.hi[this.count], this.lo[this.count]] = prefix(side);
      this.at[this.count] = at;
      this.count++;
    }
  }

  /** Sorts the in-memory index by token, which a lookup searches by halving. */
  private sort(): void {
    const order = new Uint32Array(this.count);
    for (let i = 0; i < this.count; i++) order[i] = i;
    order.sort((a, b) => this.hi[a]! - this.hi[b]! || this.lo[a]! - this.lo[b]!);
    const [hi, lo, at] = [new Uint32Array(this.hi.length), new Uint32Array(this.lo.length), new Uint32Array(this.at.length)];
    for (let i = 0; i < this.count; i++) [hi[i], lo[i], at[i]] = [this.hi[order[i]!]!, this.lo[order[i]!]!, this.at[order[i]!]!];
    [this.hi, this.lo, this.at] = [hi, lo, at];
    this.sorted = this.count;
  }

  /** Appends pools to the file and the in-memory index. */
  private append(pools: readonly IndexedPool[]): void {
    if (pools.length === 0) return;
    let text = "";
    const starts: number[] = [];
    for (const pool of pools) {
      starts.push(this.size + Buffer.byteLength(text));
      text += `${JSON.stringify(pool)}\n`;
    }
    writeSync(this.fd, text);
    pools.forEach((pool, i) => this.note(JSON.stringify(pool), starts[i]!));
    this.size += Buffer.byteLength(text);
    this.checkpoint.pools += pools.length;
  }

  private save(): void {
    this.checkpoint = { ...this.checkpoint, bytes: this.size, updatedAt: new Date().toISOString() };
    writeFileSync(`${this.checkpointPath}.tmp`, `${JSON.stringify(this.checkpoint)}\n`);
    renameSync(`${this.checkpointPath}.tmp`, this.checkpointPath);
  }

  /** When the fill has reached the blocks the chain poll added, the two are one. */
  private join(): void {
    const { live, through } = this.checkpoint;
    if (live && through >= live.from - 1) {
      this.checkpoint.through = Math.max(through, live.through);
      delete this.checkpoint.live;
    }
  }

  /**
   * The pools the chain poll found from block `from` through `to`, which it reads anyway. Blocks already in the index are
   * left out, so a poll read again after a restart adds nothing twice.
   */
  addLive(from: number, to: number, pools: readonly IndexedPool[]): void {
    const { through, live } = this.checkpoint;
    const have = live && from <= live.through + 1 ? live.through : through >= from - 1 ? through : from - 1;
    if (to <= have) return;
    this.append(pools.filter((pool) => pool.block > have && pool.block <= to));
    if (!live && through >= from - 1) this.checkpoint.through = to;
    else if (live && from <= live.through + 1) live.through = to;
    else this.checkpoint.live = { from: Math.max(from, have + 1), through: to };
    this.join();
    this.save();
  }

  /**
   * Fills the index from its checkpoint to the chain's head, or to where the chain poll took over, a piece of `PIECE`
   * blocks a request, `FILL_AT_ONCE` at a time and `FILL_GAP_MS` apart, through `reader`, which should be a private
   * endpoint alone. A piece that fails is tried again until it is read; pieces are written in block order.
   */
  async fill(reader: ChainHistory, { piece = PIECE, atOnce = FILL_AT_ONCE, gap = FILL_GAP_MS, sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)) } = {}): Promise<void> {
    const head = Number(await reader.getBlockNumber());
    const stop = () => (this.checkpoint.live ? this.checkpoint.live.from - 1 : Math.max(head, this.checkpoint.through));
    const started = Date.now();
    this.filling = { through: this.checkpoint.through, target: stop(), requests: 0, startedAt: new Date(started).toISOString() };
    if (this.checkpoint.through < stop()) this.say(`pool index: filling blocks ${this.checkpoint.through + 1} to ${stop()}, ${atOnce} requests at a time.`);
    const done = new Map<number, { to: number; pools: IndexedPool[] }>();
    let next = this.checkpoint.through + 1;
    let nextStart = 0;
    let lastSaid = this.checkpoint.through;
    let lastSaved = Date.now();
    const turn = async () => {
      const now = Date.now();
      const wait = Math.max(0, nextStart - now);
      nextStart = Math.max(now, nextStart) + gap;
      if (wait > 0) await sleep(wait);
    };
    const flush = () => {
      for (let piece = done.get(this.checkpoint.through + 1); piece; piece = done.get(this.checkpoint.through + 1)) {
        done.delete(this.checkpoint.through + 1);
        const end = Math.min(piece.to, stop());
        this.append(piece.pools.filter((pool) => pool.block <= end));
        this.checkpoint.through = end;
        this.join();
        if (piece.to > end) break;
      }
      this.filling!.through = this.checkpoint.through;
      if (Date.now() - lastSaved > 2_000) {
        this.save();
        lastSaved = Date.now();
      }
      if (this.checkpoint.through - lastSaid >= 10_000_000) {
        lastSaid = this.checkpoint.through;
        this.say(`pool index: through block ${this.checkpoint.through} of ${stop()}, ${this.checkpoint.pools.toLocaleString("en-US")} pools, ${this.filling!.requests} requests.`);
      }
    };
    const worker = async () => {
      while (next <= stop()) {
        const from = next;
        const to = Math.min(from + piece - 1, stop());
        next = to + 1;
        for (let tries = 1; ; tries++) {
          await turn();
          this.filling!.requests++;
          try {
            done.set(from, { to, pools: await poolsIn(reader, BigInt(from), BigInt(to)) });
            break;
          } catch {
            // The error itself can carry the endpoint's address, so the log says only that the piece keeps failing.
            if (tries % 10 === 0) this.say(`pool index: blocks ${from} to ${to} failed ${tries} times and are tried again.`);
            await sleep(Math.min(30_000, 1_000 * tries));
          }
        }
        flush();
      }
    };
    await Promise.all(Array.from({ length: atOnce }, worker));
    flush();
    this.save();
    this.sort();
    this.filled = !this.checkpoint.live;
    this.filling.doneAt = new Date().toISOString();
    this.say(`pool index: complete through block ${this.checkpoint.through}, ${this.checkpoint.pools.toLocaleString("en-US")} pools, ${this.filling.requests} requests in ${Math.round((Date.now() - started) / 1000)} s.`);
  }

  /** Whether every pool through a recent block is in the index. */
  get ready(): boolean {
    return this.filled && !this.checkpoint.live;
  }

  get through(): number {
    return this.checkpoint.through;
  }

  status(): { ready: boolean; through: number; pools: number; bytes: number; fill?: FillStatus } {
    return { ready: this.ready, through: this.checkpoint.through, pools: this.checkpoint.pools, bytes: this.size, ...(this.filling ? { fill: this.filling } : {}) };
  }

  /** The pools between two of ETH, WETH and USDG. */
  basePools(): IndexedPool[] {
    return [...this.bases];
  }

  /** Every pool with `token` on one side, `token` not being ETH, WETH or USDG, oldest first. */
  poolsOf(token: Address): IndexedPool[] {
    if (this.count - this.sorted > TAIL) this.sort();
    const [hi, lo] = prefix(token.toLowerCase());
    const offsets: number[] = [];
    let low = 0;
    let high = this.sorted;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.hi[middle]! < hi || (this.hi[middle] === hi && this.lo[middle]! < lo)) low = middle + 1;
      else high = middle;
    }
    for (let i = low; i < this.sorted && this.hi[i] === hi && this.lo[i] === lo; i++) offsets.push(this.at[i]!);
    for (let i = this.sorted; i < this.count; i++) if (this.hi[i] === hi && this.lo[i] === lo) offsets.push(this.at[i]!);
    const line = Buffer.alloc(MAX_LINE);
    const seen = new Set<string>();
    const found: IndexedPool[] = [];
    for (const offset of offsets) {
      const read = readSync(this.fd, line, 0, MAX_LINE, offset);
      const text = line.toString("latin1", 0, read);
      const pool = JSON.parse(text.slice(0, text.indexOf("\n"))) as IndexedPool;
      const mine = [pool.currency0, pool.currency1].some((currency) => currency.toLowerCase() === token.toLowerCase());
      if (mine && !seen.has(pool.pool.toLowerCase())) {
        seen.add(pool.pool.toLowerCase());
        found.push(pool);
      }
    }
    return found.sort((a, b) => a.block - b.block);
  }

  close(): void {
    closeSync(this.fd);
  }
}
