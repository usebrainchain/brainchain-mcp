import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, getAddress, multicall3Abi, pad, parseAbi, parseAbiParameters, zeroAddress, type Address, type Hash, type Hex } from "viem";
import { describe, expect, it } from "vitest";

import { SETTLED_BLOCKS, STRETCH_BLOCKS, type ChainHistory } from "./history.js";
import { MARKET_MAKERS } from "./makers.js";
import { firstQueued, GRANTED_TOPIC, QUEUED_TOPIC, queuedKept, queuedPools } from "./queued.js";
import { UNISWAP_V3 } from "./readiness.js";

const WINTERMUTE = MARKET_MAKERS[0]!;
const REGISTRY = WINTERMUTE.registry!;
const CASHCAT = getAddress("0x020bfc650a365f8bb26819deaabf3e21291018b4");
const PONS = getAddress("0x39dbed3a2bd333467115de45665cc57f813c4571");
const USDG = getAddress("0x5fc5360d0400a0fd4f2af552add042d716f1d168");
// Cash Cat's pools as Wintermute's multisig queued them on August 3, 2026: the v3 pool with USDG at 1%, and the v4 pool
// with USDG whose id begins with the account the registry names.
const V3_POOL = getAddress("0x4b0c312ffbb068f6a0bea128759e35d94b94d0e1");
const V4_ACCOUNT = getAddress("0xa92a3df27a00a276183ff7265fd8affa11df1fe8");
const V4_ID = "0xa92a3df27a00a276183ff7265fd8affa11df1fe8bb23ddfaf13f6c879a3f818b";
const V3_ROLE = "0xd50e2949e0d46357095579ef7e1a820efe752c479a9e628a4f6af78101382606" as Hash;
const V4_ROLE = "0x5263548a00b59cb6c934d41cb5675ea69ca2942902d0bf0404b56ad33038016d" as Hash;
const OPERATOR_ROLE = "0x3f7be8bebf714c0382decb4671f241ab3611ef1ece0e9d3fd467ba0a6c73b601" as Hash;
const EXECUTOR = getAddress("0x4d9aac01e5f19d5f73f7afeb125032249183e5c0");
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hash;

interface Raw {
  topics: Hex[];
  data: Hex;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: Hash;
}

const queued = (block: bigint, role: Hash, account: Address, data: Hex, index = 0): Raw => ({
  topics: [QUEUED_TOPIC, hash(Number(block) * 10 + index)],
  data: encodeAbiParameters(parseAbiParameters("bytes32, address, bytes"), [role, account, data]),
  blockNumber: block,
  logIndex: index,
  transactionHash: hash(1_000_000 + Number(block)),
});
const granted = (block: bigint, role: Hash, account: Address): Raw => ({
  topics: [GRANTED_TOPIC, role, pad(account), pad(WINTERMUTE.safe!)],
  data: "0x",
  blockNumber: block,
  logIndex: 0,
  transactionHash: hash(2_000_000 + Number(block)),
});
const v4Key = (currency0: Address, currency1: Address, fee: number, spacing: number) => encodeAbiParameters(parseAbiParameters("address, address, uint24, int24, address"), [currency0, currency1, fee, spacing, zeroAddress]);

const poolAbi = parseAbi(["function token0() view returns (address)", "function token1() view returns (address)", "function fee() view returns (uint24)"]);

/** Robinhood Chain holding the registry's `logs` and the v3 pools in `pools`, with what was asked of it. */
function endpoint(logs: Raw[], { newest = 30_000_000n, pools = { [V3_POOL]: [CASHCAT, USDG, 10_000] } as Record<string, [Address, Address, number]>, sentTo = WINTERMUTE.safe! as Address } = {}) {
  const asked: string[] = [];
  const reader = {
    getBlockNumber: async () => newest,
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => (asked.push(`block ${blockNumber}`), { timestamp: 1_785_000_000n + blockNumber / 10n }),
    getTransaction: async ({ hash: sent }: { hash: Hash }) => (asked.push(`transaction ${sent}`), { from: EXECUTOR, to: sentTo }),
    getLogs: async ({ address, fromBlock, toBlock }: { address: Address; fromBlock: bigint; toBlock: bigint }) => {
      asked.push(`logs ${fromBlock}-${toBlock}`);
      return address.toLowerCase() === REGISTRY.toLowerCase() ? logs.filter(({ blockNumber }) => blockNumber >= fromBlock && blockNumber <= toBlock) : [];
    },
    readContract: async ({ args }: { args: [{ target: Address; callData: Hex }[]] }) => {
      asked.push(`pools ${[...new Set(args[0].map(({ target }) => target))].join(",")}`);
      return args[0].map(({ target, callData }) => {
        const pool = pools[getAddress(target)];
        if (!pool) return { success: false, returnData: "0x" };
        const { functionName } = decodeFunctionData({ abi: poolAbi, data: callData });
        const result = { token0: pool[0], token1: pool[1], fee: pool[2] }[functionName];
        return { success: true, returnData: encodeFunctionResult({ abi: poolAbi, functionName, result: result as never }) };
      });
    },
  };
  return { reader: reader as unknown as ChainHistory, asked };
}

const CASHCAT_LOGS = [
  queued(11_206_930n, OPERATOR_ROLE, EXECUTOR, "0x"),
  queued(26_953_337n, V3_ROLE, V3_POOL, UNISWAP_V3.toLowerCase() as Hex),
  queued(26_955_221n, V4_ROLE, V4_ACCOUNT, v4Key(CASHCAT, USDG, 2690, 54)),
  granted(28_411_079n, V3_ROLE, V3_POOL),
  granted(28_411_133n, V4_ROLE, V4_ACCOUNT),
];

describe("queuedPools", () => {
  it("keeps the queued roles that name a Uniswap pool, with its currencies and fee, and leaves out any other role", async () => {
    const { reader } = endpoint(CASHCAT_LOGS);
    expect(await queuedPools(reader, CASHCAT_LOGS, queuedKept())).toEqual([
      { role: V3_ROLE, account: V3_POOL, block: 26_953_337n, index: 0, transaction: hash(27_953_337), venue: "Uniswap v3", pool: V3_POOL, currency0: CASHCAT, currency1: USDG, fee: 10_000 },
      { role: V4_ROLE, account: V4_ACCOUNT, block: 26_955_221n, index: 0, transaction: hash(27_955_221), venue: "Uniswap v4", pool: V4_ID, currency0: CASHCAT, currency1: USDG, fee: 2690 },
    ]);
  });

  it("drops a v4 key that does not hash to the pool the account stands for, and a v3 pool the factory did not make", async () => {
    const fake = getAddress("0x00000000000000000000000000000000000000f1");
    const logs = [queued(10n, V4_ROLE, V4_ACCOUNT, v4Key(CASHCAT, USDG, 3000, 60)), queued(11n, V3_ROLE, fake, UNISWAP_V3.toLowerCase() as Hex), queued(12n, V3_ROLE, V3_POOL, pad(PONS, { size: 20 }))];
    const { reader } = endpoint(logs, { pools: { [fake]: [CASHCAT, USDG, 10_000], [V3_POOL]: [CASHCAT, USDG, 10_000] } });
    // A contract that answers like a pool at an address the factory would not give it, and a pool of another factory.
    expect(await queuedPools(reader, logs, queuedKept())).toEqual([]);
  });

  it("reads each v3 pool's currencies once, in one call for all of them", async () => {
    const { reader, asked } = endpoint(CASHCAT_LOGS);
    const kept = queuedKept();
    await queuedPools(reader, CASHCAT_LOGS, kept);
    await queuedPools(reader, CASHCAT_LOGS, kept);
    expect(asked.filter((entry) => entry.startsWith("pools"))).toEqual([`pools ${V3_POOL}`]);
  });
});

describe("firstQueued", () => {
  it("gives the first of a token's pools the multisig queued, when its role took effect, and that the Safe sent it", async () => {
    const { reader } = endpoint(CASHCAT_LOGS);
    expect(await firstQueued(reader, WINTERMUTE, CASHCAT, 30_000_000n, queuedKept())).toEqual({
      role: V3_ROLE,
      transaction: hash(27_953_337),
      venue: "Uniswap v3",
      pool: V3_POOL,
      currency0: CASHCAT,
      currency1: USDG,
      fee: 10_000,
      at: new Date((1_785_000_000 + 2_695_333) * 1000).toISOString(),
      block: 26_953_337,
      granted: { at: new Date((1_785_000_000 + 2_841_107) * 1000).toISOString(), block: 28_411_079, transaction: hash(30_411_079) },
      confirmed: true,
    });
  });

  it("gives no `granted` for a role not in effect yet, and `confirmed` false for a transaction the Safe did not send", async () => {
    const { reader } = endpoint(CASHCAT_LOGS.slice(0, 3), { sentTo: EXECUTOR });
    const first = await firstQueued(reader, WINTERMUTE, CASHCAT, 30_000_000n, queuedKept());
    expect(first).toMatchObject({ block: 26_953_337, confirmed: false });
    expect(first).not.toHaveProperty("granted");
  });

  it("takes a grant only after the queue, for the same role and pool", async () => {
    const logs = [granted(26_000_000n, V3_ROLE, V3_POOL), queued(26_953_337n, V3_ROLE, V3_POOL, UNISWAP_V3.toLowerCase() as Hex), granted(27_000_000n, V4_ROLE, V3_POOL)];
    const { reader } = endpoint(logs);
    expect(await firstQueued(reader, WINTERMUTE, CASHCAT, 30_000_000n, queuedKept())).not.toHaveProperty("granted");
  });

  it("gives nothing for a token none of whose pools were queued, and reads nothing for a wallet with no registry", async () => {
    const { reader, asked } = endpoint(CASHCAT_LOGS);
    expect(await firstQueued(reader, WINTERMUTE, PONS, 30_000_000n, queuedKept())).toBeUndefined();
    asked.length = 0;
    expect(await firstQueued(reader, MARKET_MAKERS[3]!, CASHCAT, 30_000_000n, queuedKept())).toBeUndefined();
    expect(asked).toEqual([]);
  });

  it("reads the registry a stretch at a time and keeps each settled stretch, so a later answer reads only the newest", async () => {
    const newest = 2n * STRETCH_BLOCKS + SETTLED_BLOCKS;
    const { reader, asked } = endpoint(CASHCAT_LOGS, { newest });
    const kept = queuedKept();
    await firstQueued(reader, WINTERMUTE, CASHCAT, newest, kept);
    expect(asked.filter((entry) => entry.startsWith("logs"))).toEqual(["logs 0-9999999", "logs 10000000-19999999", `logs 20000000-${newest}`]);
    asked.length = 0;
    await firstQueued(reader, WINTERMUTE, PONS, newest, kept);
    expect(asked.filter((entry) => entry.startsWith("logs"))).toEqual([`logs 20000000-${newest}`]);
  });
});
