import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getAddress, zeroAddress, type Address } from "viem";
import { describe, expect, it } from "vitest";

import type { ChainHistory } from "../history.js";
import { USDG, WETH } from "../marketcap.js";
import { CHECKPOINT_FILE, INDEX_FROM, PoolIndex, POOLS_FILE, type IndexedPool, type PoolLog } from "./pools.js";

const TOKEN = getAddress("0x7fe995a80075df3dc8ae11a9b82c7fe4202cd87f");
const OTHER = getAddress("0x3fb8976980d486084b2eb4a404bd12e72823958f");
const HOOKS = getAddress("0x00000000000000000000000000000000000000c0");
const id = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;
const v3 = (block: number, token0: Address, token1: Address, pool: Address): PoolLog => ({ eventName: "PoolCreated", blockNumber: BigInt(block), args: { token0, token1, fee: 3_000, tickSpacing: 60, pool } });
const v4 = (block: number, currency0: Address, currency1: Address, n: number, hooks: Address = zeroAddress): PoolLog => ({
  eventName: "Initialize",
  blockNumber: BigInt(block),
  args: { id: id(n), currency0, currency1, fee: 34_267, tickSpacing: 685, hooks },
});

const LOGS: PoolLog[] = [
  v3(INDEX_FROM + 5, WETH, USDG, getAddress("0x00000000000000000000000000000000000000a1")),
  v4(INDEX_FROM + 12_000, zeroAddress, TOKEN, 1, HOOKS),
  v3(INDEX_FROM + 25_000, OTHER, TOKEN, getAddress("0x00000000000000000000000000000000000000a2")),
  v4(INDEX_FROM + 31_000, TOKEN, USDG, 2),
];

/** Robinhood Chain as the fill meets it: the pool logs in each range asked for, the earlier pieces answering later. */
function chain(head: number, logs = LOGS, failOnce?: number) {
  const asked: [number, number][] = [];
  let failed = false;
  const reader = {
    getBlockNumber: async () => BigInt(head),
    async getLogs({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) {
      asked.push([Number(fromBlock), Number(toBlock)]);
      if (Number(fromBlock) === failOnce && !failed) {
        failed = true;
        throw new Error("busy");
      }
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, 20 - asked.length * 5)));
      return logs.filter(({ blockNumber }) => blockNumber >= fromBlock && blockNumber <= toBlock);
    },
  } as unknown as ChainHistory;
  return { reader, asked };
}

const dir = () => mkdtempSync(join(tmpdir(), "pools-"));
const fast = { gap: 0, sleep: async () => {} };
const lines = (where: string) => readFileSync(join(where, POOLS_FILE), "utf8").trim().split("\n").map((line) => JSON.parse(line) as IndexedPool);

describe("the pool index", () => {
  it("fills from the contracts' deployment in pieces of 10,000 blocks, several at a time, and writes them in block order", async () => {
    const where = dir();
    const index = new PoolIndex(where);
    const { reader, asked } = chain(INDEX_FROM + 34_999);
    await index.fill(reader, fast);
    expect(asked.sort((a, b) => a[0] - b[0])).toEqual([
      [INDEX_FROM, INDEX_FROM + 9_999],
      [INDEX_FROM + 10_000, INDEX_FROM + 19_999],
      [INDEX_FROM + 20_000, INDEX_FROM + 29_999],
      [INDEX_FROM + 30_000, INDEX_FROM + 34_999],
    ]);
    expect(lines(where).map(({ block }) => block)).toEqual([INDEX_FROM + 5, INDEX_FROM + 12_000, INDEX_FROM + 25_000, INDEX_FROM + 31_000]);
    expect(index.status()).toMatchObject({ ready: true, through: INDEX_FROM + 34_999, pools: 4 });
    expect(JSON.parse(readFileSync(join(where, CHECKPOINT_FILE), "utf8"))).toMatchObject({ from: INDEX_FROM, through: INDEX_FROM + 34_999, pools: 4 });
  });

  it("keeps each pool's fee, tick spacing, hooks and block, and finds a token's pools whichever side it is on", async () => {
    const index = new PoolIndex(dir());
    await index.fill(chain(INDEX_FROM + 34_999).reader, fast);
    expect(index.poolsOf(TOKEN)).toEqual([
      { version: 4, pool: id(1), currency0: zeroAddress, currency1: TOKEN, fee: 34_267, tickSpacing: 685, hooks: HOOKS, block: INDEX_FROM + 12_000 },
      { version: 3, pool: getAddress("0x00000000000000000000000000000000000000a2"), currency0: OTHER, currency1: TOKEN, fee: 3_000, tickSpacing: 60, block: INDEX_FROM + 25_000 },
      { version: 4, pool: id(2), currency0: TOKEN, currency1: USDG, fee: 34_267, tickSpacing: 685, hooks: zeroAddress, block: INDEX_FROM + 31_000 },
    ]);
    expect(index.poolsOf(OTHER).map(({ pool }) => pool)).toEqual([getAddress("0x00000000000000000000000000000000000000a2")]);
    expect(index.poolsOf(getAddress("0x1111111111111111111111111111111111111111"))).toEqual([]);
    // A pool between two of ETH, WETH and USDG is kept whole, for ETH's own price.
    expect(index.basePools().map(({ currency0, currency1 }) => [currency0, currency1])).toEqual([[WETH, USDG]]);
  });

  it("tries a piece that fails again until it is read", async () => {
    const index = new PoolIndex(dir());
    const { reader, asked } = chain(INDEX_FROM + 19_999, LOGS, INDEX_FROM + 10_000);
    await index.fill(reader, fast);
    expect(asked.filter(([from]) => from === INDEX_FROM + 10_000)).toHaveLength(2);
    expect(index.poolsOf(TOKEN)).toHaveLength(1);
  });

  it("opens after a restart with what was saved, and drops what was written after the last checkpoint", async () => {
    const where = dir();
    const first = new PoolIndex(where);
    await first.fill(chain(INDEX_FROM + 34_999).reader, fast);
    first.close();
    appendFileSync(join(where, POOLS_FILE), `${JSON.stringify({ version: 3, pool: "0xdead", currency0: OTHER, currency1: TOKEN, fee: 1, tickSpacing: 1, block: 1 })}\n`);
    const again = new PoolIndex(where);
    expect([again.status().pools, again.poolsOf(TOKEN).length, again.ready]).toEqual([4, 3, true]);
    expect(lines(where)).toHaveLength(4);
    again.close();
    // A file shorter than its checkpoint says is not trusted: the index starts again.
    writeFileSync(join(where, POOLS_FILE), "");
    expect(new PoolIndex(where).status()).toMatchObject({ ready: false, through: INDEX_FROM - 1, pools: 0 });
  });

  it("takes the pools the chain poll finds, joins them to the fill when it reaches them, and never adds one twice", async () => {
    const where = dir();
    const index = new PoolIndex(where);
    const late = v4(INDEX_FROM + 40_005, TOKEN, WETH, 3);
    // The poll starts above the blocks the fill has reached.
    index.addLive(INDEX_FROM + 40_000, INDEX_FROM + 40_009, [late].map((log) => ({ ...poolFrom(log) })));
    expect(index.status()).toMatchObject({ ready: false, through: INDEX_FROM - 1 });
    await index.fill(chain(INDEX_FROM + 50_000, [...LOGS, late]).reader, fast);
    expect(index.status()).toMatchObject({ ready: true, through: INDEX_FROM + 40_009, pools: 5 });
    // The same poll again after a restart, and the next one.
    index.addLive(INDEX_FROM + 40_000, INDEX_FROM + 40_009, [poolFrom(late)]);
    const next = v3(INDEX_FROM + 40_012, TOKEN, USDG, getAddress("0x00000000000000000000000000000000000000a3"));
    index.addLive(INDEX_FROM + 40_010, INDEX_FROM + 40_019, [poolFrom(next)]);
    expect(index.status()).toMatchObject({ through: INDEX_FROM + 40_019, pools: 6 });
    expect(index.poolsOf(TOKEN).map(({ block }) => block)).toEqual([INDEX_FROM + 12_000, INDEX_FROM + 25_000, INDEX_FROM + 31_000, INDEX_FROM + 40_005, INDEX_FROM + 40_012]);
  });
});

const poolFrom = (log: PoolLog): IndexedPool =>
  log.eventName === "PoolCreated"
    ? { version: 3, pool: log.args.pool, currency0: log.args.token0, currency1: log.args.token1, fee: log.args.fee, tickSpacing: log.args.tickSpacing, block: Number(log.blockNumber) }
    : { version: 4, pool: log.args.id, currency0: log.args.currency0, currency1: log.args.currency1, fee: log.args.fee, tickSpacing: log.args.tickSpacing, hooks: log.args.hooks, block: Number(log.blockNumber) };
