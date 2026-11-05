import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decodeAbiParameters, decodeFunctionData, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";

import { bondsClosed, createBonds, type BondChain, type BondView, type TaskFacts } from "./bonds.js";
import { resolveConfig } from "./config.js";
import { createLimits } from "./limits.js";
import { BOND_LEAD_SEC, bondTerms, DeedStatus, encodeCheckData, proofIndexAbi, Ruling, taskOfCheck, TaskStatus } from "./shipped.js";

// Anvil's second default account: a public test key that holds nothing anywhere.
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const account = privateKeyToAccount(KEY);
const POSTER: Address = "0x00000000000000000000000000000000000000d1";
const INDEX: Address = "0x00000000000000000000000000000000000000f1";
const TX: Hex = `0x${"fe".repeat(32)}`;
const USDG = (n: number) => BigInt(Math.round(n * 1_000_000));
const NOW = 1_800_000_000n;

const task = (overrides: Partial<TaskFacts> = {}): TaskFacts => ({ poster: POSTER, bounty: USDG(1), deadline: NOW + 86_400n, status: TaskStatus.Open, model: `0x${"0".repeat(64)}`, ...overrides });
const view = (overrides: Partial<BondView> = {}): BondView => ({ deed: 4n, amount: USDG(5), deadline: NOW + 86_400n + BOND_LEAD_SEC, status: DeedStatus.Open, remainderBps: 0, checkMetAt: 0n, settledAt: 0n, refundTo: POSTER, ...overrides });

function fakeChain(options: { task?: TaskFacts; bonds?: BondView[]; usdg?: bigint; eth?: bigint; allowance?: bigint; proof?: bigint; payer?: Address } = {}) {
  return {
    account: account.address,
    task: vi.fn(async () => options.task),
    now: vi.fn(async () => NOW),
    usdgBalance: vi.fn(async () => options.usdg ?? USDG(100)),
    ethBalance: vi.fn(async () => options.eth ?? 10n ** 16n),
    gasPrice: vi.fn(async () => 20_000_000n),
    allowance: vi.fn(async () => options.allowance ?? 0n),
    approve: vi.fn(async () => TX),
    create: vi.fn(async () => ({ deed: 7n, tx: TX })),
    bondsOn: vi.fn(async () => options.bonds ?? []),
    proofOf: vi.fn(async () => options.proof ?? 0n),
    payerOf: vi.fn(async () => options.payer),
  } satisfies BondChain;
}

function setup(chain: BondChain, env: Record<string, string> = {}) {
  const config = resolveConfig({ BRAINCHAIN_NETWORK: "mainnet", BRAINCHAIN_BUDGET_UNITS: "20000000", ...env });
  const open = { ...config, bonds: { ...config.bonds!, proofIndex: INDEX } };
  const limits = createLimits(open, () => account);
  return { bonds: createBonds({ config: open, signer: () => account, limits, connect: () => chain }), limits, config: open };
}

describe("ShippedDeeds' enums", () => {
  it("pins Ruling as the contract declares it: Conceded is 5 and CheckMet 7, and a state reads the settled split, never the ruling number", async () => {
    expect(Ruling).toEqual({ None: 0, Accepted: 1, Rejected: 2, Partial: 3, Invalid: 4, Conceded: 5, Default: 6, CheckMet: 7 });
    expect(DeedStatus).toEqual({ None: 0, Open: 1, Ruled: 2, Appealed: 3, Settled: 4 });
    const { bonds } = setup(fakeChain({ bonds: [view({ status: DeedStatus.Settled, remainderBps: 10_000, settledAt: NOW }), view({ deed: 3n, status: DeedStatus.Settled, remainderBps: 0, settledAt: NOW })] }));
    const status = (await bonds.status(12n)) as { bonds: { state: string }[] };
    expect(status.bonds.map((b) => b.state)).toEqual(["delivered", "missed"]);
  });
});

describe("bondTerms", () => {
  it("builds the terms Shipped's create accepts for a check-only bond, keyed by board and task, with the refund side named", () => {
    const config = resolveConfig({ BRAINCHAIN_NETWORK: "mainnet" }).bonds!;
    const terms = bondTerms({ check: config.check, proofIndex: INDEX, usdg: config.usdg }, { id: 12n, refundTo: POSTER, paidThroughDesk: false, deadline: NOW }, { address: config.brainchain.board, chainId: config.brainchain.chainId });
    expect(terms.title).toBe("BrainChain task #12");
    expect(Buffer.byteLength(terms.milestone)).toBeLessThanOrEqual(2048);
    expect(terms.milestone).toContain(`proofOf(${config.brainchain.board}, 12) >= 1`);
    expect(terms.milestone).toContain(`paid to ${POSTER}, the task's poster`);
    expect(bondTerms({ check: config.check, proofIndex: INDEX, usdg: config.usdg }, { id: 12n, refundTo: account.address, paidThroughDesk: true, deadline: NOW }, { address: config.brainchain.board, chainId: 1 }).milestone).toContain(
      `paid to ${account.address}, the agent that paid BrainChain's desk for the task`,
    );
    expect(terms).toMatchObject({
      project: "0x0000000000000000000000000000000000000000",
      projectKind: 0,
      asset: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
      deadline: NOW + 48n * 3_600n,
      verifier: "0x0000000000000000000000000000000000000000",
      backupVerifier: "0x0000000000000000000000000000000000000000",
      appealPanel: "0x0000000000000000000000000000000000000000",
      check: "0x2e7C4F0F2e6079C3B5F7Cd2440308234CBDc537D",
      refundTo: POSTER,
      defaultRemainderBps: 0,
      refundCapBps: 0,
      allowPartial: false,
      verifierGrace: 0,
      backupGrace: 0,
      appealWindow: 0,
      panelWindow: 0,
      appealBond: 0n,
      verifierFee: 0n,
      refundExcluded: [],
    });
    const [target, call, op, threshold] = decodeAbiParameters([{ type: "address" }, { type: "bytes" }, { type: "uint8" }, { type: "uint256" }], terms.checkData);
    expect([target, op, threshold]).toEqual([INDEX, 0, 1n]);
    expect(decodeFunctionData({ abi: proofIndexAbi, data: call })).toEqual({ functionName: "proofOf", args: [config.brainchain.board, 12n] });
    expect(taskOfCheck(encodeCheckData(INDEX, config.brainchain.board, 3n), INDEX, config.brainchain.board)).toBe(3n);
    expect(taskOfCheck(encodeCheckData(INDEX, config.brainchain.board, 3n), POSTER, config.brainchain.board)).toBeUndefined();
    expect(taskOfCheck(encodeCheckData(INDEX, config.brainchain.board, 3n), INDEX, POSTER)).toBeUndefined();
  });
});

describe("bond", () => {
  it("approves and opens the bond, counting it against the budget, and says what it returns either way", async () => {
    const chain = fakeChain({ task: task() });
    const { bonds, limits } = setup(chain);
    const reply = await bonds.bond(12n, USDG(5));
    expect(chain.approve).toHaveBeenCalledWith(USDG(5));
    const [terms, amount] = chain.create.mock.calls[0]!;
    expect(amount).toBe(USDG(5));
    expect(terms.refundTo).toBe(POSTER);
    expect(terms.deadline).toBe(NOW + 86_400n + BOND_LEAD_SEC);
    expect(reply).toEqual({
      bond: "7",
      tx: TX,
      task: "12",
      amount: "5 USDG",
      deadline: "2027-01-18T08:00:00.000Z",
      delivered: "4.95 USDG back after Shipped's 1% fee, once the task is paid and its Proof recorded",
      missed: `5 USDG to ${POSTER}, the poster, if no Proof is recorded by the deadline`,
      next: "Jev reads the bond when it hires. Follow it with brainchain_bond_status.",
    });
    expect(limits.spent()).toBe(USDG(5));
  });

  it("pays the agent that paid the desk for the task, and refuses a task this wallet paid for", async () => {
    const payer: Address = "0x00000000000000000000000000000000000000e1";
    const chain = fakeChain({ task: task({ poster: "0x00000000000000000000000000000000000000de" }), payer });
    const reply = (await setup(chain).bonds.bond(12n, USDG(5))) as { missed: string };
    expect(chain.payerOf).toHaveBeenCalledWith(12n);
    const [terms] = chain.create.mock.calls[0]!;
    expect(terms.refundTo).toBe(payer);
    expect(terms.milestone).toContain(`paid to ${payer}, the agent that paid BrainChain's desk for the task`);
    expect(reply.missed).toBe(`5 USDG to ${payer}, the agent that paid for the task, if no Proof is recorded by the deadline`);
    const own = fakeChain({ task: task({ poster: "0x00000000000000000000000000000000000000de" }), payer: account.address });
    const { bonds, limits } = setup(own);
    await expect(bonds.bond(12n, USDG(5))).rejects.toThrow("Task 12 was paid for by this wallet.");
    expect(own.create).not.toHaveBeenCalled();
    expect(limits.spent()).toBe(0n);
  });

  it("skips the approval when the allowance covers the bond", async () => {
    const chain = fakeChain({ task: task(), allowance: USDG(10) });
    await setup(chain).bonds.bond(12n, USDG(5));
    expect(chain.approve).not.toHaveBeenCalled();
    expect(chain.create).toHaveBeenCalledOnce();
  });

  it("refuses what the CLI refuses, and the server's own cap, before anything is counted or sent", async () => {
    for (const [chain, amount, error] of [
      [fakeChain({ task: task({ poster: account.address }) }), USDG(5), "Task 12 was posted by this wallet."],
      [fakeChain({ task: task({ bounty: USDG(8) }) }), USDG(5), "The bond must be at least the task's bounty, 8 USDG; 5 USDG is under it."],
      [fakeChain({ task: task() }), USDG(1.5), "The bond must be at least 2 USDG"],
      [fakeChain({ task: task() }), USDG(11), "This server bonds at most 10 USDG on one task. Raise BRAINCHAIN_MAX_BOND_UNITS"],
      [fakeChain({ task: undefined }), USDG(5), "There is no task 12 on BrainChain."],
      [fakeChain({ task: task({ status: 6 }) }), USDG(5), "Task 12 is not open and not hired to this wallet"],
      [fakeChain({ task: task({ deadline: NOW - 1n }) }), USDG(5), "deadline, 2027-01-15T07:59:59.000Z, has passed"],
      [fakeChain({ task: task(), bonds: [view()] }), USDG(5), "This wallet already has bond No. 4 open on task 12."],
    ] as const) {
      const { bonds, limits } = setup(chain);
      await expect(bonds.bond(12n, amount)).rejects.toThrow(error);
      expect(chain.create).not.toHaveBeenCalled();
      expect(limits.spent()).toBe(0n);
    }
  });

  it("gives the budget back when the wallet cannot pay, and holds it against the next post", async () => {
    const short = fakeChain({ task: task(), usdg: USDG(4) });
    const { bonds, limits } = setup(short);
    await expect(bonds.bond(12n, USDG(5))).rejects.toThrow(`${account.address} holds 4 USDG on Robinhood Chain, under the 5 USDG to bond. Nothing was bonded.`);
    expect(limits.spent()).toBe(0n);
    const dry = fakeChain({ task: task(), eth: 0n });
    await expect(setup(dry).bonds.bond(12n, USDG(5))).rejects.toThrow("holds 0 ETH on Robinhood Chain, under the");
    expect(dry.create).not.toHaveBeenCalled();

    const chain = fakeChain({ task: task() });
    const capped = setup(chain, { BRAINCHAIN_BUDGET_UNITS: "6000000" });
    await capped.bonds.bond(12n, USDG(5));
    await expect(capped.bonds.bond(13n, USDG(2))).rejects.toThrow("This server has already signed payments and bonds for 5 of its 6 USDG budget.");
    expect(chain.create).toHaveBeenCalledOnce();
  });

  it("keeps the daily limit across bonds and posts from the same wallet", async () => {
    const chain = fakeChain({ task: task() });
    const stateDir = await mkdtemp(join(tmpdir(), "brainchain-mcp-"));
    const first = setup(chain, { BRAINCHAIN_DAILY_UNITS: "6000000", BRAINCHAIN_STATE_DIR: stateDir });
    await first.bonds.bond(12n, USDG(5));
    const second = setup(chain, { BRAINCHAIN_DAILY_UNITS: "6000000", BRAINCHAIN_STATE_DIR: stateDir });
    await expect(second.bonds.bond(13n, USDG(2))).rejects.toThrow(/already signed payments and bonds for 5 of its daily limit of 6, counting USDG and USDC together/);
    expect(second.limits.spent()).toBe(0n);
  });

  it("is closed on testnet and until the index is deployed, without touching the chain", async () => {
    const testnet = resolveConfig({ BRAINCHAIN_NETWORK: "testnet" });
    expect(bondsClosed(testnet)).toContain("BrainChain testnet has no counterpart of");
    const mainnet = resolveConfig({ BRAINCHAIN_NETWORK: "mainnet" });
    expect(bondsClosed(mainnet)).toContain("BrainChain's ProofIndex on Robinhood Chain, which a bond's check reads, is not deployed");
    const chain = fakeChain({ task: task() });
    const connect = vi.fn(() => chain);
    const bonds = createBonds({ config: mainnet, signer: () => account, limits: createLimits(mainnet, () => account), connect });
    await expect(bonds.bond(12n, USDG(5))).rejects.toThrow("Delivery bonds are not open yet");
    await expect(bonds.status(12n)).rejects.toThrow("Delivery bonds are not open yet");
    expect(connect).not.toHaveBeenCalled();
  });
});

describe("bond status", () => {
  it("says where each bond stands and what comes next", async () => {
    const deadline = NOW + 86_400n;
    const { bonds } = setup(fakeChain({ bonds: [view({ deadline }), view({ deed: 3n, deadline, checkMetAt: NOW - 600n }), view({ deed: 2n, deadline: NOW - 1n })], proof: 101n }));
    const status = (await bonds.status(12n)) as { proofIndexed: boolean; bonds: Record<string, unknown>[] };
    expect(status.proofIndexed).toBe(true);
    expect(status.bonds).toEqual([
      { bond: "4", amount: "5 USDG", deadline: "2027-01-16T08:00:00.000Z", state: "open", next: "The Proof is in the index; BrainChain marks the check shortly." },
      { bond: "3", amount: "5 USDG", deadline: "2027-01-16T08:00:00.000Z", state: "marked", markedAt: "2027-01-15T07:50:00.000Z", next: "BrainChain confirms the check after 2027-01-15T08:50:00.000Z, and the bond settles as delivered." },
      { bond: "2", amount: "5 USDG", deadline: "2027-01-15T07:59:59.000Z", state: "lapsed", next: `No Proof was recorded by the deadline. The bond settles to the poster ${POSTER} after 2027-01-16T08:59:59.000Z.` },
    ]);
    expect(await setup(fakeChain()).bonds.status(12n)).toEqual({ task: "12", wallet: account.address, bonds: [] });
  });
});
