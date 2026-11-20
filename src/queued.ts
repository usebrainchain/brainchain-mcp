import {
  decodeAbiParameters,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  getContractAddress,
  isAddressEqual,
  keccak256,
  multicall3Abi,
  parseAbi,
  parseAbiParameters,
  toEventSelector,
  zeroAddress,
  type Address,
  type Hash,
  type Hex,
} from "viem";

import { blockTime, remember, SETTLED_BLOCKS, STRETCH_BLOCKS, tooMany, tooSlow, type ChainHistory, type Dated } from "./history.js";
import type { MakerWallet } from "./makers.js";
import { MULTICALL3 } from "./premiums.js";
import { UNISWAP_V3 } from "./readiness.js";

/**
 * What Wintermute's role registry logs when its multisig queues a role for an account: the operation's id as the one
 * indexed topic, then the role, the account and the role's data. The registry's source is not published, so this is read
 * from its transactions: each such log comes from a call by the multisig, and the role takes effect only when a later call
 * logs RoleGranted for the same role and account. Every role the registry has granted, apart from its first admin, was
 * queued this way first (read 2026-11-20).
 */
export const QUEUED_TOPIC: Hash = "0xbcce059b45002729bd4848bd5d07112ec98e02105cf4763f6c3eb1c59e1b69a6";
/** OpenZeppelin's RoleGranted, which the registry logs when a queued role takes effect. */
export const GRANTED_TOPIC = toEventSelector("event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)");
/** The hash of the code Uniswap v3's factory deploys each pool with, from which a pool's address follows (checked on Robinhood Chain on 2026-11-20). */
export const V3_POOL_CODE_HASH: Hash = "0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54";

/** One of the token's pools, queued on a market maker's registry for the pools its trading contracts trade through. */
export interface QueuedPool extends Dated {
  venue: "Uniswap v3" | "Uniswap v4";
  /** A v3 pool's address, or a v4 pool's id. */
  pool: Address | Hash;
  currency0: Address;
  currency1: Address;
  fee: number;
  role: Hash;
  /** When the queued role took effect, once the registry has logged it. */
  granted?: Dated;
  /** Whether the transaction was sent to the maker's Safe, which holds the registry. */
  confirmed: boolean;
}

/** A log of the registry, as the endpoint returns it with no event to decode it by. */
interface RegistryLog {
  topics: readonly Hex[];
  data: Hex;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: Hash;
}

/** What a queued role names: a pool on Uniswap v3 or v4, with its two currencies and its fee. */
interface Sides {
  venue: QueuedPool["venue"];
  pool: Address | Hash;
  currency0: Address;
  currency1: Address;
  fee: number;
}

/** A queued role for a pool, in the order the chain logged it. */
interface Queued extends Sides {
  role: Hash;
  /** The account the role is for: a v3 pool's address, or the first 20 bytes of a v4 pool's id. */
  account: Address;
  block: bigint;
  index: number;
  transaction: Hash;
}

/** What was read already: each settled stretch of a registry's logs, and each v3 pool's currencies, which never change. */
export interface QueuedKept {
  logs: Map<string, Promise<RegistryLog[]>>;
  pools: Map<string, Promise<Omit<Sides, "venue" | "pool"> | undefined>>;
}

export const queuedKept = (): QueuedKept => ({ logs: new Map(), pools: new Map() });

/** Every log of `registry` from one block to another; a range the endpoint finds too full or too slow is read in halves. */
export async function registryLogs(reader: ChainHistory, registry: Address, from: bigint, to: bigint): Promise<RegistryLog[]> {
  try {
    return (await reader.getLogs({ address: registry, fromBlock: from, toBlock: to })) as unknown as RegistryLog[];
  } catch (error) {
    if (from >= to || !(tooMany(error) || tooSlow(error))) throw error;
    const middle = (from + to) / 2n;
    return [...(await registryLogs(reader, registry, from, middle)), ...(await registryLogs(reader, registry, middle + 1n, to))];
  }
}

/** All of a registry's logs up to `newest`, a stretch at a time; a stretch that has settled is kept. */
async function history(reader: ChainHistory, registry: Address, newest: bigint, kept: QueuedKept): Promise<RegistryLog[]> {
  const logs: RegistryLog[] = [];
  for (let from = 0n; from <= newest; from += STRETCH_BLOCKS) {
    const to = from + STRETCH_BLOCKS - 1n < newest ? from + STRETCH_BLOCKS - 1n : newest;
    const read = () => registryLogs(reader, registry, from, to);
    logs.push(...(await (to + SETTLED_BLOCKS > newest ? read() : remember(kept.logs, `${registry}:${from}`, read))));
  }
  return logs;
}

const poolAbi = parseAbi(["function token0() view returns (address)", "function token1() view returns (address)", "function fee() view returns (uint24)"]);
const POOL_READS = ["token0", "token1", "fee"] as const;

/**
 * The currencies and fee of each v3 pool in `pools`, read in one call to Multicall3 for those not read before. A pool
 * counts only when Uniswap's factory would have made it at that address, so a contract that answers like a pool is not one.
 */
async function v3Sides(reader: ChainHistory, pools: readonly Address[], kept: QueuedKept): Promise<Map<string, Omit<Sides, "venue" | "pool"> | undefined>> {
  const unread = [...new Set(pools.map((pool) => pool.toLowerCase()))].filter((pool) => !kept.pools.has(pool));
  if (unread.length > 0) {
    const reading = reader
      .readContract({
        address: MULTICALL3,
        abi: multicall3Abi,
        functionName: "aggregate3",
        args: [unread.flatMap((pool) => POOL_READS.map((functionName) => ({ target: getAddress(pool), allowFailure: true, callData: encodeFunctionData({ abi: poolAbi, functionName }) })))],
      })
      .then((answers) =>
        unread.map((pool, i) => {
          try {
            const [token0, token1, fee] = POOL_READS.map((functionName, j) => {
              const answer = answers[i * POOL_READS.length + j];
              if (!answer?.success) throw new Error();
              return decodeFunctionResult({ abi: poolAbi, functionName, data: answer.returnData });
            }) as [Address, Address, number];
            const salt = keccak256(encodeAbiParameters(parseAbiParameters("address, address, uint24"), [token0, token1, fee]));
            const made = getContractAddress({ opcode: "CREATE2", from: UNISWAP_V3, salt, bytecodeHash: V3_POOL_CODE_HASH });
            return isAddressEqual(made, getAddress(pool)) ? { currency0: getAddress(token0), currency1: getAddress(token1), fee } : undefined;
          } catch {
            return undefined;
          }
        }),
      );
    unread.forEach((pool, i) => remember(kept.pools, pool, () => reading.then((sides) => sides[i])));
  }
  const found = new Map<string, Omit<Sides, "venue" | "pool"> | undefined>();
  for (const pool of new Set(pools.map((pool) => pool.toLowerCase()))) found.set(pool, await kept.pools.get(pool)!);
  return found;
}

/**
 * The queued roles in `logs` that name a pool on Uniswap v3 or v4, in chain order. A v4 pool comes with its key as the
 * role's data, and counts only when the key hashes to the pool id the account is taken from. A v3 pool comes with the
 * factory's address as the data, and its currencies are read from the pool. Any other queued role, for an operator or a
 * spender, names no pool and is left out.
 */
export async function queuedPools(reader: ChainHistory, logs: readonly RegistryLog[], kept: QueuedKept): Promise<Queued[]> {
  const raw = logs
    .filter((log) => log.topics[0]?.toLowerCase() === QUEUED_TOPIC)
    .flatMap((log) => {
      try {
        const [role, account, data] = decodeAbiParameters(parseAbiParameters("bytes32, address, bytes"), log.data);
        return [{ role, account: getAddress(account), data, block: log.blockNumber, index: log.logIndex, transaction: log.transactionHash }];
      } catch {
        return [];
      }
    });
  const v3 = raw.filter(({ data }) => data.length === 42 && isAddressEqual(getAddress(data), UNISWAP_V3));
  const sides = v3.length > 0 ? await v3Sides(reader, v3.map(({ account }) => account), kept) : new Map();
  const found: Queued[] = [];
  for (const { data, ...op } of raw) {
    if (data.length === 2 + 160 * 2) {
      const key = decodeAbiParameters(parseAbiParameters("address, address, uint24, int24, address"), data);
      const id = keccak256(encodeAbiParameters(parseAbiParameters("address, address, uint24, int24, address"), key));
      if (id.slice(0, 42).toLowerCase() === op.account.toLowerCase()) found.push({ ...op, venue: "Uniswap v4", pool: id, currency0: getAddress(key[0]), currency1: getAddress(key[1]), fee: key[2] });
    } else if (data.length === 42 && isAddressEqual(getAddress(data), UNISWAP_V3)) {
      const pool = sides.get(op.account.toLowerCase());
      if (pool) found.push({ ...op, venue: "Uniswap v3", pool: op.account, ...pool });
    }
  }
  return found.sort((a, b) => (a.block === b.block ? a.index - b.index : a.block < b.block ? -1 : 1));
}

/** Whether a queued pool has `token` on one side. */
export const holds = (queued: Pick<Sides, "currency0" | "currency1">, token: Address) => isAddressEqual(queued.currency0, token) || isAddressEqual(queued.currency1, token);

/** The pool's other side: the other token's contract address, or ETH. */
export const otherSide = (queued: Pick<Sides, "currency0" | "currency1">, token: Address): Address | "ETH" => {
  const other = isAddressEqual(queued.currency0, token) ? queued.currency1 : queued.currency0;
  return isAddressEqual(other, zeroAddress) ? "ETH" : other;
};

/** Whether `maker` took part in the transaction: it was sent by the wallet, to it, or to its Safe. */
export async function sentBy(reader: ChainHistory, maker: MakerWallet, transaction: Hash): Promise<boolean> {
  const sent = await reader.getTransaction({ hash: transaction });
  const ours = (address: Address | null) => address !== null && (isAddressEqual(address, maker.wallet) || (maker.safe !== undefined && isAddressEqual(address, maker.safe)));
  return isAddressEqual(sent.from, maker.wallet) || ours(sent.to);
}

/** A queued pool, dated, with when its role took effect from the grants in `logs`, and whether the maker sent it. */
export async function dated(reader: ChainHistory, maker: MakerWallet, op: Queued, logs: readonly RegistryLog[]): Promise<QueuedPool> {
  const grant = logs.find(
    (log) =>
      log.topics[0]?.toLowerCase() === GRANTED_TOPIC &&
      log.topics[1]?.toLowerCase() === op.role.toLowerCase() &&
      log.topics[2] !== undefined &&
      isAddressEqual(getAddress(`0x${log.topics[2].slice(26)}`), op.account) &&
      (log.blockNumber > op.block || (log.blockNumber === op.block && log.logIndex > op.index)),
  );
  const { account, index, block, ...pool } = op;
  return {
    ...pool,
    at: await blockTime(reader, block),
    block: Number(block),
    ...(grant ? { granted: { at: await blockTime(reader, grant.blockNumber), block: Number(grant.blockNumber), transaction: grant.transactionHash } } : {}),
    confirmed: await sentBy(reader, maker, op.transaction),
  };
}

/**
 * The first time `maker`'s multisig queued one of `token`'s pools on its registry, read from the registry's whole log up
 * to `newest`; nothing for a maker with no registry, or a token none of whose pools it has queued.
 */
export async function firstQueued(reader: ChainHistory, maker: MakerWallet, token: Address, newest: bigint, kept: QueuedKept): Promise<QueuedPool | undefined> {
  if (!maker.registry) return undefined;
  const logs = await history(reader, maker.registry, newest, kept);
  const first = (await queuedPools(reader, logs, kept)).find((op) => holds(op, token));
  return first && dated(reader, maker, first, logs);
}
