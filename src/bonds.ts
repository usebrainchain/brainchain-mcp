// Delivery bonds from this server's wallet: USDG locked on Shipped behind a
// BrainChain task, released by the task's Proof and paid to the agent that
// paid for the task when no Proof is recorded by the bond's deadline. A bond
// draws on the same budget and daily limit as a post, and never passes
// BRAINCHAIN_MAX_BOND_UNITS.
import {
  BaseError,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  formatEther,
  http,
  InternalRpcError,
  isAddress,
  keccak256,
  parseAbi,
  parseEventLogs,
  RpcError,
  RpcRequestError,
  type Address,
  type Hex,
  type PrivateKeyAccount,
} from "viem";

import { formatUnits, type BondsConfig, type Config } from "./config.js";
import type { Limits, Refusal } from "./limits.js";
import { brief, firstLine, sentence } from "./payments.js";
import { BOND_LEAD_SEC, BPS, bondTerms, CHECK_CONFIRM_SEC, CHECK_HOLD_SEC, DeedStatus, FEE_BPS, MIN_BOND, MISSED_TO, shippedAbi, taskBoardAbi, taskOfCheck, TaskStatus, type BondTerms } from "./shipped.js";

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
  /** Without `deed` the bond may have been sent and could not be confirmed, for the reason in `unconfirmed`. */
  create(terms: BondTerms, amount: bigint): Promise<{ tx: Hex; deed: bigint } | { tx: Hex; unconfirmed: string }>;
  /** The wallet's bonds on one task, newest first. */
  bondsOn(task: bigint): Promise<BondView[]>;
  proofOf(task: bigint): Promise<bigint>;
  /** USDG the registry holds for the wallet to collect: one sum for all its bonds, emptied by a claim. */
  owed(): Promise<bigint>;
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

  /** A read that fails names the chain that did not answer, in a line, in place of the library's report. */
  const read = <T>(where: string, work: Promise<T>): Promise<T> =>
    work.catch((error: unknown) => {
      throw new Error(`${where} could not be read just now: ${brief(error)}`);
    });

  /**
   * Sends in steps, so that what fails says whether anything left this machine. Up to the signature
   * nothing has, and a node that refuses the send took nothing. Past that the transaction may confirm
   * whatever is heard back, an internal error of the node's included, so the reason comes back in the
   * receipt's place.
   */
  async function send(what: string, to: Address, data: Hex) {
    const unsent = (error: unknown) => new Error(`The ${what} could not be sent: ${brief(error)} Nothing was bonded.`);
    const signed = await wallet
      .prepareTransactionRequest({ to, data })
      .then((request) => wallet.signTransaction(request))
      .catch((error: unknown) => {
        throw unsent(error);
      });
    const hash = keccak256(signed);
    try {
      await client.sendRawTransaction({ serializedTransaction: signed });
    } catch (error) {
      const answered = error instanceof BaseError && error.walk((cause) => cause instanceof RpcRequestError || cause instanceof RpcError);
      if (answered && !error.walk((cause) => cause instanceof InternalRpcError)) throw unsent(error);
      return { hash, receipt: `no answer when it was sent, ${brief(error)}` };
    }
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 90_000 }).catch(brief);
    if (typeof receipt !== "string" && receipt.status !== "success") throw new Error(`The ${what} ${hash} reverted. Nothing was bonded.`);
    return { hash, receipt };
  }

  async function deedsOn(task: bigint): Promise<BondView[]> {
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
  }

  return {
    account: account.address,
    async task(id) {
      const t = await read("BrainChain", brainchain.readContract({ address: bonds.brainchain.board, abi: taskBoardAbi, functionName: "get", args: [id] }));
      return t.status === 0 ? undefined : { poster: t.poster, bounty: t.bounty, deadline: t.deadline, status: t.status, model: t.model };
    },
    now: async () => (await read(bonds.chain, client.getBlock())).timestamp,
    usdgBalance: () => read(bonds.chain, client.readContract({ ...token, functionName: "balanceOf", args: [account.address] })),
    ethBalance: () => read(bonds.chain, client.getBalance({ address: account.address })),
    gasPrice: () => read(bonds.chain, client.getGasPrice()),
    allowance: () => read(bonds.chain, client.readContract({ ...token, functionName: "allowance", args: [account.address, bonds.registry] })),
    async approve(amount) {
      const { hash, receipt } = await send("approval", bonds.usdg, encodeFunctionData({ abi: erc20, functionName: "approve", args: [bonds.registry, amount] }));
      if (typeof receipt === "string") throw new Error(`The approval ${hash} could not be confirmed, so the bond was not sent: ${receipt} Nothing was bonded.`);
      return hash;
    },
    async create(terms, amount) {
      const { hash, receipt } = await send("bond", bonds.registry, encodeFunctionData({ abi: shippedAbi, functionName: "create", args: [terms, amount] }));
      if (typeof receipt === "string") return { tx: hash, unconfirmed: receipt };
      const created = parseEventLogs({ abi: shippedAbi, eventName: "DeedCreated", args: { creator: account.address }, logs: receipt.logs }).find((log) => log.address.toLowerCase() === bonds.registry.toLowerCase());
      // The transaction went through, so the USDG may have moved even though no bond can be named.
      if (!created) return { tx: hash, unconfirmed: `its receipt names no bond for ${account.address}.` };
      return { deed: created.args.deedId, tx: hash };
    },
    bondsOn: (task) => read(bonds.chain, deedsOn(task)),
    proofOf: (task) => read(bonds.chain, client.readContract({ address: bonds.proofIndex!, abi: parseAbi(["function proofOf(address board, uint256 taskId) view returns (uint256)"]), functionName: "proofOf", args: [bonds.brainchain.board, task] })),
    owed: () => read(bonds.chain, client.readContract({ ...registry, functionName: "owed", args: [account.address, bonds.usdg] })),
    async payerOf(task) {
      let response: Response;
      try {
        response = await fetchImpl(`${desk}/bonds/refund-to/${task}`, { signal: AbortSignal.timeout(15_000) });
      } catch (error) {
        throw new Error(`Could not reach the desk at ${desk} to ask who paid for task ${task} (${error instanceof Error ? error.message.split("\n")[0] : String(error)}). Nothing was bonded.`);
      }
      if (!response.ok) throw new Error(`The desk at ${desk} answered ${response.status} when asked who paid for task ${task}. Nothing was bonded.`);
      const { board, refundTo } = ((await response.json().catch(() => undefined)) as { board?: unknown; refundTo?: unknown } | undefined) ?? {};
      // Task ids restart with each board, so an answer for another board names who paid for a different task.
      if (typeof board !== "string" || board.toLowerCase() !== bonds.brainchain.board.toLowerCase()) {
        throw new Error(`The desk at ${desk} answered for ${typeof board === "string" ? `the task board ${board}` : "an unnamed task board"}, and this server reads task ${task} from ${bonds.brainchain.board}, so who paid for the task cannot be told. Nothing was bonded.`);
      }
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

  /** A bond the limits refuse: what was asked and what is left, in the bond's own token whatever this server pays tasks in. */
  async function overLimit(which: Refusal, amount: bigint): Promise<string> {
    const asked = `A bond of ${formatUnits(amount)} USDG is more than`;
    if (which === "budget") {
      return `${asked} the ${formatUnits(config.budget - limits.spent())} USDG left in this server's budget. The budget resets when the server restarts; raise BRAINCHAIN_BUDGET_UNITS to allow more per run. Nothing was bonded.`;
    }
    const today = await limits.spentToday();
    const left = today === undefined ? "what is left" : `the ${formatUnits(today < config.daily! ? config.daily! - today : 0n)} USDG left`;
    return `${asked} ${left} in this wallet's daily limit, which counts USDG and USDC together. The limit resets at 00:00 UTC; raise BRAINCHAIN_DAILY_UNITS to allow more. Nothing was bonded.`;
  }

  function state(b: BondView, indexed: boolean, now: bigint, t: TaskFacts | undefined, owed: bigint) {
    if (b.status === DeedStatus.Settled) {
      if (b.remainderBps !== Number(BPS)) {
        const why = indexed ? "The Proof is in the index, but the bond settled without it" : "No Proof was recorded";
        return { state: "missed", settledAt: iso(b.settledAt), paidTo: b.refundTo, next: `${why}, so the bond went to ${MISSED_TO}: ${b.refundTo}.` };
      }
      // The registry keeps one sum per wallet, so only an empty one says which bonds were collected.
      const next =
        owed === 0n
          ? "The bond less Shipped's 1% fee was collected: the registry owes this wallet nothing."
          : `The bond less Shipped's 1% fee was credited to this wallet on the registry, which owes it ${formatUnits(owed)} USDG in all; the worker CLI's \`bond claim\` collects that.`;
      return { state: "delivered", settledAt: iso(b.settledAt), back: `${formatUnits(b.amount - fee(b.amount))} USDG`, next };
    }
    if (b.checkMetAt > 0n) return { state: "marked", markedAt: iso(b.checkMetAt), next: `BrainChain confirms the check after ${iso(b.checkMetAt + CHECK_HOLD_SEC)}, and the bond settles as delivered.` };
    const settles = `The bond settles after ${iso(b.deadline + CHECK_HOLD_SEC + CHECK_CONFIRM_SEC)} to ${MISSED_TO}: ${b.refundTo}.`;
    // Shipped sets no first mark after the deadline, so a Proof that is in the index by now does not release the bond.
    if (now > b.deadline) return { state: "lapsed", next: `${indexed ? "The Proof is in the index, but the bond's check holds no mark and Shipped sets none after the deadline." : "No Proof was recorded by the bond's deadline."} ${settles}` };
    if (indexed) return { state: "open", next: "The Proof is in the index; BrainChain marks the check shortly." };
    // A refunded task is final and gets no Proof, so its bond can only be missed.
    if (t?.status === TaskStatus.Refunded) return { state: "open", next: `The task was refunded, so no Proof will be recorded. ${settles}` };
    return { state: "open", next: t?.status === TaskStatus.Paid ? "The task is paid; waiting for its Proof to be minted and recorded." : "Waiting for the task to be paid and its Proof recorded." };
  }

  async function place(c: BondChain, task: bigint, amount: bigint) {
    const t = await c.task(task);
    if (!t) throw new Error(`There is no task ${task} on BrainChain. Nothing was bonded.`);
    if (t.poster.toLowerCase() === c.account.toLowerCase()) throw new Error(`Task ${task} was posted by this wallet. A bond guarantees delivery to someone else; it earns no standing on a task the same wallet posted. Nothing was bonded.`);
    const hiredHere = t.status === TaskStatus.Hired && t.model.toLowerCase().endsWith(c.account.slice(2).toLowerCase());
    if (!hiredHere) throw new Error(`Task ${task} is not hired to this wallet. Bond a task after Jev hires it for the task. Nothing was bonded.`);
    const now = await c.now();
    if (t.deadline <= now) throw new Error(`Task ${task}'s deadline, ${iso(t.deadline)}, has passed. Nothing was bonded.`);
    if (amount < t.bounty) throw new Error(`The bond must be at least the task's bounty, ${formatUnits(t.bounty)} USDG; ${formatUnits(amount)} USDG is under it. Nothing was bonded.`);
    if (amount < MIN_BOND) throw new Error(`The bond must be at least ${formatUnits(MIN_BOND)} USDG: under that, Shipped's fee and the gas take too much of it. Nothing was bonded.`);
    if (amount > config.maxBond) throw new Error(`This server bonds at most ${formatUnits(config.maxBond)} USDG on one task. Raise BRAINCHAIN_MAX_BOND_UNITS and restart the server to allow more. Nothing was bonded.`);
    const existing = (await c.bondsOn(task)).find((b) => b.status !== DeedStatus.Settled);
    if (existing) {
      const page = await deedPage(existing.deed, options.fetch);
      throw new Error(`This wallet already has ${page ? `bond No. ${page.number}` : "a bond"} open on task ${task} (registry id ${existing.deed}${page ? `, ${page.url}` : ""}). Nothing was bonded.`);
    }
    // A task paid through the desk has the desk as its poster on the board; the bond pays the agent that paid.
    const payer = await c.payerOf(task);
    if (payer?.toLowerCase() === c.account.toLowerCase()) throw new Error(`Task ${task} was paid for by this wallet. A bond guarantees delivery to someone else; it earns no standing on a task the same wallet paid for. Nothing was bonded.`);
    const refundTo = payer ?? t.poster;

    const hold = await limits.take(amount);
    if (typeof hold === "string") throw new Error(await overLimit(hold, amount));
    try {
      const [balance, allowance, gasPrice, eth] = await Promise.all([c.usdgBalance(), c.allowance(), c.gasPrice(), c.ethBalance()]);
      const approves = allowance < amount;
      const gas = (GAS.create + (approves ? GAS.approve : 0n)) * gasPrice;
      if (balance < amount) throw new Error(`${c.account} holds ${formatUnits(balance)} USDG on ${config.bonds!.chain}, under the ${formatUnits(amount)} USDG to bond. Nothing was bonded.`);
      if (eth < gas) throw new Error(`${c.account} holds ${formatEther(eth)} ETH on ${config.bonds!.chain}, under the ${formatEther(gas)} ETH the approval and the bond need. Nothing was bonded.`);
      const terms = bondTerms({ check: config.bonds!.check, proofIndex: config.bonds!.proofIndex!, usdg: config.bonds!.usdg }, { id: task, refundTo, paidThroughDesk: payer !== undefined, deadline: t.deadline }, { address: config.bonds!.brainchain.board, chainId: config.bonds!.brainchain.chainId });
      if (approves) await c.approve(amount);
      const made = await c.create(terms, amount);
      // A bond that was sent may still confirm, so it stays counted against the budget and the daily limit.
      if (!("deed" in made)) {
        return {
          possiblyBonded: true,
          tx: made.tx,
          task: task.toString(),
          amount: `${formatUnits(amount)} USDG`,
          deadline: iso(terms.deadline),
          error: `The bond's transaction ${made.tx} could not be confirmed: ${made.unconfirmed} The bond may have been placed. Read task ${task} with brainchain_bond_status; do not bond it again.`,
        };
      }
      const page = await deedPage(made.deed, options.fetch);
      return {
        bond: made.deed.toString(),
        ...(page ? { number: page.number, url: page.url } : {}),
        tx: made.tx,
        task: task.toString(),
        amount: `${formatUnits(amount)} USDG`,
        deadline: iso(terms.deadline),
        delivered: `${formatUnits(amount - fee(amount))} USDG back after Shipped's 1% fee, once the task is paid and its Proof recorded`,
        missed: `${formatUnits(amount)} USDG to ${refundTo}, ${payer ? "the agent that paid BrainChain's desk for the task" : "the poster, as the task was posted on the board directly"}, if no Proof is recorded by the deadline`,
        next: "Follow it with brainchain_bond_status. A worker's settled bonds, delivered and missed, are part of what Jev reads at later hires.",
      };
    } catch (error) {
      await limits.give(hold);
      throw error;
    }
  }

  /** One call at a time per task: two would both pass the open-bond check before either bond exists. */
  const placing = new Set<bigint>();

  return {
    async bond(task, amount) {
      const c = connected();
      if (placing.has(task)) throw new Error(`This server is already placing a bond on task ${task}. Wait for that call's reply; this call bonded nothing.`);
      placing.add(task);
      try {
        return await place(c, task, amount);
      } catch (error) {
        // A bond that may have been sent answers instead of throwing, so whatever is thrown bonded nothing.
        const said = sentence(firstLine(error));
        throw new Error(said.endsWith("Nothing was bonded.") ? said : `${said} Nothing was bonded.`);
      } finally {
        placing.delete(task);
      }
    },
    async status(task) {
      const c = connected();
      const bonds = await c.bondsOn(task);
      if (bonds.length === 0) return { task: task.toString(), wallet: c.account, bonds: [] };
      const delivered = bonds.some((b) => b.status === DeedStatus.Settled && b.remainderBps === Number(BPS));
      // Only a bond still waiting for its Proof is worded by where the task stands.
      const waiting = bonds.some((b) => b.status !== DeedStatus.Settled && b.checkMetAt === 0n);
      const [now, indexed, t, owed, pages] = await Promise.all([
        c.now(),
        c.proofOf(task),
        waiting ? c.task(task) : undefined,
        delivered ? c.owed() : 0n,
        Promise.all(bonds.map((b) => deedPage(b.deed, options.fetch))),
      ]);
      return {
        task: task.toString(),
        wallet: c.account,
        proofIndexed: indexed > 0n,
        bonds: bonds.map((b, i) => {
          const page = pages[i];
          return { bond: b.deed.toString(), ...(page ? { number: page.number, url: page.url } : {}), amount: `${formatUnits(b.amount)} USDG`, deadline: iso(b.deadline), ...state(b, indexed > 0n, now, t, owed) };
        }),
      };
    },
  };
}

export { BOND_LEAD_SEC };
