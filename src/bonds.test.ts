import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decodeAbiParameters, decodeFunctionData, encodeFunctionData, keccak256, numberToHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";

import { bondsClosed, createBondChain, createBonds, type BondChain, type BondView, type TaskFacts } from "./bonds.js";
import { resolveConfig } from "./config.js";
import { createLimits } from "./limits.js";
import { BOND_LEAD_SEC, bondTerms, DeedStatus, encodeCheckData, proofIndexAbi, Ruling, shippedAbi, taskOfCheck, TaskStatus } from "./shipped.js";

// Anvil's second default account: a public test key that holds nothing anywhere.
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const account = privateKeyToAccount(KEY);
const POSTER: Address = "0x00000000000000000000000000000000000000d1";
const INDEX: Address = "0x00000000000000000000000000000000000000f1";
const TX: Hex = `0x${"fe".repeat(32)}`;
const USDG = (n: number) => BigInt(Math.round(n * 1_000_000));
const NOW = 1_800_000_000n;
const MISSED_TO = "the agent that paid BrainChain's desk for the task, or to the poster for a task posted on the board directly";

const task = (overrides: Partial<TaskFacts> = {}): TaskFacts => ({ poster: POSTER, bounty: USDG(1), deadline: NOW + 86_400n, status: TaskStatus.Hired, model: `0x${"0".repeat(24)}${account.address.slice(2)}`, ...overrides });
const view = (overrides: Partial<BondView> = {}): BondView => ({ deed: 4n, amount: USDG(5), deadline: NOW + 86_400n + BOND_LEAD_SEC, status: DeedStatus.Open, remainderBps: 0, checkMetAt: 0n, settledAt: 0n, refundTo: POSTER, ...overrides });

function fakeChain(options: { task?: TaskFacts; bonds?: BondView[]; usdg?: bigint; eth?: bigint; allowance?: bigint; proof?: bigint; payer?: Address; owed?: bigint } = {}) {
  return {
    account: account.address,
    task: vi.fn(async () => options.task),
    now: vi.fn(async () => NOW),
    usdgBalance: vi.fn(async () => options.usdg ?? USDG(100)),
    ethBalance: vi.fn(async () => options.eth ?? 10n ** 16n),
    gasPrice: vi.fn(async () => 20_000_000n),
    allowance: vi.fn(async () => options.allowance ?? 0n),
    approve: vi.fn(async () => TX),
    create: vi.fn(async (): ReturnType<BondChain["create"]> => ({ deed: 7n, tx: TX })),
    bondsOn: vi.fn(async () => options.bonds ?? []),
    proofOf: vi.fn(async () => options.proof ?? 0n),
    owed: vi.fn(async () => options.owed ?? 0n),
    payerOf: vi.fn(async () => options.payer),
  } satisfies BondChain;
}

const offline = (async () => {
  throw new Error("no network in tests");
}) as unknown as typeof fetch;
const answering = (body: unknown) => (async () => ({ ok: true, json: async () => body })) as unknown as typeof fetch;

function setup(chain: BondChain, env: Record<string, string> = {}, fetchImpl: typeof fetch = offline) {
  const config = resolveConfig({ BRAINCHAIN_NETWORK: "mainnet", BRAINCHAIN_BUDGET_UNITS: "20000000", ...env });
  const open = { ...config, bonds: { ...config.bonds!, proofIndex: INDEX } };
  const limits = createLimits(open, () => account);
  return { bonds: createBonds({ config: open, signer: () => account, limits, connect: () => chain, fetch: fetchImpl }), limits, config: open };
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
      missed: `5 USDG to ${POSTER}, the poster, as the task was posted on the board directly, if no Proof is recorded by the deadline`,
      next: "Follow it with brainchain_bond_status. A worker's settled bonds, delivered and missed, are part of what Jev reads at later hires.",
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
    expect(reply.missed).toBe(`5 USDG to ${payer}, the agent that paid BrainChain's desk for the task, if no Proof is recorded by the deadline`);
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
      [fakeChain({ task: task({ status: 6 }) }), USDG(5), "Task 12 is not hired to this wallet"],
      [fakeChain({ task: task({ deadline: NOW - 1n }) }), USDG(5), "deadline, 2027-01-15T07:59:59.000Z, has passed"],
      [fakeChain({ task: task(), bonds: [view()] }), USDG(5), "This wallet already has bond 4 open on task 12; brainchain_bond_status shows it. Nothing was bonded."],
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

  it("keeps a bond that was sent but not confirmed counted against the budget and the daily limit, and says it may be placed", async () => {
    const unconfirmed = `Timed out while waiting for transaction with hash "${TX}" to be confirmed`;
    const chain = fakeChain({ task: task() });
    chain.create.mockResolvedValue({ tx: TX, unconfirmed });
    const stateDir = await mkdtemp(join(tmpdir(), "brainchain-mcp-"));
    const { bonds, limits } = setup(chain, { BRAINCHAIN_BUDGET_UNITS: "10000000", BRAINCHAIN_DAILY_UNITS: "10000000", BRAINCHAIN_STATE_DIR: stateDir });
    expect(await bonds.bond(12n, USDG(10))).toEqual({
      possiblyBonded: true,
      tx: TX,
      task: "12",
      amount: "10 USDG",
      error: `The bond was sent in ${TX} but could not be confirmed (${unconfirmed}). It may have been placed. Read task 12 with brainchain_bond_status; do not bond it again.`,
    });
    expect(limits.spent()).toBe(USDG(10));
    expect(await limits.spentToday()).toBe(USDG(10));
    await expect(bonds.bond(12n, USDG(10))).rejects.toThrow("This server has already signed payments and bonds for 10 of its 10 USDG budget.");
    expect(chain.create).toHaveBeenCalledOnce();

    // A bond that reverted, or was never sent, gives its amount back.
    const reverted = fakeChain({ task: task() });
    reverted.create.mockRejectedValue(new Error(`Transaction ${TX} reverted. Nothing was bonded.`));
    const after = setup(reverted);
    await expect(after.bonds.bond(12n, USDG(5))).rejects.toThrow("reverted. Nothing was bonded.");
    expect(after.limits.spent()).toBe(0n);
  });

  it("refuses a second bond on a task while the first is being placed, and sends one", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const chain = fakeChain({ task: task() });
    chain.create.mockImplementation(async () => {
      await gate;
      return { deed: 7n, tx: TX };
    });
    const { bonds, limits } = setup(chain);
    const first = bonds.bond(12n, USDG(2));
    await expect(bonds.bond(12n, USDG(2))).rejects.toThrow("This server is already placing a bond on task 12. Wait for that call's reply; this call bonded nothing.");
    // Another task is not held up.
    const other = bonds.bond(13n, USDG(2));
    release();
    expect(await first).toMatchObject({ bond: "7", task: "12" });
    expect(await other).toMatchObject({ task: "13" });
    expect(chain.create).toHaveBeenCalledTimes(2);
    expect(limits.spent()).toBe(USDG(4));
    // Once the first call has answered, the task is free for the chain's own open-bond check.
    await bonds.bond(12n, USDG(2));
    expect(chain.create).toHaveBeenCalledTimes(3);
  });

  it("refuses to bond when the desk names the payer for another task board", async () => {
    const live = resolveConfig({ BRAINCHAIN_NETWORK: "mainnet" }).bonds!;
    const payer: Address = "0x00000000000000000000000000000000000000e1";
    const other: Address = "0x44b8464342Bbfb9B565FAE494DfDefa37D33A211";
    const asked = (board: unknown) => createBondChain(live, account, "https://desk.example", answering({ board, task: "12", refundTo: payer })).payerOf(12n);
    expect(await asked(live.brainchain.board)).toBe(payer);
    expect(await asked(live.brainchain.board.toLowerCase())).toBe(payer);
    expect(await createBondChain(live, account, "https://desk.example", answering({ board: live.brainchain.board.toUpperCase().replace("0X", "0x"), task: "12", refundTo: null })).payerOf(12n)).toBeUndefined();
    await expect(asked(other)).rejects.toThrow(
      `The desk at https://desk.example answered for the task board ${other}, and this server reads task 12 from ${live.brainchain.board}, so who paid for the task cannot be told. Nothing was bonded.`,
    );
    for (const board of [undefined, null, 7]) await expect(asked(board)).rejects.toThrow("answered for an unnamed task board");

    const chain = fakeChain({ task: task() });
    chain.payerOf.mockImplementation(() => asked(other));
    const { bonds, limits } = setup(chain);
    await expect(bonds.bond(12n, USDG(5))).rejects.toThrow("Nothing was bonded.");
    expect(chain.approve).not.toHaveBeenCalled();
    expect(chain.create).not.toHaveBeenCalled();
    expect(limits.spent()).toBe(0n);
  });

  it("is closed on testnet and until the index is deployed, without touching the chain", async () => {
    const testnet = resolveConfig({ BRAINCHAIN_NETWORK: "testnet" });
    expect(bondsClosed(testnet)).toContain("BrainChain testnet has no counterpart of");
    const live = resolveConfig({ BRAINCHAIN_NETWORK: "mainnet" });
    expect(bondsClosed(live)).toBeUndefined();
    const mainnet = { ...live, bonds: { ...live.bonds!, proofIndex: undefined } };
    expect(bondsClosed(mainnet)).toContain("BrainChain's ProofIndex on Robinhood Chain, which a bond's check reads, is not deployed");
    const chain = fakeChain({ task: task() });
    const connect = vi.fn(() => chain);
    const bonds = createBonds({ config: mainnet, signer: () => account, limits: createLimits(mainnet, () => account), connect, fetch: offline });
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
      { bond: "2", amount: "5 USDG", deadline: "2027-01-15T07:59:59.000Z", state: "lapsed", next: `No Proof was recorded by the bond's deadline. The bond settles after 2027-01-16T08:59:59.000Z to ${MISSED_TO}: ${POSTER}.` },
    ]);
    expect(await setup(fakeChain()).bonds.status(12n)).toEqual({ task: "12", wallet: account.address, bonds: [] });
  });

  it("says a delivered bond was collected once the registry owes the wallet nothing, and never tells it to claim what is not there", async () => {
    const delivered = view({ status: DeedStatus.Settled, remainderBps: 10_000, settledAt: NOW });
    const collected = fakeChain({ bonds: [delivered], owed: 0n });
    const status = (await setup(collected).bonds.status(12n)) as { bonds: Record<string, unknown>[] };
    expect(status.bonds).toEqual([
      { bond: "4", amount: "5 USDG", deadline: "2027-01-18T08:00:00.000Z", state: "delivered", settledAt: "2027-01-15T08:00:00.000Z", back: "4.95 USDG", next: "The bond less Shipped's 1% fee was collected: the registry owes this wallet nothing." },
    ]);
    expect(collected.owed).toHaveBeenCalledOnce();
  });

  it("names what the registry owes in all, since one sum covers every bond of the wallet", async () => {
    // Two delivered bonds, 4.95 and 1.98 USDG back; the first was collected, so the registry owes the second alone.
    const bonds = [view({ status: DeedStatus.Settled, remainderBps: 10_000, settledAt: NOW }), view({ deed: 3n, amount: USDG(2), status: DeedStatus.Settled, remainderBps: 10_000, settledAt: NOW })];
    const chain = fakeChain({ bonds, owed: USDG(1.98) });
    const status = (await setup(chain).bonds.status(12n)) as { bonds: { back: string; next: string }[] };
    const next = "The bond less Shipped's 1% fee was credited to this wallet on the registry, which owes it 1.98 USDG in all; the worker CLI's `bond claim` collects that.";
    expect(status.bonds.map((b) => [b.back, b.next])).toEqual([
      ["4.95 USDG", next],
      ["1.98 USDG", next],
    ]);
    expect(chain.owed).toHaveBeenCalledOnce();
    const none = fakeChain({ bonds: [view()] });
    await setup(none).bonds.status(12n);
    expect(none.owed).not.toHaveBeenCalled();
  });

  it("says a missed bond went to the address it names, and who that is", async () => {
    const status = (await setup(fakeChain({ bonds: [view({ status: DeedStatus.Settled, remainderBps: 0, settledAt: NOW })] })).bonds.status(12n)) as { bonds: Record<string, unknown>[] };
    expect(status.bonds[0]).toMatchObject({ state: "missed", paidTo: POSTER, next: `No Proof was recorded by the bond's deadline, so the bond went to ${MISSED_TO}: ${POSTER}.` });
  });

  it("words an open bond by where its task stands: refunded, paid, or still to be paid", async () => {
    const next = async (status: number) => ((await setup(fakeChain({ task: task({ status }), bonds: [view()] })).bonds.status(12n)) as { bonds: { state: string; next: string }[] }).bonds[0];
    expect(await next(TaskStatus.Refunded)).toEqual(expect.objectContaining({ state: "open", next: `The task was refunded, so no Proof will be recorded. The bond settles after 2027-01-19T09:00:00.000Z to ${MISSED_TO}: ${POSTER}.` }));
    expect(await next(TaskStatus.Paid)).toEqual(expect.objectContaining({ state: "open", next: "The task is paid; waiting for its Proof to be minted and recorded." }));
    expect(await next(TaskStatus.Hired)).toEqual(expect.objectContaining({ state: "open", next: "Waiting for the task to be paid and its Proof recorded." }));
    expect(TaskStatus).toEqual({ Open: 1, Hired: 2, Paid: 6, Refunded: 7 });
  });
});

/** A JSON-RPC node on this machine that takes any transaction and answers the rest as `answers` says. */
async function fakeNode(answers: Record<string, (params: unknown[]) => unknown>) {
  const sent: Hex[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const { id, method, params } = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: number; method: string; params: unknown[] };
    const reply = (body: object) => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, ...body }));
    if (method === "eth_sendRawTransaction") {
      sent.push(params[0] as Hex);
      return reply({ result: keccak256(params[0] as Hex) });
    }
    try {
      if (!answers[method]) throw new Error(`no ${method} here`);
      reply({ result: answers[method](params) });
    } catch (error) {
      reply({ error: { code: -32000, message: (error as Error).message } });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const close = () => {
    server.closeAllConnections();
    server.close();
  };
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, sent, close };
}

describe("the chain behind a bond", () => {
  it("hands back the hash of a transaction it sent when the receipt cannot be read, and reads what the registry owes the wallet", async () => {
    const live = resolveConfig({ BRAINCHAIN_NETWORK: "mainnet" }).bonds!;
    const calls: { to: string; data: string }[] = [];
    const node = await fakeNode({
      eth_chainId: () => numberToHex(4663),
      eth_getTransactionCount: () => "0x0",
      eth_getBlockByNumber: () => ({ number: "0x1", timestamp: "0x1", baseFeePerGas: "0x1" }),
      eth_maxPriorityFeePerGas: () => "0x1",
      eth_estimateGas: () => "0x186a0",
      eth_blockNumber: () => "0x2",
      // Sent and still pending, on a node that cannot say more.
      eth_getTransactionByHash: ([hash]) => ({ hash, from: account.address, nonce: "0x0", blockNumber: null }),
      eth_getTransactionReceipt: () => {
        throw new Error("the node has no receipts");
      },
      eth_call: ([call]) => {
        calls.push(call as { to: string; data: string });
        return numberToHex(USDG(1.98), { size: 32 });
      },
    });
    try {
      const chain = createBondChain({ ...live, rpc: node.url }, account, "https://desk.example", offline);
      const terms = bondTerms({ check: live.check, proofIndex: INDEX, usdg: live.usdg }, { id: 12n, refundTo: POSTER, paidThroughDesk: false, deadline: NOW }, { address: live.brainchain.board, chainId: live.brainchain.chainId });
      const made = await chain.create(terms, USDG(5));
      expect(node.sent).toHaveLength(1);
      expect(made).toEqual({ tx: keccak256(node.sent[0]!), unconfirmed: expect.stringMatching(/\S/) });
      await expect(chain.approve(USDG(5))).rejects.toThrow(/^The approval 0x[0-9a-f]{64} was sent but could not be confirmed \(.+\), so the bond was not sent\. Nothing was bonded\.$/);
      expect(node.sent).toHaveLength(2);

      expect(await chain.owed()).toBe(USDG(1.98));
      expect(calls.map(({ to, data }) => [to.toLowerCase(), data])).toEqual([[live.registry.toLowerCase(), encodeFunctionData({ abi: shippedAbi, functionName: "owed", args: [account.address, live.usdg] })]]);
    } finally {
      node.close();
    }
  });
});

describe("deed page", () => {
  it("names a bond by Shipped's number and page when the API knows it", async () => {
    const page = answering({ deed: { number: "3", url: "https://app.shipped.bond/bonds/3" } });
    const made = await setup(fakeChain({ task: task() }), {}, page).bonds.bond(12n, USDG(5));
    expect(made).toMatchObject({ bond: "7", number: "3", url: "https://app.shipped.bond/bonds/3" });
    const status = await setup(fakeChain({ task: task(), bonds: [view()] }), {}, page).bonds.status(12n);
    expect(status.bonds[0]).toMatchObject({ bond: "4", number: "3", url: "https://app.shipped.bond/bonds/3" });
  });
});
