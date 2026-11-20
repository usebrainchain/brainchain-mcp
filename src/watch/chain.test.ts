import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, getAddress, InvalidInputRpcError, keccak256, parseAbi, parseAbiParameters, RpcRequestError, zeroAddress, type Address, type Hash, type Hex } from "viem";
import { describe, expect, it } from "vitest";

import type { ChainHistory } from "../history.js";
import { MARKET_MAKERS, type Approval } from "../makers.js";
import { QUEUED_TOPIC, type QueuedPool } from "../queued.js";
import { chainFirsts, chainKept, chainPoller, SPAN, type Firsts, type Receipt } from "./chain.js";
import { EventLog } from "./events.js";
import type { IndexedPool } from "./pools.js";
import { StateFile } from "./state.js";
import { Watcher } from "./watcher.js";

const WINTERMUTE = MARKET_MAKERS[0]!;
const B2C2 = MARKET_MAKERS[3]!;
const CASHCAT = "0x020bfC650A365f8BB26819deAAbF3E21291018b4" as Address;
const PONS = getAddress("0x0000000000000000000000000000000000000b0b");
const RANDOM = getAddress("0x00000000000000000000000000000000000000aa");
const WETH = getAddress("0x0bd7d308f8e1639fab988df18a8011f41eacad73");
const USDG = getAddress("0x5fc5360d0400a0fd4f2af552add042d716f1d168");
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hash;

interface Log {
  address: Address;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: Hash;
  eventName: string;
  args: Record<string, unknown>;
}

const tokenAbi = parseAbi(["function decimals() view returns (uint8)", "function totalSupply() view returns (uint256)", "function name() view returns (string)", "function symbol() view returns (string)"]);
const NAMES: Record<string, [string, string]> = { [CASHCAT.toLowerCase()]: ["Cash Cat", "CASHCAT"], [PONS.toLowerCase()]: ["Pons", "PONS"] };

/** Robinhood Chain as the endpoint answers it, holding `logs`, refusing any search of more than `most` blocks as too full. */
function endpoint(logs: Log[], { newest = 1_000n, most = Number.MAX_SAFE_INTEGER, from = {} as Record<Hash, Address>, registry = [] as Raw[] } = {}) {
  const searched: { from: bigint; to: bigint; what: string }[] = [];
  const reader = {
    getBlockNumber: async () => newest,
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ timestamp: 1_790_000_000n + blockNumber }),
    getTransaction: async ({ hash: sent }: { hash: Hash }) => ({ from: from[sent] ?? RANDOM, to: RANDOM }),
    getCode: async () => "0x6000" as Hex,
    readContract: async ({ args }: { args: [{ target: Address; callData: Hex }[]] }) =>
      args[0].map(({ target, callData }) => {
        const { functionName } = decodeFunctionData({ abi: tokenAbi, data: callData });
        const [name, symbol] = NAMES[target.toLowerCase()] ?? ["", ""];
        const result = { decimals: 18, totalSupply: 10n ** 27n, name, symbol }[functionName];
        return { success: true, returnData: encodeFunctionResult({ abi: tokenAbi, functionName, result: result as never }) };
      }),
    getLogs: async (params: { address?: Address | Address[]; event?: { name: string }; events?: unknown[]; args?: Record<string, Address | Address[]>; fromBlock: bigint; toBlock: bigint }) => {
      const what = params.events ? "pools" : params.event ? params.event.name : "registry";
      if (what === "registry") {
        searched.push({ from: params.fromBlock, to: params.toBlock, what });
        return registry.filter(({ blockNumber }) => blockNumber >= params.fromBlock && blockNumber <= params.toBlock);
      }
      searched.push({ from: params.fromBlock, to: params.toBlock, what });
      if (params.toBlock - params.fromBlock + 1n > BigInt(most)) throw new InvalidInputRpcError(new RpcRequestError({ body: {}, error: { code: -32000, message: "logs matched by query exceeds limit of 10000" }, url: "https://rpc.example" }));
      const wanted = (log: Log) => {
        if (log.blockNumber < params.fromBlock || log.blockNumber > params.toBlock) return false;
        if (what === "pools") return log.eventName === "PoolCreated" || log.eventName === "Initialize";
        if (log.eventName !== what) return false;
        if (params.address && !Array.isArray(params.address) && log.address.toLowerCase() !== params.address.toLowerCase()) return false;
        return Object.entries(params.args ?? {}).every(([name, value]) => [value].flat().some((one) => one.toLowerCase() === String(log.args[name]).toLowerCase()));
      };
      return logs.filter(wanted);
    },
  };
  return { reader: reader as unknown as ChainHistory, searched };
}

const v4 = (block: bigint, currency0: Address, currency1: Address): Log => ({
  address: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
  blockNumber: block,
  logIndex: 0,
  transactionHash: hash(Number(block)),
  eventName: "Initialize",
  args: { id: hash(9000 + Number(block)), currency0, currency1, fee: 3000, tickSpacing: 60, hooks: zeroAddress },
});
const v3 = (block: bigint, token0: Address, token1: Address): Log => ({
  address: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA",
  blockNumber: block,
  logIndex: 1,
  transactionHash: hash(Number(block)),
  eventName: "PoolCreated",
  args: { token0, token1, fee: 500, tickSpacing: 10, pool: RANDOM },
});
const approval = (block: bigint, token: Address, owner: Address, value = 1n): Log => ({ address: token, blockNumber: block, logIndex: 2, transactionHash: hash(50_000 + Number(block)), eventName: "Approval", args: { owner, spender: RANDOM, value } });
const transfer = (block: bigint, token: Address, to: Address, value = 10n ** 18n, sender: Address = RANDOM): Log => ({ address: token, blockNumber: block, logIndex: 3, transactionHash: hash(70_000 + Number(block)), eventName: "Transfer", args: { from: sender, to, value } });

/** A log of Wintermute's role registry, as the endpoint returns it with no event to decode it by. */
interface Raw {
  topics: Hex[];
  data: Hex;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: Hash;
}

/** Firsts that answer from a table, and count how often they were asked. */
function table(approvals: Record<string, Approval> = {}, receipts: Record<string, Receipt | "earlier"> = {}, queued: Record<string, QueuedPool> = {}) {
  const asked: string[] = [];
  const firsts: Firsts = {
    approval: async (token, maker) => (asked.push(`approval:${token}:${maker.wallet}`), approvals[`${token}:${maker.wallet}`]),
    receipt: async (token, maker) => (asked.push(`receipt:${token}:${maker.wallet}`), receipts[`${token}:${maker.wallet}`]),
    queued: async (token, maker) => (asked.push(`queued:${token}:${maker.wallet}`), queued[`${token}:${maker.wallet}`]),
  };
  return { firsts, asked };
}

function harness(reader: ChainHistory, firsts: Firsts, watched: Address[] = [CASHCAT, PONS]) {
  const dir = mkdtempSync(join(tmpdir(), "brainchain-watch-"));
  const log = new EventLog(dir);
  const state = new StateFile(dir);
  const indexed: [number, number, IndexedPool[]][] = [];
  const poller = chainPoller({ reader, wallets: MARKET_MAKERS, watched: () => new Set(watched.map((address) => address.toLowerCase())), firsts, onPools: (from, to, pools) => indexed.push([from, to, pools]) });
  const watcher = new Watcher({ log, state, pollers: [poller], say: (line) => process.env.DEBUG_WATCH && console.log(line) });
  return { log, state, indexed, run: () => watcher.runOnce(poller) };
}

describe("the chain poller", () => {
  it("only notes the newest block on its first read: everything before it is the baseline", async () => {
    const { reader, searched } = endpoint([v4(10n, zeroAddress, CASHCAT)], { newest: 500n });
    const { log, state, run } = harness(reader, table().firsts);
    expect(await run()).toBe(15_000);
    expect(state.source("chain")).toMatchObject({ block: 500, startBlock: 500, baselined: true });
    expect(searched).toEqual([]);
    expect(log.size).toBe(0);
  });

  it("reports a new pool for a token with a public trace, paired with ETH, WETH, USDG or another such token, and never for the base", async () => {
    const { reader } = endpoint([v4(10n, zeroAddress, CASHCAT), v3(11n, PONS, WETH), v4(12n, CASHCAT, RANDOM), v4(13n, RANDOM, USDG), v4(14n, PONS, CASHCAT), v3(15n, USDG, WETH)], { newest: 0n });
    const { log, state, indexed, run } = harness(reader, table().firsts);
    await run();
    state.source("chain").block = 0;
    (reader as { getBlockNumber: () => Promise<bigint> }).getBlockNumber = async () => 20n;
    await run();
    // Every pool in the blocks read goes to the pool index, whether or not it is reported.
    expect(indexed.map(([from, to, pools]) => [from, to, pools.map(({ version, block }) => `v${version}@${block}`)])).toEqual([[1, 20, ["v4@10", "v3@11", "v4@12", "v4@13", "v4@14", "v3@15"]]]);
    expect(log.all().map(({ kind, token, source, detail }) => [kind, token.symbol, source, detail.pairedWith, detail.block])).toEqual([
      ["pool.created", "CASHCAT", "Uniswap v4", "ETH", 10],
      ["pool.created", "PONS", "Uniswap v3", WETH, 11],
      ["pool.created", "PONS", "Uniswap v4", CASHCAT, 14],
      ["pool.created", "CASHCAT", "Uniswap v4", PONS, 14],
    ]);
    const [eth] = log.all();
    expect(eth).toMatchObject({ ref: hash(10), at: new Date((1_790_000_000 + 10) * 1000).toISOString(), token: { address: CASHCAT, name: "Cash Cat" }, detail: { venue: "Uniswap v4", pool: hash(9010), fee: 3000, tickSpacing: 60, hooks: zeroAddress, transaction: hash(10) } });
    expect(eth!.baseline).toBeUndefined();
  });

  it("reports a followed wallet's first approval of a token, records one made before the blocks read as baseline, and settles each pair once", async () => {
    const logs = [approval(105n, CASHCAT, WINTERMUTE.wallet), approval(106n, CASHCAT, WINTERMUTE.wallet), approval(107n, PONS, B2C2.wallet), approval(108n, RANDOM, B2C2.wallet, 0n)];
    const first = (block: number): Approval => ({ at: "2026-08-05T00:00:00.000Z", block, transaction: hash(block), spender: RANDOM, confirmed: block === 105 });
    const { firsts, asked } = table({ [`${CASHCAT}:${WINTERMUTE.wallet}`]: first(105), [`${PONS}:${B2C2.wallet}`]: first(7) });
    const { reader } = endpoint(logs, { newest: 100n });
    const { log, run } = harness(reader, firsts);
    await run();
    (reader as { getBlockNumber: () => Promise<bigint> }).getBlockNumber = async () => 200n;
    await run();
    expect(asked).toEqual([`approval:${CASHCAT}:${WINTERMUTE.wallet}`, `approval:${PONS}:${B2C2.wallet}`]);
    expect(log.all().map(({ kind, token, detail, baseline }) => [kind, token.symbol, (detail.maker as { name: string }).name, detail.block, detail.confirmed, baseline === true])).toEqual([
      ["maker.approval", "CASHCAT", "Wintermute", 105, true, false],
      ["maker.approval", "PONS", "B2C2", 7, false, true],
    ]);
    await run();
    expect(asked).toHaveLength(2);
  });

  it("never asks about a wallet's ETH, WETH or USDG", async () => {
    const { firsts, asked } = table();
    const { reader } = endpoint([transfer(150n, WETH, WINTERMUTE.wallet), transfer(151n, USDG, B2C2.wallet), approval(152n, USDG, WINTERMUTE.wallet)], { newest: 100n });
    const { log, run } = harness(reader, firsts);
    await run();
    (reader as { getBlockNumber: () => Promise<bigint> }).getBlockNumber = async () => 200n;
    await run();
    expect([asked, log.size]).toEqual([[], 0]);
  });

  it("reports a followed wallet's first receipt of a token, counted in tokens, and settles a token it had received before quietly", async () => {
    const receipt: Receipt = { at: "2026-08-05T00:00:00.000Z", block: 150, transaction: hash(1), from: RANDOM, value: 25n * 10n ** 17n, confirmed: false };
    const { firsts, asked } = table({}, { [`${CASHCAT}:${WINTERMUTE.wallet}`]: receipt, [`${PONS}:${WINTERMUTE.wallet}`]: "earlier" });
    const { reader } = endpoint([transfer(150n, CASHCAT, WINTERMUTE.wallet), transfer(151n, CASHCAT, WINTERMUTE.wallet), transfer(152n, PONS, WINTERMUTE.wallet), transfer(153n, PONS, WINTERMUTE.wallet)], { newest: 100n });
    const { log, state, run } = harness(reader, firsts);
    await run();
    (reader as { getBlockNumber: () => Promise<bigint> }).getBlockNumber = async () => 200n;
    await run();
    expect(log.all().map(({ kind, detail }) => [kind, detail.amount, detail.from, detail.confirmed])).toEqual([["maker.receipt", "2.5", RANDOM, false]]);
    expect(asked).toEqual([`receipt:${CASHCAT}:${WINTERMUTE.wallet}`, `receipt:${PONS}:${WINTERMUTE.wallet}`]);
    expect(state.source("chain").settled).toEqual([`receipt:${CASHCAT.toLowerCase()}:${WINTERMUTE.wallet.toLowerCase()}`, `receipt:${PONS.toLowerCase()}:${WINTERMUTE.wallet.toLowerCase()}`]);
  });

  it("reads at most SPAN blocks at a time, halves a range the endpoint finds too full, and says when it is behind", async () => {
    const { reader, searched } = endpoint([v4(7_500n, zeroAddress, CASHCAT)], { newest: 0n, most: 5_000 });
    const { log, state, run } = harness(reader, table().firsts);
    await run();
    (reader as { getBlockNumber: () => Promise<bigint> }).getBlockNumber = async () => 100_000n;
    expect(await run()).toBe(0);
    expect(state.source("chain").block).toBe(Number(SPAN));
    expect(searched.filter(({ what }) => what === "pools").map(({ from, to }) => [from, to])).toEqual([
      [1n, 10_000n],
      [1n, 5_000n],
      [5_001n, 10_000n],
    ]);
    expect(log.size).toBe(1);
  });
});

const V4_ROLE = "0x5263548a00b59cb6c934d41cb5675ea69ca2942902d0bf0404b56ad33038016d" as Hash;
const poolKey = (currency0: Address, currency1: Address) => encodeAbiParameters(parseAbiParameters("address, address, uint24, int24, address"), [currency0, currency1, 3000, 60, zeroAddress]);
/** Wintermute's multisig queuing a v4 pool on its registry, as the registry logs it: the account is the start of the pool's id. */
const queuedLog = (block: bigint, currency0: Address, currency1: Address): Raw => ({
  topics: [QUEUED_TOPIC, hash(90_000 + Number(block))],
  data: encodeAbiParameters(parseAbiParameters("bytes32, address, bytes"), [V4_ROLE, getAddress(keccak256(poolKey(currency0, currency1)).slice(0, 42)), poolKey(currency0, currency1)]),
  blockNumber: block,
  logIndex: 0,
  transactionHash: hash(80_000 + Number(block)),
});
const first = (block: number, currency0: Address, currency1: Address): QueuedPool => ({
  at: new Date((1_790_000_000 + block) * 1000).toISOString(),
  block,
  transaction: hash(80_000 + block),
  venue: "Uniswap v4",
  pool: keccak256(poolKey(currency0, currency1)),
  currency0,
  currency1,
  fee: 3000,
  role: V4_ROLE,
  confirmed: true,
});

describe("a market maker's queued pool", () => {
  it("is reported the first time a token's pool is queued, recorded as baseline when that was before the blocks read, and settled once", async () => {
    const registry = [queuedLog(105n, CASHCAT, USDG), queuedLog(106n, zeroAddress, PONS), queuedLog(107n, CASHCAT, WETH)];
    const { reader, searched } = endpoint([], { newest: 100n, registry });
    const { firsts, asked } = table({}, {}, { [`${CASHCAT}:${WINTERMUTE.wallet}`]: first(105, CASHCAT, USDG), [`${PONS}:${WINTERMUTE.wallet}`]: first(50, zeroAddress, PONS) });
    const { log, run } = harness(reader, firsts);
    await run();
    (reader as { getBlockNumber: () => Promise<bigint> }).getBlockNumber = async () => 200n;
    await run();
    expect(log.all().map(({ kind, token, ref, at, detail, baseline }) => ({ kind, symbol: token.symbol, ref, at, detail, baseline }))).toEqual([
      {
        kind: "maker.pool_queued",
        symbol: "CASHCAT",
        ref: hash(80_105),
        at: new Date((1_790_000_000 + 105) * 1000).toISOString(),
        detail: { maker: { name: "Wintermute", tag: "Market Maker: 0x51c7...2a7f", wallet: WINTERMUTE.wallet }, venue: "Uniswap v4", pool: keccak256(poolKey(CASHCAT, USDG)), pairedWith: USDG, fee: 3000, confirmed: true, block: 105, transaction: hash(80_105) },
        baseline: undefined,
      },
      {
        kind: "maker.pool_queued",
        symbol: "PONS",
        ref: hash(80_050),
        at: new Date((1_790_000_000 + 50) * 1000).toISOString(),
        detail: { maker: { name: "Wintermute", tag: "Market Maker: 0x51c7...2a7f", wallet: WINTERMUTE.wallet }, venue: "Uniswap v4", pool: keccak256(poolKey(zeroAddress, PONS)), pairedWith: "ETH", fee: 3000, confirmed: true, block: 50, transaction: hash(80_050) },
        baseline: true,
      },
    ]);
    // USDG, WETH and ETH are never news, and the second Cash Cat pool is settled by the first.
    expect(asked.filter((entry) => entry.startsWith("queued"))).toEqual([`queued:${CASHCAT}:${WINTERMUTE.wallet}`, `queued:${PONS}:${WINTERMUTE.wallet}`]);
    // One search of the one registry the followed wallets have, over the blocks read.
    expect(searched.filter(({ what }) => what === "registry").map(({ from, to }) => [from, to])).toEqual([[101n, 200n]]);
    await run();
    expect(log.size).toBe(2);
  });
});

describe("a wallet's first receipt", () => {
  it("is its first transfer in of the token within the blocks read, confirmed when the wallet sent the transaction", async () => {
    const own = hash(70_000 + 40);
    const { reader } = endpoint([transfer(30n, CASHCAT, B2C2.wallet, 0n), transfer(40n, CASHCAT, WINTERMUTE.wallet, 5n), transfer(41n, CASHCAT, WINTERMUTE.wallet, 7n)], { from: { [own]: WINTERMUTE.wallet } });
    const firsts = chainFirsts(reader, chainKept());
    expect(await firsts.receipt(CASHCAT, WINTERMUTE, 35n, 50n)).toEqual({ at: new Date((1_790_000_000 + 40) * 1000).toISOString(), block: 40, transaction: own, from: RANDOM, value: 5n, confirmed: true });
    expect(await firsts.receipt(CASHCAT, B2C2, 0n, 50n)).toBeUndefined();
  });

  it("is earlier when the wallet had received the token before, which a stretch too full to search proves", async () => {
    const { reader, searched } = endpoint([transfer(40n, CASHCAT, WINTERMUTE.wallet, 5n), transfer(41n, CASHCAT, WINTERMUTE.wallet, 7n)], { most: 5 });
    expect(await chainFirsts(reader, chainKept()).receipt(CASHCAT, WINTERMUTE, 41n, 50n)).toBe("earlier");
    // Not one range was halved to find when.
    expect(searched.filter(({ to, from }) => to - from < 5n)).toEqual([]);
  });

  it("is looked for back from the blocks read, in ranges that grow, so a wallet that trades the token is settled by the first", async () => {
    const { reader, searched } = endpoint([transfer(5_000_000n, CASHCAT, WINTERMUTE.wallet), transfer(8_950_000n, PONS, WINTERMUTE.wallet)], { newest: 20_000_000n });
    const firsts = chainFirsts(reader, chainKept());
    expect(await firsts.receipt(PONS, WINTERMUTE, 9_000_000n, 9_000_100n)).toBe("earlier");
    expect(searched.map(({ from, to }) => [from, to])).toEqual([
      [8_990_000n, 8_999_999n],
      [8_890_000n, 8_989_999n],
    ]);
    searched.length = 0;
    expect(await firsts.receipt(CASHCAT, WINTERMUTE, 9_000_000n, 9_000_100n)).toBe("earlier");
    expect(searched.map(({ from, to }) => [from, to])).toEqual([
      [8_990_000n, 8_999_999n],
      [8_890_000n, 8_989_999n],
      [7_890_000n, 8_889_999n],
      [0n, 7_889_999n],
    ]);
  });
});

describe("a chain read cut short", () => {
  it("keeps the pairs it settled, so the next try does not ask for them again", async () => {
    const asked: string[] = [];
    let fail = true;
    const firsts: Firsts = {
      approval: async (token) => (asked.push(token), { at: "2026-08-05T00:00:00.000Z", block: 105, transaction: hash(105), spender: RANDOM, confirmed: true }),
      receipt: async () => {
        if (fail) throw new Error("429");
        return undefined;
      },
      queued: async () => undefined,
    };
    const { reader } = endpoint([approval(105n, CASHCAT, WINTERMUTE.wallet), transfer(106n, PONS, WINTERMUTE.wallet)], { newest: 100n });
    const { log, state, run } = harness(reader, firsts);
    await run();
    (reader as { getBlockNumber: () => Promise<bigint> }).getBlockNumber = async () => 200n;
    await run();
    expect(state.source("chain").block).toBe(100);
    expect(log.size).toBe(1);
    fail = false;
    await run();
    expect(asked).toEqual([CASHCAT]);
    expect(state.source("chain").block).toBe(200);
  });
});
