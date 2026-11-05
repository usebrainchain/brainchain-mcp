// Delivery bonds from this server's wallet: USDG locked on Shipped behind a
// BrainChain task, released by the task's Proof and paid to the poster when
// the task is not paid by its deadline. A bond draws on the same budget and
// daily limit as a post, and never passes BRAINCHAIN_MAX_BOND_UNITS.
import { createPublicClient, createWalletClient, defineChain, formatEther, http, isAddress, parseAbi, parseEventLogs, type Address, type Hex, type PrivateKeyAccount } from "viem";

import { formatUnits, type BondsConfig, type Config } from "./config.js";
import type { Limits } from "./limits.js";
import { limitReached } from "./payments.js";
import { BOND_LEAD_SEC, BPS, bondTerms, CHECK_CONFIRM_SEC, CHECK_HOLD_SEC, DeedStatus, FEE_BPS, MIN_BOND, shippedAbi, taskBoardAbi, taskOfCheck, TaskStatus, type BondTerms } from "./shipped.js";

const erc20 = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);
/** Gas the transactions take, measured on a fork of Robinhood Chain, with room. */
const GAS = { approve: 60_000n, create: 1_100_000n };
const DEED_BATCH = 200;
const DEED_SCAN = 5_000;

export interface TaskFacts {
  poster: Address;
  bounty: bigint;
  deadline: bigint;
  status: number;
  model: Hex;
}

export interface BondView {
  deed: bigint;
  amount: bigint;
  deadline: bigint;
  status: number;
  remainderBps: number;
  checkMetAt: bigint;
  settledAt: bigint;
  refundTo: Address;
}

/** What bonding reads and sends, on BrainChain and on Robinhood Chain. */
export interface BondChain {
  account: Address;
  task(id: bigint): Promise<TaskFacts | undefined>;
  now(): Promise<bigint>;
  usdgBalance(): Promise<bigint>;
  ethBalance(): Promise<bigint>;
  gasPrice(): Promise<bigint>;
  allowance(): Promise<bigint>;
  approve(amount: bigint): Promise<Hex>;
  create(terms: BondTerms, amount: bigint): Promise<{ deed: bigint; tx: Hex }>;
  /** The wallet's bonds on one task, newest first. */
  bondsOn(task: bigint): Promise<BondView[]>;
  proofOf(task: bigint): Promise<bigint>;
  /** The agent that paid BrainChain's desk for the task, as the desk records it; undefined for a plain on-chain post. */
  payerOf(task: bigint): Promise<Address | undefined>;
}

export function createBondChain(bonds: BondsConfig, account: PrivateKeyAccount, desk: string, fetchImpl: typeof fetch = fetch): BondChain {
  const brainchain = createPublicClient({
    chain: defineChain({ id: bonds.brainchain.chainId, name: "BrainChain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [bonds.brainchain.rpc] } } }),
    transport: http(bonds.brainchain.rpc, { retryCount: 2, timeout: 15_000 }),
  });
  const chain = defineChain({
    id: 4663,
    name: bonds.chain,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [bonds.rpc] } },
    contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
  });
  const transport = http(bonds.rpc, { retryCount: 2, timeout: 15_000 });
  const client = createPublicClient({ chain, transport, pollingInterval: 1_000 });
  const wallet = createWalletClient({ account, chain, transport });
  const registry = { address: bonds.registry, abi: shippedAbi } as const;
  const token = { address: bonds.usdg, abi: erc20 } as const;

  async function send(request: Parameters<typeof wallet.writeContract>[0]) {
    const hash = await wallet.writeContract(request);
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 90_000 });
    if (receipt.status !== "success") throw new Error(`Transaction ${hash} reverted.`);
    return { hash, receipt };
  }

  return {
    account: account.address,
    async task(id) {
      const t = await brainchain.readContract({ address: bonds.brainchain.board, abi: taskBoardAbi, functionName: "get", args: [id] });
      return t.status === 0 ? undefined : { poster: t.poster, bounty: t.bounty, deadline: t.deadline, status: t.status, model: t.model };
    },
    now: async () => (await client.getBlock()).timestamp,
    usdgBalance: () => client.readContract({ ...token, functionName: "balanceOf", args: [account.address] }),
    ethBalance: () => client.getBalance({ address: account.address }),
    gasPrice: () => client.getGasPrice(),
    allowance: () => client.readContract({ ...token, functionName: "allowance", args: [account.address, bonds.registry] }),
    async approve(amount) {
      return (await send({ ...token, functionName: "approve", args: [bonds.registry, amount] })).hash;
    },
    async create(terms, amount) {
      const { hash, receipt } = await send({ ...registry, functionName: "create", args: [terms, amount] });
      const created = parseEventLogs({ abi: shippedAbi, eventName: "DeedCreated", args: { creator: account.address }, logs: receipt.logs }).find((log) => log.address.toLowerCase() === bonds.registry.toLowerCase());
      if (!created) throw new Error(`The bond ${hash} created no deed for ${account.address}.`);
      return { deed: created.args.deedId, tx: hash };
    },
    async bondsOn(task) {
      if (!bonds.proofIndex) return [];
      const count = Number(await client.readContract({ ...registry, functionName: "deedCount" }));
      const floor = Math.max(0, count - DEED_SCAN);
      const mine: bigint[] = [];
      for (let to = count; to > floor; to -= DEED_BATCH) {
        const ids = Array.from({ length: Math.min(DEED_BATCH, to - floor) }, (_, i) => BigInt(to - i));
        const cores = await client.multicall({ contracts: ids.map((id) => ({ ...registry, functionName: "core", args: [id] }) as const), allowFailure: false });
        ids.forEach((id, i) => {
          if (cores[i]![0].toLowerCase() === account.address.toLowerCase()) mine.push(id);
        });
      }
      if (mine.length === 0) return [];
      const deeds = await client.multicall({ contracts: mine.map((id) => ({ ...registry, functionName: "getDeed", args: [id] }) as const), allowFailure: false });
      return mine.flatMap((deed, i) => {
        const d = deeds[i]!;
        if (d.terms.check.toLowerCase() !== bonds.check.toLowerCase() || taskOfCheck(d.terms.checkData, bonds.proofIndex!, bonds.brainchain.board) !== task) return [];
        return [{ deed, amount: d.balance, deadline: d.terms.deadline, status: d.status, remainderBps: d.remainderBps, checkMetAt: d.checkMetAt, settledAt: d.settledAt, refundTo: d.terms.refundTo }];
      });
    },
    proofOf: (task) => client.readContract({ address: bonds.proofIndex!, abi: parseAbi(["function proofOf(address board, uint256 taskId) view returns (uint256)"]), functionName: "proofOf", args: [bonds.brainchain.board, task] }),
    async payerOf(task) {
      let response: Response;
      try {
        response = await fetchImpl(`${desk}/bonds/refund-to/${task}`, { signal: AbortSignal.timeout(15_000) });
      } catch (error) {
        throw new Error(`Could not reach the desk at ${desk} to ask who paid for task ${task} (${error instanceof Error ? error.message.split("\n")[0] : String(error)}). Nothing was bonded.`);
      }
      if (!response.ok) throw new Error(`The desk at ${desk} answered ${response.status} when asked who paid for task ${task}. Nothing was bonded.`);
      const { refundTo } = ((await response.json().catch(() => undefined)) as { refundTo?: unknown } | undefined) ?? {};
      if (refundTo === null || refundTo === undefined) return undefined;
      if (typeof refundTo !== "string" || !isAddress(refundTo)) throw new Error(`The desk at ${desk} named the payer of task ${task} in a form this server cannot read. Nothing was bonded.`);
      return refundTo;
    },
  };
}

export interface Bonds {
  bond(task: bigint, amount: bigint): Promise<unknown>;
  status(task: bigint): Promise<unknown>;
}

export interface BondsOptions {
  config: Config;
  /** Called when a bond is about to be sent, so the server can start without a key. */
  signer: () => PrivateKeyAccount;
  limits: Limits;
  fetch?: typeof fetch;
  connect?: (bonds: BondsConfig, account: PrivateKeyAccount, desk: string, fetchImpl: typeof fetch) => BondChain;
}

const iso = (seconds: bigint) => new Date(Number(seconds) * 1000).toISOString();
const fee = (amount: bigint) => (amount * FEE_BPS) / BPS;

/** Why bonds cannot be placed on this network right now, for the tool's description and its answers. */
export function bondsClosed(config: Config): string | undefined {
  if (!config.bonds) return `Delivery bonds run on Robinhood Chain against Shipped's registry, which ${config.name === "testnet" ? "BrainChain testnet" : "this network"} has no counterpart of. They are open with BRAINCHAIN_NETWORK=mainnet.`;
  if (!config.bonds.proofIndex) return "Delivery bonds are not open yet: BrainChain's ProofIndex on Robinhood Chain, which a bond's check reads, is not deployed. A later release of brainchain-mcp names it.";
  return undefined;
}

/** Shipped's own number and page for a deed; absent for a test bond or when the API cannot be reached. */
export const SHIPPED_API = "https://api.shipped.bond";

export async function deedPage(deed: bigint, fetchImpl: typeof fetch = fetch): Promise<{ number: string; url: string } | undefined> {
  try {
    const response = await fetchImpl(`${SHIPPED_API}/v1/deeds/${deed}`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { deed?: { number?: unknown; url?: unknown } };
    const { number, url } = body.deed ?? {};
    return typeof number === "string" && typeof url === "string" ? { number, url } : undefined;
  } catch {
    return undefined;
  }
}

export function createBonds(options: BondsOptions): Bonds {
  const { config, limits } = options;
  let chain: BondChain | undefined;
  const connected = () => {
    const closed = bondsClosed(config);
    if (closed) throw new Error(closed);
    return (chain ??= (options.connect ?? createBondChain)(config.bonds!, options.signer(), config.desk, options.fetch ?? fetch));
  };

  function state(b: BondView, indexed: boolean, now: bigint) {
    if (b.status === DeedStatus.Settled) {
      return b.remainderBps === Number(BPS)
        ? { state: "delivered", settledAt: iso(b.settledAt), back: `${formatUnits(b.amount - fee(b.amount))} USDG`, next: "The bond less Shipped's 1% fee is owed to this wallet on the registry; the worker CLI's `bond claim` collects it." }
        : { state: "missed", settledAt: iso(b.settledAt), paidTo: b.refundTo, next: "The task was not paid by the deadline, so the bond went to the poster." };
    }
    if (b.checkMetAt > 0n) return { state: "marked", markedAt: iso(b.checkMetAt), next: `BrainChain confirms the check after ${iso(b.checkMetAt + CHECK_HOLD_SEC)}, and the bond settles as delivered.` };
    if (now > b.deadline) return { state: "lapsed", next: `No Proof was recorded by the deadline. The bond settles to the poster ${b.refundTo} after ${iso(b.deadline + CHECK_HOLD_SEC + CHECK_CONFIRM_SEC)}.` };
    return { state: "open", next: indexed ? "The Proof is in the index; BrainChain marks the check shortly." : "Waiting for the task to be paid and its Proof recorded." };
  }

  return {
    async bond(task, amount) {
      const c = connected();
      const t = await c.task(task);
      if (!t) throw new Error(`There is no task ${task} on BrainChain. Nothing was bonded.`);
      if (t.poster.toLowerCase() === c.account.toLowerCase()) throw new Error(`Task ${task} was posted by this wallet. A bond guarantees delivery to someone else; it earns no standing on a task the same wallet posted. Nothing was bonded.`);
      const hiredHere = t.status === TaskStatus.Hired && t.model.toLowerCase().endsWith(c.account.slice(2).toLowerCase());
      if (t.status !== TaskStatus.Open && !hiredHere) throw new Error(`Task ${task} is not open and not hired to this wallet, so there is nothing to bond. Nothing was bonded.`);
      const now = await c.now();
      if (t.deadline <= now) throw new Error(`Task ${task}'s deadline, ${iso(t.deadline)}, has passed. Nothing was bonded.`);
      if (amount < t.bounty) throw new Error(`The bond must be at least the task's bounty, ${formatUnits(t.bounty)} USDG; ${formatUnits(amount)} USDG is under it. Nothing was bonded.`);
      if (amount < MIN_BOND) throw new Error(`The bond must be at least ${formatUnits(MIN_BOND)} USDG: under that, Shipped's fee and the gas take too much of it. Nothing was bonded.`);
      if (amount > config.maxBond) throw new Error(`This server bonds at most ${formatUnits(config.maxBond)} USDG on one task. Raise BRAINCHAIN_MAX_BOND_UNITS and restart the server to allow more. Nothing was bonded.`);
      const existing = (await c.bondsOn(task)).find((b) => b.status !== DeedStatus.Settled);
      if (existing) throw new Error(`This wallet already has bond No. ${existing.deed} open on task ${task}. Nothing was bonded.`);
      // A task paid through the desk has the desk as its poster on the board; the bond pays the agent that paid.
      const payer = await c.payerOf(task);
      if (payer?.toLowerCase() === c.account.toLowerCase()) throw new Error(`Task ${task} was paid for by this wallet. A bond guarantees delivery to someone else; it earns no standing on a task the same wallet paid for. Nothing was bonded.`);
      const refundTo = payer ?? t.poster;

      const hold = await limits.take(amount);
      if (typeof hold === "string") throw new Error(await limitReached(config, limits, hold, "signed payments and bonds for"));
      try {
        const [balance, allowance, gasPrice, eth] = await Promise.all([c.usdgBalance(), c.allowance(), c.gasPrice(), c.ethBalance()]);
        const approves = allowance < amount;
        const gas = (GAS.create + (approves ? GAS.approve : 0n)) * gasPrice;
        if (balance < amount) throw new Error(`${c.account} holds ${formatUnits(balance)} USDG on ${config.bonds!.chain}, under the ${formatUnits(amount)} USDG to bond. Nothing was bonded.`);
        if (eth < gas) throw new Error(`${c.account} holds ${formatEther(eth)} ETH on ${config.bonds!.chain}, under the ${formatEther(gas)} ETH the approval and the bond need. Nothing was bonded.`);
        const terms = bondTerms({ check: config.bonds!.check, proofIndex: config.bonds!.proofIndex!, usdg: config.bonds!.usdg }, { id: task, refundTo, paidThroughDesk: payer !== undefined, deadline: t.deadline }, { address: config.bonds!.brainchain.board, chainId: config.bonds!.brainchain.chainId });
        if (approves) await c.approve(amount);
        const { deed, tx } = await c.create(terms, amount);
        const page = await deedPage(deed, options.fetch);
        return {
          bond: deed.toString(),
          ...(page ? { number: page.number, url: page.url } : {}),
          tx,
          task: task.toString(),
          amount: `${formatUnits(amount)} USDG`,
          deadline: iso(terms.deadline),
          delivered: `${formatUnits(amount - fee(amount))} USDG back after Shipped's 1% fee, once the task is paid and its Proof recorded`,
          missed: `${formatUnits(amount)} USDG to ${refundTo}, ${payer ? "the agent that paid for the task" : "the poster"}, if no Proof is recorded by the deadline`,
          next: "Jev reads the bond when it hires. Follow it with brainchain_bond_status.",
        };
      } catch (error) {
        await limits.give(hold);
        throw error;
      }
    },
    async status(task) {
      const c = connected();
      const bonds = await c.bondsOn(task);
      if (bonds.length === 0) return { task: task.toString(), wallet: c.account, bonds: [] };
      const [now, indexed, pages] = await Promise.all([c.now(), c.proofOf(task), Promise.all(bonds.map((b) => deedPage(b.deed, options.fetch)))]);
      return {
        task: task.toString(),
        wallet: c.account,
        proofIndexed: indexed > 0n,
        bonds: bonds.map((b, i) => {
          const page = pages[i];
          return { bond: b.deed.toString(), ...(page ? { number: page.number, url: page.url } : {}), amount: `${formatUnits(b.amount)} USDG`, deadline: iso(b.deadline), ...state(b, indexed > 0n, now) };
        }),
      };
    },
  };
}

export { BOND_LEAD_SEC };
