import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, getAddress, keccak256, parseAbi, parseAbiParameters, toHex, zeroAddress, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";

import { ChainError, type ChainHistory } from "../history.js";
import { USDG, WETH } from "../marketcap.js";
import { MULTICALL3 } from "../premiums.js";
import { UNISWAP_V4 } from "../readiness.js";
import { INDEX_FROM, PoolIndex, type PoolLog } from "./pools.js";
import { indexedWorth } from "./worth.js";

const TOKEN = getAddress("0xaaaa000000000000000000000000000000000001");
const ETHY = getAddress("0xaaaa000000000000000000000000000000000002");
const DEAD = getAddress("0xaaaa000000000000000000000000000000000003");
const LONE = getAddress("0xaaaa000000000000000000000000000000000004");
const V3_USDG = getAddress("0x00000000000000000000000000000000000000a2");
const V3_ETH_USDG = getAddress("0x00000000000000000000000000000000000000a1");
const id = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;
const HEAD = 118_000_000n;
const Q96 = 1n << 96n;
const abi = parseAbi([
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function slot0() view returns (uint160)",
  "function liquidity() view returns (uint128)",
]);

interface Pooled {
  log: PoolLog;
  sqrtPriceX96: bigint;
  liquidity: bigint;
  swappedAt?: bigint;
}
const at = INDEX_FROM + 100;
const v3 = (token0: Address, token1: Address, pool: Address): PoolLog => ({ eventName: "PoolCreated", blockNumber: BigInt(at), args: { token0, token1, fee: 500, tickSpacing: 10, pool } });
const v4 = (currency0: Address, currency1: Address, n: number, hooks: Address = zeroAddress): PoolLog => ({ eventName: "Initialize", blockNumber: BigInt(at), args: { id: id(n), currency0, currency1, fee: 34_267, tickSpacing: 685, hooks } });

const POOLS: Pooled[] = [
  // The deepest USDG pool has never traded, so its price is only what it was opened at.
  { log: v4(USDG, TOKEN, 1, getAddress("0x00000000000000000000000000000000000000c0")), sqrtPriceX96: 2n * Q96, liquidity: 10n ** 18n },
  { log: v3(USDG, TOKEN, V3_USDG), sqrtPriceX96: Q96, liquidity: 50_000n * 10n ** 6n, swappedAt: HEAD - 100n },
  // Deeper still, but paired with ETH: a traded USDG pool comes first.
  { log: v4(zeroAddress, TOKEN, 3), sqrtPriceX96: Q96, liquidity: 10n ** 30n, swappedAt: HEAD - 5n },
  { log: v4(zeroAddress, ETHY, 4), sqrtPriceX96: Q96, liquidity: 10n ** 18n, swappedAt: HEAD - 50_000n },
  { log: v3(WETH, USDG, V3_ETH_USDG), sqrtPriceX96: Q96 / 1_000n, liquidity: 10n ** 15n, swappedAt: HEAD - 1n },
  { log: v4(DEAD, USDG, 5), sqrtPriceX96: Q96, liquidity: 10n ** 9n },
];
const TOKENS: Record<string, { decimals: number; supply: bigint; symbol: string }> = {
  [TOKEN]: { decimals: 6, supply: 1_000_000n * 10n ** 6n, symbol: "TKN" },
  [ETHY]: { decimals: 18, supply: 3n * 10n ** 18n, symbol: "ETHY" },
  [DEAD]: { decimals: 6, supply: 10n ** 6n, symbol: "DEAD" },
  [LONE]: { decimals: 6, supply: 10n ** 6n, symbol: "LONE" },
};
const keyOf = ({ log }: Pooled) => (log.eventName === "PoolCreated" ? log.args.pool : log.args.id).toLowerCase();
const slotOf = (poolId: Hex, offset = 0n) => toHex(BigInt(keccak256(encodeAbiParameters(parseAbiParameters("bytes32, uint256"), [poolId, 6n]))) + offset, { size: 32 });

function chain() {
  const searched: string[] = [];
  const reader = {
    getBlockNumber: async () => HEAD,
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ timestamp: 1_790_000_000n + blockNumber / 10n }),
    getCode: async () => "0x6080",
    async getLogs({ address, args, fromBlock, toBlock }: { address: Address | Address[]; args?: { id?: Hex }; fromBlock: bigint; toBlock: bigint }) {
      if (Array.isArray(address)) return POOLS.map(({ log }) => log).filter(({ blockNumber }) => blockNumber >= fromBlock && blockNumber <= toBlock);
      const key = (address === UNISWAP_V4 ? args!.id! : address).toLowerCase();
      searched.push(key);
      const pool = POOLS.find((pooled) => keyOf(pooled) === key)!;
      return pool.swappedAt !== undefined && pool.swappedAt >= fromBlock && pool.swappedAt <= toBlock ? [{ blockNumber: pool.swappedAt }] : [];
    },
    async readContract({ address, functionName, args }: { address: Address; functionName: string; args: [unknown] }) {
      if (address === UNISWAP_V4) {
        expect(functionName).toBe("extsload");
        return (args[0] as Hex[]).map((slot) => {
          for (const pooled of POOLS) {
            if (pooled.log.eventName !== "Initialize") continue;
            if (slot === slotOf(pooled.log.args.id)) return toHex(pooled.sqrtPriceX96, { size: 32 });
            if (slot === slotOf(pooled.log.args.id, 3n)) return toHex(pooled.liquidity, { size: 32 });
          }
          return toHex(0n, { size: 32 });
        });
      }
      expect([address, functionName]).toEqual([MULTICALL3, "aggregate3"]);
      return (args[0] as { target: Address; callData: Hex }[]).map(({ target, callData }) => {
        const { functionName: called } = decodeFunctionData({ abi, data: callData });
        const token = TOKENS[target];
        const pool = POOLS.find((pooled) => keyOf(pooled) === target.toLowerCase());
        const result = token
          ? { decimals: token.decimals, totalSupply: token.supply, name: token.symbol, symbol: token.symbol }[called as "decimals"]
          : { slot0: pool!.sqrtPriceX96, liquidity: pool!.liquidity }[called as "slot0"];
        return { success: true, returnData: encodeFunctionResult({ abi, functionName: called, result: result as never }) };
      });
    },
  } as unknown as ChainHistory;
  return { reader, searched };
}

async function indexed(reader: ChainHistory) {
  const index = new PoolIndex(mkdtempSync(join(tmpdir(), "worth-")));
  await index.fill(reader, { gap: 0, sleep: async () => {} });
  return index;
}

describe("a token's worth from the pool index", () => {
  it("reads every pool's price and liquidity from state and takes the deepest that traded, a USDG pool before an ETH one", async () => {
    const { reader, searched } = chain();
    const worth = await indexedWorth(reader, TOKEN, await indexed(reader));
    expect(worth).toEqual({
      marketCapUsd: "1000000.00",
      priceUsd: "1",
      supply: "1000000",
      liquidityUsd: "100000.00",
      thin: false,
      pool: { version: "Uniswap v3", address: V3_USDG, pairedWith: USDG },
      asOf: { block: Number(HEAD), at: new Date(Number(1_790_000_000n + HEAD / 10n) * 1000).toISOString() },
    });
    // The untraded pool was searched back to the limit; the traded one stopped at its first range; the ETH pool not at all.
    expect(new Set(searched)).toEqual(new Set([id(1), V3_USDG.toLowerCase()]));
  });

  it("prices a token paired only with ETH through ETH's own USDG pool", async () => {
    const { reader } = chain();
    const worth = await indexedWorth(reader, ETHY, await indexed(reader));
    // ETH's USDG pool prices one WETH at a million USDG, and one ETHY is one ETH.
    expect(worth.pool).toEqual({ version: "Uniswap v4", id: id(4), pairedWith: "ETH" });
    expect([worth.priceUsd, worth.marketCapUsd]).toEqual(["1000000", "3000000.00"]);
  });

  it("says no pool traded when none of a token's pools did, and when it has none", async () => {
    const { reader } = chain();
    const index = await indexed(reader);
    await expect(indexedWorth(reader, DEAD, index)).rejects.toThrow(new ChainError(`No pool on Uniswap v3 or v4 that pairs ${DEAD} with USDG, ETH or WETH traded in the 3,000,000 blocks up to block ${HEAD}, so there is no price for it there.`));
    await expect(indexedWorth(reader, LONE, index)).rejects.toThrow(/^No pool on Uniswap v3 or v4 that pairs/);
  });
});
