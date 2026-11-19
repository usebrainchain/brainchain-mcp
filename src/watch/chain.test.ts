import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decodeFunctionData, encodeFunctionResult, getAddress, InvalidInputRpcError, parseAbi, RpcRequestError, zeroAddress, type Address, type Hash, type Hex } from "viem";
import { describe, expect, it } from "vitest";

import type { ChainHistory } from "../history.js";
import { MARKET_MAKERS, type Approval } from "../makers.js";
import { chainFirsts, chainKept, chainPoller, SPAN, type Firsts, type Receipt } from "./chain.js";
import { EventLog } from "./events.js";
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
function endpoint(logs: Log[], { newest = 1_000n, most = Number.MAX_SAFE_INTEGER, from = {} as Record<Hash, Address> } = {}) {
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
      const what = params.events ? "pools" : params.event!.name;
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

/** Firsts that answer from a table, and count how often they were asked. */
function table(approvals: Record<string, Approval> = {}, receipts: Record<string, Receipt> = {}) {
  const asked: string[] = [];
  const firsts: Firsts = {
    approval: async (token, maker) => (asked.push(`approval:${token}:${maker.wallet}`), approvals[`${token}:${maker.wallet}`]),
    receipt: async (token, maker) => (asked.push(`receipt:${token}:${maker.wallet}`), receipts[`${token}:${maker.wallet}`]),
  };
  return { firsts, asked };
}

function harness(reader: ChainHistory, firsts: Firsts, watched: Address[] = [CASHCAT, PONS]) {
  const dir = mkdtempSync(join(tmpdir(), "brainchain-watch-"));
  const log = new EventLog(dir);
  const state = new StateFile(dir);
  const poller = chainPoller({ reader, wallets: MARKET_MAKERS, watched: () => new Set(watched.map((address) => address.toLowerCase())), firsts });
  const watcher = new Watcher({ log, state, pollers: [poller], say: (line) => process.env.DEBUG_WATCH && console.log(line) });
  return { log, state, run: () => watcher.runOnce(poller) };
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
    const { log, state, run } = harness(reader, table().firsts);
    await run();
    state.source("chain").block = 0;
    (reader as { getBlockNumber: () => Promise<bigint> }).getBlockNumber = async () => 20n;
    await run();
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

  it("reports a followed wallet's first receipt of a token, counted in tokens", async () => {
    const receipt: Receipt = { at: "2026-08-05T00:00:00.000Z", block: 150, transaction: hash(1), from: RANDOM, value: 25n * 10n ** 17n, confirmed: false };
    const { firsts } = table({}, { [`${CASHCAT}:${WINTERMUTE.wallet}`]: receipt });
    const { reader } = endpoint([transfer(150n, CASHCAT, WINTERMUTE.wallet), transfer(151n, CASHCAT, WINTERMUTE.wallet)], { newest: 100n });
    const { log, run } = harness(reader, firsts);
    await run();
    (reader as { getBlockNumber: () => Promise<bigint> }).getBlockNumber = async () => 200n;
    await run();
    expect(log.all().map(({ kind, detail }) => [kind, detail.amount, detail.from, detail.confirmed])).toEqual([["maker.receipt", "2.5", RANDOM, false]]);
  });

  it("reads at most SPAN blocks at a time, halves a range the endpoint finds too full, and says when it is behind", async () => {
    const { reader, searched } = endpoint([v4(25_000n, zeroAddress, CASHCAT)], { newest: 0n, most: 20_000 });
    const { log, state, run } = harness(reader, table().firsts);
    await run();
    (reader as { getBlockNumber: () => Promise<bigint> }).getBlockNumber = async () => 100_000n;
    expect(await run()).toBe(0);
    expect(state.source("chain").block).toBe(Number(SPAN));
    expect(searched.filter(({ what }) => what === "pools").map(({ from, to }) => [from, to])).toEqual([
      [1n, 30_000n],
      [1n, 15_000n],
      [15_001n, 30_000n],
    ]);
    expect(log.size).toBe(1);
  });
});

describe("a wallet's first receipt", () => {
  it("is its first transfer in of the token, confirmed when the wallet sent the transaction", async () => {
    const own = hash(70_000 + 40);
    const { reader } = endpoint([transfer(30n, CASHCAT, B2C2.wallet, 0n), transfer(40n, CASHCAT, WINTERMUTE.wallet, 5n), transfer(41n, CASHCAT, WINTERMUTE.wallet, 7n)], { from: { [own]: WINTERMUTE.wallet } });
    const firsts = chainFirsts(reader, chainKept());
    expect(await firsts.receipt(CASHCAT, WINTERMUTE, 1_000n)).toEqual({ at: new Date((1_790_000_000 + 40) * 1000).toISOString(), block: 40, transaction: own, from: RANDOM, value: 5n, confirmed: true });
    expect(await firsts.receipt(CASHCAT, B2C2, 1_000n)).toBeUndefined();
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
