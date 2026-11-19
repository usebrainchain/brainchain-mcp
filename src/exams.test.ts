import { readFileSync } from "node:fs";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { keccak256, recoverMessageAddress, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { resolveConfig } from "./config.js";
import { briefsMessage, MAX_WORK_BYTES, RECORD_PAGE, resultMessage, sittingGuidance, sittingMessage } from "./exams.js";
import { createDesk, orderIdOf } from "./payments.js";
import {
  AGENT_RECORD_NAME,
  AGENT_RECORD_TOOL,
  callTool,
  checkWork,
  EXAM_INFO_NAME,
  EXAM_INFO_TOOL,
  EXAM_STATUS_NAME,
  EXAM_STATUS_TOOL,
  EXAM_SUBMIT_NAME,
  examSubmitTool,
  LICENCES_NAME,
  LICENCES_TOOL,
  SIT_EXAM_NAME,
  sitExamTool,
  type Desk,
} from "./tools.js";

// Anvil's second default account: a public test key that holds nothing anywhere.
const signer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const config = resolveConfig({ BRAINCHAIN_NETWORK: "testnet" });
const exams = `${config.desk}/x402/exams`;
const PRICE = "5000000";
const request = { agentId: "20424", class: "code", price: 5_000_000n };
const SITTING = `0x${"5a".repeat(32)}`;
// Far ahead, so a sitting in these tests is open whenever they run: 1 January 2100, and two hours after it.
const OPENED = 4_102_444_800;
const DEADLINE = OPENED + 7_200;
const EXPIRES = OPENED + 60 * 86_400;

function challenge(amount: string, payTo: string = config.payTo): string {
  const accepts = [{ scheme: "exact", network: config.network, amount, asset: config.asset, payTo, maxTimeoutSeconds: 300, extra: { assetTransferMethod: "permit2" } }];
  return Buffer.from(JSON.stringify({ x402Version: 2, error: "Payment required", resource: { url: exams, mimeType: "application/json" }, accepts })).toString("base64");
}

interface Paid {
  header: string;
  body: string;
  id: string;
}

/**
 * A desk that states `price` to a request with no payment and hands a paid one to `paid`, with how many paid
 * requests came before it. `asked` is what the real request is quoted, when that differs from the price first read.
 * `refuse` is what the desk says of a real request before it asks for payment, when it will not open the sitting.
 */
function fakeDesk(
  paid: (sent: Paid, earlier: number) => Response | Promise<Response>,
  { price = PRICE, asked = price, payTo = config.payTo as string, refuse, read }: { price?: string; asked?: string; payTo?: string; refuse?: () => Response; read?: (url: string) => Response } = {},
) {
  const seen: Paid[] = [];
  const unpaid: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    // Anything but the paid route is a free read, such as a sitting's briefs.
    if (req.url !== exams && read) return read(req.url);
    if (req.url !== exams) throw new Error(`unexpected request to ${req.url}`);
    const body = await req.text();
    const header = req.headers.get("payment-signature");
    if (!header) {
      unpaid.push(body);
      // An empty request is always quoted; a real one is refused first when the sitting cannot open.
      if (body !== "{}" && refuse) return refuse();
      return new Response("{}", { status: 402, headers: { "payment-required": challenge(body === "{}" ? price : asked, payTo) } });
    }
    const sent = { header, body, id: orderIdOf(JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { payload: unknown }) };
    seen.push(sent);
    return paid(sent, seen.length - 1);
  }) as typeof fetch;
  return { fetchImpl, seen, unpaid };
}

const briefs = [0, 1, 2, 3, 4].map((index) => ({ index, title: `Item ${index}`, brief: `Write f${index}(x).\n\nReturn only the function, in one Python code block.`, state: "open" }));
const view = (id: string, extra: Record<string, unknown> = {}) => ({
  sitting: id,
  status: `${config.desk}/exams/${id}`,
  agent: { chainId: 46630, registry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432", id: "20424" },
  class: "code",
  state: "open",
  openedAt: OPENED,
  deadline: DEADLINE,
  passMark: 4,
  items: briefs.map(({ index, title, state }) => ({ index, title, state, submit: `${config.desk}/exams/${id}/items/${index}` })),
  ...extra,
});
const opened = (sent: Paid) => new Response(JSON.stringify({ ...view(sent.id), briefs }));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const desk = (fetchImpl: typeof fetch, overrides: Partial<typeof config> = {}) =>
  createDesk({ config: { ...config, ...overrides }, signer, approveCommand: "npx -y brainchain-mcp approve", fetch: fetchImpl, postTimeoutMs: 2_000, askAgainMs: 5 });

describe("the messages an agent's wallet signs", () => {
  it("are built as the desk builds them", () => {
    expect(sittingMessage(274663, { chainId: 4663, id: "20424" }, "code", 1_800_000_000)).toBe("BrainChain exam v1\nchain 274663\nagent 4663:20424\nclass code\nat 1800000000");
    expect(resultMessage(274663, SITTING.toUpperCase().replace("0X", "0x"), 3, "```python\ndef f(x):\n    return x\n```")).toBe(
      `BrainChain exam result v1\nchain 274663\nsitting ${SITTING}\nitem 3\nhash ${keccak256(toBytes("```python\ndef f(x):\n    return x\n```"))}`,
    );
    expect(briefsMessage(274630, SITTING, 1_800_000_000)).toBe(`BrainChain exam briefs v1\nchain 274630\nsitting ${SITTING}\nat 1800000000`);
  });

  it("name BrainChain's chain and the chain the agent's id is on, whichever chain the server pays on", () => {
    expect(resolveConfig({})).toMatchObject({ brainchainId: 274663, identityChainId: 4663 });
    expect(resolveConfig({ BRAINCHAIN_PAY_ON: "base" })).toMatchObject({ chainId: 8453, brainchainId: 274663, identityChainId: 4663 });
    expect(resolveConfig({ BRAINCHAIN_NETWORK: "testnet", BRAINCHAIN_PAY_ON: "base" })).toMatchObject({ brainchainId: 274630, identityChainId: 46630 });
  });
});

describe("sitting the exam", () => {
  it("reads the price, signs the request with the paying key, pays that price once and returns the sitting with its briefs", async () => {
    const { fetchImpl, seen, unpaid } = fakeDesk(opened);
    const d = desk(fetchImpl);
    const reply = (await d.sit(request)) as Record<string, unknown>;
    expect(seen).toHaveLength(1);
    // The price was read with an empty request, then the real one was sent, quoted and paid.
    expect(unpaid[0]).toBe("{}");
    expect(unpaid[1]).toBe(seen[0]!.body);
    const sent = JSON.parse(seen[0]!.body) as { agent: { chainId: number; id: string }; class: string; wallet: string; at: number; signature: `0x${string}` };
    expect(sent).toMatchObject({ agent: { chainId: 46630, id: "20424" }, class: "code", wallet: signer.address });
    expect(Math.abs(sent.at - Date.now() / 1000)).toBeLessThan(60);
    expect(await recoverMessageAddress({ message: sittingMessage(274630, sent.agent, "code", sent.at), signature: sent.signature })).toBe(signer.address);
    const payment = JSON.parse(Buffer.from(seen[0]!.header, "base64").toString("utf8")) as { accepted: { amount: string; payTo: string } };
    expect(payment.accepted).toMatchObject({ amount: PRICE, payTo: config.payTo });
    expect(reply).toMatchObject({ sitting: seen[0]!.id, price: "5 test USDG", statusUrl: `${config.desk}/exams/${seen[0]!.id}`, deadline: DEADLINE, done: false });
    expect(reply.briefs).toEqual(briefs);
    expect(reply.next).toMatch(/^Deliver items 0, 1, 2, 3 and 4 with brainchain_exam_submit before 2100-01-01T02:00:00Z\. Each item takes one delivery/);
    expect(d.spent()).toBe(5_000_000n);
  });

  it("pays a price above the limit per payment for a sitting alone, and never above the price it read", async () => {
    expect(config.maxPrice).toBe(1_000_000n);
    const raised = fakeDesk(opened, { asked: "5000001" });
    const d = desk(raised.fetchImpl);
    await expect(d.sit(request)).rejects.toThrow("The desk's price for a sitting changed between reading it and paying it, so nothing was signed. Read the price again with brainchain_exam_info and sit again with it. Nothing was charged.");
    expect(raised.seen).toHaveLength(0);
    expect(d.spent()).toBe(0n);
    // The limit moved for the sitting and for nothing else: a task quoted above it is still refused.
    const tasks = desk((async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      return req.headers.get("payment-signature") ? json({}) : new Response("{}", { status: 402, headers: { "payment-required": challenge(PRICE) } });
    }) as typeof fetch);
    await expect(tasks.post({ title: "T", brief: "B", levels: ["Good", "Bad"] })).rejects.toThrow(/above this server's limit of 1 test USDG/);
  });

  it("holds a sitting to a limit per payment the operator set, and to its price under a higher one", async () => {
    expect(resolveConfig({})).toMatchObject({ maxPrice: 1_000_000n, maxPriceSet: false });
    expect(resolveConfig({ BRAINCHAIN_MAX_PRICE_UNITS: "1000000" }).maxPriceSet).toBe(true);
    expect(resolveConfig({ BRAINCHAIN_MAX_PRICE_UNITS: " " }).maxPriceSet).toBe(false);
    const { fetchImpl, seen } = fakeDesk(opened);
    const held = desk(fetchImpl, { maxPrice: 3_000_000n, maxPriceSet: true });
    await expect(held.sit(request)).rejects.toThrow(
      "A sitting costs 5 test USDG, more than the 3 test USDG this server may pay at once (BRAINCHAIN_MAX_PRICE_UNITS). Ask your operator to raise BRAINCHAIN_MAX_PRICE_UNITS and restart the server. Nothing was charged.",
    );
    expect(seen).toHaveLength(0);
    // A limit above the price allows the sitting, at its price and no more.
    const dearer = fakeDesk(opened, { asked: "6000000" });
    await expect(desk(dearer.fetchImpl, { maxPrice: 8_000_000n, maxPriceSet: true }).sit(request)).rejects.toThrow(/changed between reading it and paying it, so nothing was signed\./);
    expect(dearer.seen).toHaveLength(0);
    const allowed = desk(fetchImpl, { maxPrice: 8_000_000n, maxPriceSet: true });
    expect(await allowed.sit(request)).toMatchObject({ price: "5 test USDG" });
    expect(allowed.spent()).toBe(5_000_000n);
  });

  it("refuses a price the budget or the daily limit cannot hold, before anything is signed", async () => {
    const { fetchImpl, seen } = fakeDesk(opened);
    const small = desk(fetchImpl, { budget: 4_000_000n });
    await expect(small.sit(request)).rejects.toThrow(
      "A sitting costs 5 test USDG, more than this server's budget of 4 test USDG per run (BRAINCHAIN_BUDGET_UNITS). Ask your operator to raise BRAINCHAIN_BUDGET_UNITS and restart the server. Nothing was charged.",
    );
    const capped = desk(fetchImpl, { daily: 2_000_000n, stateDir: await mkdtemp(join(tmpdir(), "brainchain-mcp-")) });
    await expect(capped.sit(request)).rejects.toThrow("A sitting costs 5 test USDG, more than this wallet's daily limit of 2 test USDG (BRAINCHAIN_DAILY_UNITS).");
    expect(seen).toHaveLength(0);
    expect(small.spent()).toBe(0n);
  });

  it("counts a sitting against the budget and the daily limit, as a task is counted", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "brainchain-mcp-"));
    const { fetchImpl, seen } = fakeDesk(opened);
    const d = desk(fetchImpl, { budget: 9_000_000n, daily: 20_000_000n, stateDir });
    await d.sit(request);
    expect(JSON.parse(await readFile(join(stateDir, `spend-testnet-${signer.address.toLowerCase()}.json`), "utf8"))).toMatchObject({ units: PRICE });
    // 5 of the 9 are spent, so a second sitting does not fit.
    await expect(d.sit({ ...request, agentId: "20425" })).rejects.toThrow(/already signed payments for 5 of its 9 test USDG budget.*Nothing was charged\.$/);
    expect(seen).toHaveLength(1);
    expect(d.spent()).toBe(5_000_000n);
  });

  it("pays the desk alone", async () => {
    const { fetchImpl, seen } = fakeDesk(opened, { payTo: "0x000000000000000000000000000000000000dEaD" });
    await expect(desk(fetchImpl).sit(request)).rejects.toThrow(/it named 0x000000000000000000000000000000000000dEaD as the payee, and this server pays only/);
    expect(seen).toHaveLength(0);
  });

  it("refuses a desk that asks more than the price the agent was given, before anything is signed, and pays a lower one as asked", async () => {
    const dearer = fakeDesk(opened, { price: "6000000" });
    const d = desk(dearer.fetchImpl);
    await expect(d.sit(request)).rejects.toThrow(
      'A sitting now costs 6 test USDG (6000000 base units), more than the 5 test USDG (5000000 base units) passed as price, so nothing was signed. To pay the new price, call brainchain_sit_exam again with price "6000000". Nothing was charged.',
    );
    // A price in units that reads as a fraction of the token is said as both.
    await expect(desk(fakeDesk(opened, { price: "900000" }).fetchImpl).sit({ ...request, price: 899_999n })).rejects.toThrow(/^A sitting now costs 0\.9 test USDG \(900000 base units\), more than the 0\.899999 test USDG \(899999 base units\) passed as price,/);
    // Only the price was read: the request itself was never sent.
    expect(dearer.unpaid).toEqual(["{}"]);
    expect(dearer.seen).toHaveLength(0);
    expect(d.spent()).toBe(0n);
    const cheaper = fakeDesk(opened, { price: "4000000" });
    const paid = desk(cheaper.fetchImpl);
    expect(await paid.sit(request)).toMatchObject({ price: "4 test USDG" });
    expect(paid.spent()).toBe(4_000_000n);
  });

  it("says when the desk names no price for a sitting", async () => {
    const d = desk((async () => json({ error: "No such route." }, 404)) as typeof fetch);
    await expect(d.sit(request)).rejects.toThrow(/gave no price for a sitting on Robinhood Chain testnet, so nothing was signed\..*brainchain_exam_info shows which\. Nothing was charged\.$/);
  });

  it("hears the desk's refusal when the request first arrives, before anything is signed or counted", async () => {
    for (const [status, error] of [
      [403, `Wallet ${signer.address} does not hold agent 20424: it is neither its controller nor its registered wallet. Nothing was charged.`],
      [409, "Agent 20424 holds a code licence until 2100-03-02 00:00 UTC. It may sit again from 2100-02-16 00:00 UTC. Nothing was charged."],
      [503, "The agent's identity could not be read just now. Nothing was charged; try again."],
    ] as const) {
      const stateDir = await mkdtemp(join(tmpdir(), "brainchain-mcp-"));
      const { fetchImpl, seen, unpaid } = fakeDesk(opened, { refuse: () => json({ error }, status) });
      const d = desk(fetchImpl, { daily: 20_000_000n, stateDir });
      expect(await d.sit(request).catch((e: Error) => e.message)).toBe(error);
      // The price was read, the request was sent once without a payment, and no payment was ever signed.
      expect(unpaid).toHaveLength(2);
      expect(seen).toHaveLength(0);
      expect(d.spent()).toBe(0n);
      // Nothing was reserved, so the daily limit has no record to keep.
      expect(await readdir(stateDir)).toEqual([]);
    }
  });

  it("names the sitting that is already paid for and opening, in place of paying for a second", async () => {
    const other = `0x${"0d".repeat(32)}`;
    const refusal = () => json({ error: "A sitting for agent 20424 is already paid for and being opened. Send the request that paid for it again to read it. Nothing was charged.", sitting: other }, 409);
    const message = "The sitting is paid for and its items are being drawn. Send the request that paid for it again to read it; it is not charged twice.";
    // Until the sitting is open its briefs address says where it stands, as its own address does.
    const read = (url: string) => (url.startsWith(`${config.desk}/exams/${other}/briefs?`) ? json({ error: message, sitting: other, state: "opening", payment: "paid", message }, 409) : json({ error: "Not found." }, 404));
    const told = {
      sitting: other,
      statusUrl: `${config.desk}/exams/${other}`,
      state: "opening",
      payment: "paid",
      done: false,
      next:
        "The sitting is paid for, and BrainChain is opening it. This server no longer holds the payment that bought the sitting, so it cannot fetch the briefs with it. " +
        "Once the sitting is open, brainchain_exam_status with briefs: true reads them, signed by the wallet that sits it.",
      retryAfterSeconds: 30,
    };
    // Told when the request first arrives, as a server that was restarted is.
    const first = fakeDesk(opened, { refuse: refusal, read });
    const d = desk(first.fetchImpl);
    expect(await d.sit(request)).toEqual(told);
    expect(first.seen).toHaveLength(0);
    expect(d.spent()).toBe(0n);
    // Or with the payment, when another payment for the agent arrived between the offer and this one: it is not taken.
    const late = fakeDesk(refusal, { read });
    const paying = desk(late.fetchImpl);
    expect(await paying.sit(request)).toEqual(told);
    expect(late.seen).toHaveLength(1);
    expect(paying.spent()).toBe(0n);
    // Neither reply is kept as this call's answer: the next call asks the desk again.
    expect(await d.sit(request)).toEqual(told);
    expect(first.unpaid).toHaveLength(4);
    // A sitting this wallet cannot read is still named, so the agent can read where it stands itself.
    const unread = fakeDesk(opened, { refuse: refusal, read: () => json({ error: "The signature is not the sitting wallet's signature of the briefs message." }, 403) });
    expect(await desk(unread.fetchImpl).sit(request).catch((e: Error) => e.message)).toBe(
      `A sitting for agent 20424 is already paid for and being opened. Send the request that paid for it again to read it. Nothing was charged. The sitting is ${other}, and brainchain_exam_status reads where it stands.`,
    );
  });

  it("returns the sitting an agent already has open, with its briefs, when this wallet sits it", async () => {
    const error = `Agent 20424 has a sitting open until 2100-01-01 02:00 UTC: ${config.desk}/exams/${SITTING}. Nothing was charged.`;
    const refusal = () => json({ error, sitting: SITTING }, 409);
    const asked: string[] = [];
    const mine = fakeDesk(opened, { refuse: refusal, read: (url) => (asked.push(url), json({ ...view(SITTING), briefs })) });
    const d = desk(mine.fetchImpl);
    const reply = (await d.sit(request)) as Record<string, unknown>;
    expect(reply).toMatchObject({ sitting: SITTING, state: "open", deadline: DEADLINE, duplicate: true, done: false });
    expect(reply.briefs).toEqual(briefs);
    expect(reply.next).toMatch(/^Deliver items 0, 1, 2, 3 and 4 with brainchain_exam_submit/);
    // The briefs were read with this wallet's signature, and nothing was paid for them.
    const url = new URL(asked[0]!);
    expect(url.pathname).toBe(`/exams/${SITTING}/briefs`);
    expect(await recoverMessageAddress({ message: briefsMessage(274630, SITTING, Number(url.searchParams.get("at"))), signature: url.searchParams.get("signature") as `0x${string}` })).toBe(signer.address);
    expect(mine.seen).toHaveLength(0);
    expect(d.spent()).toBe(0n);
    // A sitting another wallet sits for the same agent cannot be read from here, so the desk's words stand as they are.
    const theirs = fakeDesk(opened, { refuse: refusal, read: () => json({ error: "The signature is not the sitting wallet's signature of the briefs message." }, 403) });
    expect(await desk(theirs.fetchImpl).sit(request).catch((e: Error) => e.message)).toBe(error);
  });

  it("says to call again in a minute when the desk has had too many unpaid requests from this address, with nothing signed", async () => {
    const limited = () => new Response(JSON.stringify({ error: "Too many requests from this address. Nothing was charged; try again in a minute." }), { status: 429, headers: { "retry-after": "60" } });
    const { fetchImpl, seen } = fakeDesk(opened, { refuse: limited });
    const d = desk(fetchImpl);
    expect(await d.sit(request)).toEqual({
      error: "The desk has had too many sitting requests from this address in the last minute, so it did not look at this one. Nothing was signed or charged.",
      done: false,
      next: "Call brainchain_sit_exam again after retryAfterSeconds.",
      retryAfterSeconds: 60,
    });
    expect(seen).toHaveLength(0);
    expect(d.spent()).toBe(0n);
  });

  it("passes on a refusal that comes with the payment, when something changed after the offer, in the desk's words and with nothing counted", async () => {
    for (const [status, error] of [
      [403, `Wallet ${signer.address} does not hold agent 20424: it is neither its controller nor its registered wallet. Nothing was charged.`],
      [409, "Agent 20424 has a sitting open until 2027-01-15 10:00 UTC: https://brain.testnet.usebrainchain.com/exams/0xabc. Nothing was charged."],
      [503, "The agent's identity could not be read just now. Nothing was charged; try again."],
    ] as const) {
      const { fetchImpl, seen } = fakeDesk(() => json({ error }, status));
      const d = desk(fetchImpl);
      const refused = await d.sit(request).catch((e: Error) => e.message);
      expect(refused).toBe(error);
      expect(seen).toHaveLength(1);
      expect(d.spent()).toBe(0n);
      // Nothing is kept of a refused sitting: the next call signs anew.
      await d.sit(request).catch(() => undefined);
      expect(seen).toHaveLength(2);
      expect(seen[1]!.header).not.toBe(seen[0]!.header);
    }
  });

  it("says nothing was charged for a request the desk cannot read", async () => {
    const paid = fakeDesk(() => json({ error: "agent.id is the agent's ERC-8004 id, as a decimal string." }, 400));
    const d = desk(paid.fetchImpl);
    await expect(d.sit(request)).rejects.toThrow(/^agent\.id is the agent's ERC-8004 id, as a decimal string\. Nothing was charged\.$/);
    expect(d.spent()).toBe(0n);
  });

  it("sends the same request with the same payment again while the desk draws the items, and pays once", async () => {
    for (const waiting of [
      json({ message: "The sitting is paid for and its items are being drawn. Send the same request again to read them; it is not charged twice.", sitting: SITTING, state: "paid" }, 202),
      json({ error: "The sitting is paid for, but its items could not be drawn just now.", sitting: SITTING, state: "paid" }, 502),
      json({ error: "This payment is already being processed. Send the same request again shortly.", sitting: SITTING, state: "paying" }, 409),
    ]) {
      const { fetchImpl, seen, unpaid } = fakeDesk((sent, earlier) => (earlier < 2 ? waiting.clone() : opened(sent)));
      const d = desk(fetchImpl);
      const reply = (await d.sit(request)) as Record<string, unknown>;
      expect(seen).toHaveLength(3);
      expect(new Set(seen.map((sent) => sent.header)).size).toBe(1);
      expect(new Set(seen.map((sent) => sent.body)).size).toBe(1);
      expect(unpaid).toHaveLength(2);
      expect(reply).toMatchObject({ sitting: seen[0]!.id, price: "5 test USDG" });
      expect(reply.briefs).toEqual(briefs);
      expect(d.spent()).toBe(5_000_000n);
    }
  });

  it("returns a paid sitting the desk has not opened in time, and asks for it with the same payment on the next call", async () => {
    let open = false;
    const said = "The sitting is paid for, but its items could not be drawn just now. It is retried until it opens; send the same request again to read it.";
    const { fetchImpl, seen, unpaid } = fakeDesk((sent) => (open ? opened(sent) : json({ error: said, sitting: sent.id, state: "paid", reason: "the pool has no item left to draw" }, 502)));
    const d = createDesk({ config, signer, approveCommand: "approve", fetch: fetchImpl, postTimeoutMs: 60, askAgainMs: 20 });
    const first = (await d.sit(request)) as Record<string, unknown>;
    expect(first).toEqual({
      sitting: seen[0]!.id,
      price: "5 test USDG",
      statusUrl: `${config.desk}/exams/${seen[0]!.id}`,
      state: "paid",
      reason: "the pool has no item left to draw",
      done: false,
      next: `${said} Call brainchain_sit_exam again with the same agentId and class: it sends the same request with the same payment, which the desk does not charge twice.`,
      retryAfterSeconds: 30,
    });

    const asked = seen.length;
    const probes = unpaid.length;
    open = true;
    const second = (await d.sit(request)) as Record<string, unknown>;
    expect(seen).toHaveLength(asked + 1);
    expect(unpaid).toHaveLength(probes);
    expect(new Set(seen.map((sent) => sent.header)).size).toBe(1);
    expect(second).toMatchObject({ sitting: seen[0]!.id, done: false });
    expect(second.briefs).toEqual(briefs);
    expect(d.spent()).toBe(5_000_000n);
  });

  it("names a sitting only when the desk has named it", async () => {
    const { fetchImpl, seen } = fakeDesk(() => {
      throw new TypeError("fetch failed");
    });
    const d = createDesk({
      config,
      signer,
      approveCommand: "approve",
      postTimeoutMs: 40,
      askAgainMs: 20,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => (String(input).startsWith(`${config.desk}/exams/`) ? json({ error: "Not found." }, 404) : fetchImpl(input, init))) as typeof fetch,
    });
    // The desk never answered, so there is no sitting to read, and the reply names none: the next call sends the payment again.
    const unconfirmed = (await d.sit(request)) as Record<string, unknown>;
    expect(seen).toHaveLength(1);
    expect(unconfirmed).toMatchObject({ price: "5 test USDG", possiblyCharged: true, done: false });
    expect(unconfirmed).not.toHaveProperty("sitting");
    expect(unconfirmed).not.toHaveProperty("statusUrl");
    // An id the desk does not know is no sitting, whatever this server paid.
    await expect(d.examStatus(seen[0]!.id, false)).rejects.toThrow("BrainChain has no sitting with this id.");
    // What the desk names while it opens the sitting is passed on as it named it.
    const waiting = fakeDesk(() => json({ message: "The sitting is paid for and its items are being drawn.", sitting: SITTING, state: "paid" }, 202));
    const told = (await createDesk({ config, signer, approveCommand: "approve", fetch: waiting.fetchImpl, postTimeoutMs: 40, askAgainMs: 20 }).sit(request)) as Record<string, unknown>;
    expect(told).toMatchObject({ sitting: SITTING, statusUrl: `${config.desk}/exams/${SITTING}`, state: "paid", done: false });
  });

  it("says exactly how to let Permit2 spend the sitting's price when the desk answers 412, with nothing charged, held or kept", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "brainchain-mcp-"));
    const { fetchImpl, seen } = fakeDesk(() => json({ error: "permit2_allowance_required" }, 412));
    const d = createDesk({ config: { ...config, daily: 20_000_000n, stateDir }, signer, approveCommand: "npx -y brainchain-mcp@0.15.0 approve", fetch: fetchImpl, postTimeoutMs: 2_000, askAgainMs: 5 });
    const said =
      "Permit2 is not yet approved to spend this wallet's test USDG for the 5 test USDG this sitting costs. Ask your operator to run `npx -y brainchain-mcp@0.15.0 approve 5` once with the key this server uses; it needs a little ETH on Robinhood Chain testnet. Nothing was charged.";
    await expect(d.sit(request)).rejects.toThrow(said);
    expect(d.spent()).toBe(0n);
    expect(JSON.parse(await readFile(join(stateDir, `spend-testnet-${signer.address.toLowerCase()}.json`), "utf8"))).toMatchObject({ units: "0" });
    // Nothing is kept of the refused payment: the next call signs a new one rather than sending the same one into the same 412.
    await expect(d.sit(request)).rejects.toThrow(said);
    expect(seen).toHaveLength(2);
    expect(seen[1]!.header).not.toBe(seen[0]!.header);
    // Any other 4xx the desk gives before it settles is a plain refusal too.
    const refused = fakeDesk(() => json({ error: "The request body is too large." }, 413));
    const other = desk(refused.fetchImpl);
    await expect(other.sit(request)).rejects.toThrow(/^The request body is too large\. Nothing was charged\.$/);
    expect(other.spent()).toBe(0n);
  });

  it("keeps a payment the desk did not confirm, and shows the same one again", async () => {
    let down = true;
    const { fetchImpl, seen } = fakeDesk((sent) => {
      if (down) throw new TypeError("fetch failed");
      return opened(sent);
    });
    const d = desk(fetchImpl);
    const first = (await d.sit(request)) as Record<string, unknown>;
    expect(first).toMatchObject({ possiblyCharged: true, done: false });
    expect(first).not.toHaveProperty("sitting");
    expect(first.error).toMatch(/^The desk did not confirm the sitting \(fetch failed\)\. The payment may have gone through\. Call brainchain_sit_exam again with the same agentId and class/);
    expect(d.spent()).toBe(5_000_000n);
    down = false;
    const second = (await d.sit(request)) as Record<string, unknown>;
    expect(seen.map((sent) => sent.header)).toEqual([seen[0]!.header, seen[0]!.header]);
    expect(second.briefs).toEqual(briefs);
    expect(d.spent()).toBe(5_000_000n);
  });

  it("gives the amount back when the desk turns out never to have taken the payment", async () => {
    let down = true;
    const { fetchImpl } = fakeDesk(() => {
      if (down) throw new TypeError("fetch failed");
      return json({ error: "permit2_deadline_expired" }, 402);
    });
    const d = desk(fetchImpl);
    await d.sit(request);
    expect(d.spent()).toBe(5_000_000n);
    down = false;
    await expect(d.sit(request)).rejects.toThrow("The desk refused the payment: permit2_deadline_expired. Nothing was charged.");
    expect(d.spent()).toBe(0n);
  });

  it("stops showing a payment the desk says it takes no more, and signs a new one on the next call", async () => {
    let answer: (sent: Paid) => Response = () => {
      throw new TypeError("fetch failed");
    };
    const { fetchImpl, seen } = fakeDesk((sent) => answer(sent));
    const d = desk(fetchImpl);
    await d.sit(request);
    answer = () => json({ error: "This payment was already used. Sign a new one." }, 409);
    await expect(d.sit(request)).rejects.toThrow("The desk will not take that payment again and holds no sitting for it (This payment was already used. Sign a new one). Call brainchain_sit_exam again to pay for a new sitting.");
    answer = opened;
    const third = (await d.sit(request)) as Record<string, unknown>;
    expect(seen.map((sent) => sent.header === seen[0]!.header)).toEqual([true, true, false]);
    expect(third.briefs).toEqual(briefs);
    // The first payment could not be shown to be uncharged, so it stays counted beside the second.
    expect(d.spent()).toBe(10_000_000n);
  });

  it("answers an identical call from the first sitting instead of paying again", async () => {
    const { fetchImpl, seen } = fakeDesk(opened);
    const d = desk(fetchImpl);
    const [first, parallel] = (await Promise.all([d.sit(request), d.sit(request)])) as Record<string, unknown>[];
    const again = (await d.sit(request)) as Record<string, unknown>;
    expect(seen).toHaveLength(1);
    expect(first).not.toHaveProperty("duplicate");
    expect(parallel).toMatchObject({ sitting: first!.sitting, duplicate: true });
    expect(again).toMatchObject({ sitting: first!.sitting, duplicate: true });
    // Another agent, or another class, is another sitting; another price for the same one is not.
    await d.sit({ ...request, price: 6_000_000n });
    expect(seen).toHaveLength(1);
    await d.sit({ ...request, agentId: "20425" });
    expect(seen).toHaveLength(2);
  });

  it("answers a sitting BrainChain could not run as void, with the refund owed, and sits again on the next call", async () => {
    const reason = "BrainChain could not open this sitting after it was paid for, so it is void. It does not count against the agent, which may sit again, and the payment goes back to the paying wallet.";
    const { fetchImpl, seen } = fakeDesk((sent, earlier) => (earlier === 0 ? json({ ...view(sent.id, { state: "void", deadline: OPENED, items: [], reason }), briefs: [] }) : opened(sent)));
    const d = desk(fetchImpl);
    const first = (await d.sit(request)) as Record<string, unknown>;
    expect(first).toMatchObject({ sitting: seen[0]!.id, state: "void", reason, done: true });
    expect(first.next).toBe(
      "The fee pays for the sitting, pass or fail. If BrainChain cannot open a paid sitting, or cannot judge enough of it to decide, the sitting is void: it does not count against the agent, and the payment goes back to the paying wallet. The agent may sit again now with brainchain_sit_exam. " +
        `If the payment has not arrived, write to hello@usebrainchain.com with the sitting id ${seen[0]!.id}.`,
    );
    // The refund is sent by hand, so the payment stays counted until then.
    expect(d.spent()).toBe(5_000_000n);
    // A void reply is never kept as the answer to the same call: the next one sits again.
    const second = (await d.sit(request)) as Record<string, unknown>;
    expect(seen).toHaveLength(2);
    expect(seen[1]!.header).not.toBe(seen[0]!.header);
    expect(second).toMatchObject({ sitting: seen[1]!.id, state: "open" });
  });

  it("takes the sitting the desk names when it answers with another payment's sitting, and gives this payment's amount back", async () => {
    const other = `0x${"0e".repeat(32)}`;
    const { fetchImpl } = fakeDesk(() => json({ ...view(other), briefs }));
    const d = desk(fetchImpl);
    expect(await d.sit(request)).toMatchObject({ sitting: other, statusUrl: `${config.desk}/exams/${other}`, duplicate: true, price: "0 test USDG" });
    expect(d.spent()).toBe(0n);
  });

  /** A desk that holds the first payment and draws no items until `state` says how the sitting stands. */
  function holding() {
    let state: "drawing" | "open" | "unpaid" | "failed" | "void" = "drawing";
    const ended = (sent: Paid) => json({ ...view(sent.id, { state, ...(state === "failed" ? { items: view(sent.id).items.map((item) => ({ ...item, state: "missed" })) } : {}) }), briefs });
    const paid = fakeDesk((sent, earlier) => {
      if (sent.header !== paid.seen[0]!.header) return opened(sent);
      if (state === "drawing" || state === "unpaid") return json({ message: "The sitting is paid for and its items are being drawn.", sitting: sent.id, state: "paid" }, 202);
      return earlier === 0 ? opened(sent) : ended(sent);
    });
    const read = (url: string) => {
      const id = paid.seen[0]!.id;
      if (state === "unpaid") return json({ sitting: id, state: "unpaid", payment: "failed", message: "The payment for this sitting did not settle. Nothing was charged." });
      if (state === "drawing") return json({ sitting: id, state: "opening", payment: "paid", message: "The sitting is paid for and its items are being drawn." });
      return json(url.includes("/briefs?") ? { ...view(id, { state }), briefs } : view(id, { state }));
    };
    const d = createDesk({
      config,
      signer,
      approveCommand: "approve",
      postTimeoutMs: 40,
      askAgainMs: 20,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => (String(input).startsWith(`${config.desk}/exams/`) ? read(String(input)) : paid.fetchImpl(input, init))) as typeof fetch,
    });
    return { d, ...paid, set: (next: typeof state) => (state = next) };
  }

  it("gives the amount back once the desk reads a kept sitting as unpaid, and signs anew on the next call", async () => {
    const { d, seen, set } = holding();
    const first = (await d.sit(request)) as { sitting: string };
    expect(first).toMatchObject({ done: false, retryAfterSeconds: 30 });
    expect(d.spent()).toBe(5_000_000n);
    set("unpaid");
    expect(await d.examStatus(first.sitting, false)).toMatchObject({ state: "unpaid", done: true });
    expect(d.spent()).toBe(0n);
    // The payment that did not settle is not sent again: the next call pays anew.
    const asked = seen.length;
    const second = (await d.sit(request)) as Record<string, unknown>;
    expect(seen).toHaveLength(asked + 1);
    expect(seen.at(-1)!.header).not.toBe(seen[0]!.header);
    expect(second.briefs).toEqual(briefs);
    expect(d.spent()).toBe(5_000_000n);
  });

  it("stops sending a kept payment once the sitting reads open, and reads it by its id from then on", async () => {
    const { d, seen, unpaid, set } = holding();
    const first = (await d.sit(request)) as { sitting: string };
    set("open");
    const read = (await d.examStatus(first.sitting, true)) as Record<string, unknown>;
    expect(read.briefs).toEqual(briefs);
    // Read by its id, the sitting is no longer asked for with its payment, so the same payment is never sent again.
    expect(await d.examStatus(first.sitting, false)).toMatchObject({ state: "open", done: false });
    const asked = seen.length;
    const probes = unpaid.length;
    await d.sit(request).catch(() => undefined);
    expect(seen.slice(asked).every((sent) => sent.header !== seen[0]!.header)).toBe(true);
    expect(unpaid.length).toBeGreaterThan(probes);
    expect(d.spent()).toBe(10_000_000n);
  });

  it("sits again when a kept sitting has failed since, and answers a void one as it is", async () => {
    const failed = holding();
    await failed.d.sit(request);
    failed.set("failed");
    const again = (await failed.d.sit(request)) as Record<string, unknown>;
    // The kept payment was sent once more and answered with the sitting as it ended, so a new one was paid for.
    expect(failed.seen.filter((sent) => sent.header === failed.seen[0]!.header).length).toBeGreaterThan(1);
    expect(failed.seen.at(-1)!.header).not.toBe(failed.seen[0]!.header);
    expect(again).toMatchObject({ state: "open", sitting: failed.seen.at(-1)!.id });
    expect(failed.d.spent()).toBe(10_000_000n);

    const voided = holding();
    await voided.d.sit(request);
    voided.set("void");
    const told = (await voided.d.sit(request)) as Record<string, unknown>;
    expect(told).toMatchObject({ state: "void", done: true, sitting: voided.seen[0]!.id });
    expect(new Set(voided.seen.map((sent) => sent.header)).size).toBe(1);
  });
});

describe("delivering an item", () => {
  const work = "```python\ndef f0(x):\n    return x\n```";

  it("signs the result with the paying key and posts it to the item, once", async () => {
    const requests: Request[] = [];
    const d = desk((async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return json({ sitting: SITTING, item: 2, state: "submitted", hash: keccak256(toBytes(work)), status: `${config.desk}/exams/${SITTING}` }, 202);
    }) as typeof fetch);
    const reply = await d.submitExam(SITTING, 2, work);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(`${config.desk}/exams/${SITTING}/items/2`);
    const sent = (await requests[0]!.json()) as { text: string; signature: `0x${string}` };
    expect(sent.text).toBe(work);
    expect(await recoverMessageAddress({ message: resultMessage(274630, SITTING, 2, work), signature: sent.signature })).toBe(signer.address);
    expect(reply).toMatchObject({ state: "submitted", next: "Delivered, and BrainChain judges it next. Read the outcome with brainchain_exam_status." });
  });

  it("passes on why the desk did not take it, and says a delivery it could not confirm may have arrived", async () => {
    for (const error of ["This item was already delivered. An item takes one delivery.", "The sitting's time ran out at 2027-01-15 10:00 UTC.", "The signature is not the sitting wallet's signature of this item's result message."]) {
      await expect(desk((async () => json({ error }, 409)) as typeof fetch).submitExam(SITTING, 0, work)).rejects.toThrow(new RegExp(`^${error.replace(/[.']/g, "\\$&")}$`));
    }
    const dropped = desk((async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch);
    expect(await dropped.submitExam(SITTING, 0, work)).toEqual({
      sitting: SITTING,
      item: 0,
      possiblyDelivered: true,
      error: "BrainChain did not confirm the delivery (fetch failed). The work may have arrived. Read the sitting with brainchain_exam_status, and send the item again only if it still reads open.",
    });
    expect(await desk((async () => new Response("bad gateway", { status: 502 })) as typeof fetch).submitExam(SITTING, 0, work)).toMatchObject({ possiblyDelivered: true, error: expect.stringMatching(/^BrainChain answered 502\./) });
    // A 5xx may come after the work was stored, so one that says why is still a delivery that may have arrived.
    expect(await desk((async () => json({ error: "Internal error." }, 500)) as typeof fetch).submitExam(SITTING, 0, work)).toMatchObject({
      possiblyDelivered: true,
      error: expect.stringMatching(/^BrainChain answered 500 \(Internal error\)\. The work may have arrived\./),
    });
  });
});

describe("reading a sitting", () => {
  const reader = (respond: (url: string) => Response) => {
    const urls: string[] = [];
    const d = desk((async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return respond(String(input));
    }) as typeof fetch);
    return { d, urls };
  };

  it("reads it without a key, and says what is left to deliver", async () => {
    const items = view(SITTING).items.map((item, i) => (i < 2 ? { ...item, state: "judged", accepted: true, right: 12, of: 12, decision: "4801" } : i === 2 ? { ...item, state: "submitted" } : item));
    const urls: string[] = [];
    const unkeyed = createDesk({
      config,
      signer: () => {
        throw new Error("no key");
      },
      approveCommand: "approve",
      fetch: (async (input: RequestInfo | URL) => {
        urls.push(String(input));
        return json(view(SITTING, { items }));
      }) as typeof fetch,
    });
    const read = (await unkeyed.examStatus(SITTING, false)) as Record<string, unknown>;
    expect(urls).toEqual([`${config.desk}/exams/${SITTING}`]);
    expect(read).toMatchObject({ sitting: SITTING, state: "open", done: false });
    expect(read.next).toMatch(/^Deliver items 3 and 4 with brainchain_exam_submit before 2100-01-01T02:00:00Z\./);
    // Read without its briefs, the sitting says where they are; read with them, it does not.
    expect(read.next).toMatch(/ brainchain_exam_status with briefs: true reads the briefs\.$/);
    expect(sittingGuidance({ ...view(SITTING), briefs }).next).not.toContain("briefs: true");
    await expect(unkeyed.examStatus(SITTING, true)).rejects.toThrow("no key");
  });

  it("signs for the briefs with the paying key when asked for them", async () => {
    const { d, urls } = reader(() => json({ ...view(SITTING), briefs }));
    const read = (await d.examStatus(SITTING, true)) as Record<string, unknown>;
    const url = new URL(urls[0]!);
    expect(url.origin + url.pathname).toBe(`${config.desk}/exams/${SITTING}/briefs`);
    const at = Number(url.searchParams.get("at"));
    expect(Math.abs(at - Date.now() / 1000)).toBeLessThan(60);
    expect(await recoverMessageAddress({ message: briefsMessage(274630, SITTING, at), signature: url.searchParams.get("signature") as `0x${string}` })).toBe(signer.address);
    expect(read.briefs).toEqual(briefs);
  });

  it("says how a sitting ended, with the licence's expiry on a pass", async () => {
    const judged = (accepted: number) => view(SITTING).items.map((item, i) => ({ ...item, state: "judged", accepted: i < accepted }));
    const licence = { licence: { class: "code", expiresAt: EXPIRES }, signature: "0x01" };
    const passed = (await reader(() => json(view(SITTING, { state: "passed", items: judged(4), licence }))).d.examStatus(SITTING, false)) as Record<string, unknown>;
    expect(passed).toMatchObject({ done: true, licence });
    expect(passed.next).toBe("Passed: 4 of 5 items accepted. The signed licence is in `licence`. It is valid until 2100-03-02T00:00:00Z, as long as the agent's id keeps the same controller and build.");
    const failed = (await reader(() => json(view(SITTING, { state: "failed", items: judged(3) }))).d.examStatus(SITTING, false)) as Record<string, unknown>;
    expect(failed).toMatchObject({ done: true, next: "Failed: 3 of 5 items accepted, and a pass takes 4. brainchain_exam_info says how long the agent waits before it may sit again." });
    // An item refused with every hidden case right comes with the judges' answer and how sure they were, and the reply says so in words.
    const lead = "Failed: 3 of 5 items accepted, and a pass takes 4. brainchain_exam_info says how long the agent waits before it may sit again.";
    const refusedAs = async (said: Record<string, unknown>, sitting: Record<string, unknown> = {}) => {
      const items = judged(3).map((item, i) => (i === 3 ? { ...item, right: 18, of: 18, decision: "886", ...said } : i === 4 ? { ...item, right: 17, of: 18, judges: "accept", confidenceBps: 9900 } : item));
      return (await reader(() => json(view(SITTING, { state: "failed", items, ...sitting }))).d.examStatus(SITTING, false)) as { items: Record<string, unknown>[]; next: string };
    };
    const under = await refusedAs({ judges: "accept", confidenceBps: 4900 });
    expect(under.items[3]).toMatchObject({ accepted: false, right: 18, of: 18, judges: "accept", confidenceBps: 4900, decision: "886" });
    expect(under.next).toBe(`${lead} Item 3 answered every hidden case right and was not accepted: the judges accepted it at 49%.`);
    expect((await refusedAs({ judges: "refuse", confidenceBps: 9000 })).next).toBe(`${lead} Item 3 answered every hidden case right and was not accepted: the judges refused it, 90% sure.`);
    // The bar is named when the sitting carries it, and only for an answer to accept that fell under it.
    expect((await refusedAs({ judges: "accept", confidenceBps: 4900 }, { barBps: 5000 })).next).toBe(`${lead} Item 3 answered every hidden case right and was not accepted: the judges accepted it at 49%, under the 50% bar.`);
    expect((await refusedAs({ judges: "refuse", confidenceBps: 9000 }, { barBps: 5000 })).next).toBe(`${lead} Item 3 answered every hidden case right and was not accepted: the judges refused it, 90% sure.`);
    // A host that kept how sure the judges were before it kept their answer reads as it did.
    expect((await refusedAs({ confidenceBps: 4900 })).next).toBe(`${lead} Item 3 answered every hidden case right and was not accepted: the judges were 49% sure of their answer.`);
    expect((await refusedAs({})).next).toBe(lead);
    expect(EXAM_STATUS_TOOL.description).toContain("the judges' answer (`judges`: accept or refuse), how sure they were of it in basis points (`confidenceBps`, 5000 is 50%)");
    expect(EXAM_STATUS_TOOL.description).toContain("read by the judges, Jev and the other models on BrainChain's grading panel");
  });

  it("says a void sitting is done, does not count, and is refunded", async () => {
    const reason = "BrainChain could not judge enough of the delivered work to decide this sitting, so it is void. It does not count against the agent, which may sit again, and the payment goes back to the paying wallet.";
    const items = view(SITTING).items.map((item, i) => ({ ...item, state: i < 3 ? "void" : "judged", ...(i < 3 ? {} : { accepted: true }) }));
    const read = (await reader(() => json(view(SITTING, { state: "void", items, reason }))).d.examStatus(SITTING, false)) as Record<string, unknown>;
    expect(read).toMatchObject({ state: "void", reason, done: true });
    expect(read).not.toHaveProperty("retryAfterSeconds");
    expect(read.next).toBe(`The fee pays for the sitting, pass or fail. If BrainChain cannot open a paid sitting, or cannot judge enough of it to decide, the sitting is void: it does not count against the agent, and the payment goes back to the paying wallet. The agent may sit again now with brainchain_sit_exam. If the payment has not arrived, write to hello@usebrainchain.com with the sitting id ${SITTING}.`);
  });

  const drawing = "The sitting is paid for and its items are being drawn. Send the request that paid for it again to read it; it is not charged twice.";
  const waiting = (extra: Record<string, unknown> = {}) => json({ sitting: SITTING, state: "opening", payment: "paid", message: drawing, ...extra });
  const unheld =
    "This server no longer holds the payment that bought the sitting, so it cannot fetch the briefs with it. " +
    "Once the sitting is open, brainchain_exam_status with briefs: true reads them, signed by the wallet that sits it.";

  it("reads a sitting before it opens by the state the desk gives it alone: paying, opening or unpaid", async () => {
    const named = { sitting: SITTING, statusUrl: `${config.desk}/exams/${SITTING}` };
    expect(await reader(() => waiting({ reason: "the pool has no item left to draw" })).d.examStatus(SITTING, false)).toEqual({
      ...named,
      state: "opening",
      payment: "paid",
      reason: "the pool has no item left to draw",
      done: false,
      next: `The sitting is paid for, and BrainChain is opening it. It is not open yet for this reason: the pool has no item left to draw. ${unheld}`,
      retryAfterSeconds: 30,
    });
    for (const payment of ["paying", "unconfirmed"]) {
      expect(await reader(() => waiting({ state: "paying", payment, message: "The payment for this sitting is being settled." })).d.examStatus(SITTING, false)).toEqual({
        ...named,
        state: "paying",
        payment,
        done: false,
        next: `The desk is settling this sitting's payment, and BrainChain opens the sitting once it has. ${unheld}`,
        retryAfterSeconds: 30,
      });
    }
    expect(await reader(() => waiting({ state: "unpaid", payment: "failed", message: "The payment for this sitting did not settle. Nothing was charged." })).d.examStatus(SITTING, false)).toEqual({
      ...named,
      state: "unpaid",
      payment: "failed",
      done: true,
      next: "The payment for this sitting did not settle, so nothing was charged and no sitting opens from it. brainchain_sit_exam opens a new one.",
    });
    // The state alone says it: a reply that leaves the payment's own state out reads the same.
    expect(await reader(() => json({ sitting: SITTING, state: "unpaid" })).d.examStatus(SITTING, false)).toMatchObject({ state: "unpaid", done: true });
    expect(await reader(() => json({ sitting: SITTING, state: "paying" })).d.examStatus(SITTING, false)).toMatchObject({ state: "paying", done: false });
    // Failed is only ever a sitting that closed without a pass, whatever else the reply carries.
    const closed = (await reader(() => json(view(SITTING, { state: "failed", payment: "paid" }))).d.examStatus(SITTING, false)) as Record<string, unknown>;
    expect(closed.next).toMatch(/^Failed: 0 of 5 items accepted/);
  });

  it("reads the same of a sitting not open yet when its briefs are asked for, which the desk answers with a 409", async () => {
    const { d, urls } = reader(() => json({ error: drawing, sitting: SITTING, state: "opening", payment: "paid", message: drawing }, 409));
    expect(await d.examStatus(SITTING, true)).toMatchObject({ sitting: SITTING, state: "opening", payment: "paid", done: false, retryAfterSeconds: 30 });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain(`/exams/${SITTING}/briefs?at=`);
    // An id the desk knows nowhere is refused, with no second read.
    const unknown = reader(() => json({ error: "No sitting with that id." }, 404));
    await expect(unknown.d.examStatus(SITTING, true)).rejects.toThrow("BrainChain has no sitting with this id.");
    expect(unknown.urls).toHaveLength(1);
    // Any other 409 is the desk's own refusal.
    await expect(reader(() => json({ error: "Not this wallet's." }, 409)).d.examStatus(SITTING, true)).rejects.toThrow("Not this wallet's.");
  });

  it("tells the server that paid for an opening sitting to send its request again", async () => {
    const { fetchImpl, seen } = fakeDesk((sent) => json({ message: "The sitting is paid for and its items are being drawn.", sitting: sent.id, state: "paid" }, 202));
    const d = createDesk({
      config,
      signer,
      approveCommand: "approve",
      postTimeoutMs: 40,
      askAgainMs: 20,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => (String(input).startsWith(`${config.desk}/exams/`) ? waiting({ sitting: seen[0]!.id }) : fetchImpl(input, init))) as typeof fetch,
    });
    await d.sit(request);
    expect(await d.examStatus(seen[0]!.id, false)).toMatchObject({
      sitting: seen[0]!.id,
      state: "opening",
      next: "The sitting is paid for, and BrainChain is opening it. Call brainchain_sit_exam again with the same agentId and class: it sends the same request with the same payment, which the desk does not charge twice.",
    });
  });

  it("refuses an id BrainChain does not know, passes on its refusal of a signature, and asks again later when it is busy", async () => {
    await expect(reader(() => json({ error: "Not found." }, 404)).d.examStatus(SITTING, false)).rejects.toThrow(/^BrainChain has no sitting with this id\. Check the id: it must be one that brainchain_sit_exam returned\.$/);
    const stranger = reader(() => json({ error: "The signature is not the sitting wallet's signature of the briefs message." }, 403)).d.examStatus(SITTING, true);
    await expect(stranger).rejects.toThrow("The signature is not the sitting wallet's signature of the briefs message.");
    expect(await reader(() => new Response("{}", { status: 503, headers: { "retry-after": "7" } })).d.examStatus(SITTING, false)).toMatchObject({ done: false, retryAfterSeconds: 7 });
  });
});

describe("sittingGuidance", () => {
  const at = (items: Record<string, unknown>[], extra: Record<string, unknown> = {}) => sittingGuidance({ state: "open", deadline: 1_800_007_200, passMark: 4, items, ...extra }, 1_800_000_000_000);

  it("names one open item, waits while BrainChain judges, and says when the time ran out", () => {
    expect(at([{ index: 0, state: "submitted" }, { index: 1, state: "open" }]).next).toMatch(/^Deliver item 1 with brainchain_exam_submit before /);
    expect(at([{ index: 0, state: "submitted" }, { index: 1, state: "judged", accepted: true }])).toEqual({
      done: false,
      next: "Every item is delivered or missed, and BrainChain is judging what was delivered. Read the sitting again after retryAfterSeconds.",
      retryAfterSeconds: 30,
    });
    expect(sittingGuidance({ state: "open", deadline: 1_800_007_200, items: [{ index: 3, state: "open" }, { index: 4, state: "open" }] }, 1_800_007_201_000)).toEqual({
      done: false,
      next: "The sitting's time ran out at 2027-01-15T10:00:00Z, so items 3 and 4 were missed. Read the sitting again after retryAfterSeconds for the outcome.",
      retryAfterSeconds: 60,
    });
  });
});

describe("the exam and the licences as the desk states them", () => {
  const info = {
    pay: exams,
    price: "5.00 USD a sitting, paid over x402 in test USDG on Robinhood Chain testnet",
    classes: [{ class: "code", about: "Small Python functions, each judged on hidden cases it is run on." }],
    sitting: {
      items: 5,
      hardItems: 3,
      passMark: 4,
      levels: ["Returns the right answer on every hidden case, with clear code", "Returns the right answer on every hidden case", "Returns a wrong answer on a hidden case"],
      passes: "Returns the right answer on every hidden case",
      barBps: 5000,
      minutes: 120,
      licenceDays: 60,
      waitAfterFailingDays: 7,
      renewFromDaysBefore: 14,
    },
    pool: { usesPerItem: 3, inUse: [`0x${"01".repeat(32)}`, `0x${"02".repeat(32)}`], retired: 4 },
  };
  const at = (routes: Record<string, Response>) => {
    const urls: string[] = [];
    const d = desk((async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return routes[String(input).replace(config.desk, "")]?.clone() ?? json({ error: "Not found." }, 404);
    }) as typeof fetch);
    return { d, urls };
  };

  it("returns the exam as the desk describes it, with the items in use counted", async () => {
    // The hard items, the levels and the level an item must reach come through as the desk states them.
    expect(await at({ "/exams": json(info) }).d.examInfo()).toEqual({ ...info, pool: { usesPerItem: 3, inUse: 2, retired: 4 } });
    for (const field of ["`sitting.levels`", "`sitting.passes`", "`sitting.barBps`", "how many of them are hard ones", "`sitting.waitAfterFailingDays`", "`sitting.renewFromDaysBefore`"]) {
      expect(EXAM_INFO_TOOL.description).toContain(field);
    }
    // The items in use are counted, and the description says what the desk lists in their place.
    expect(EXAM_INFO_TOOL.description).toContain("`pool.inUse` is how many items are in use now,");
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toContain("An agent may sit again seven days after a failed sitting, and a licensed agent from fourteen days before its licence expires.");
    expect(EXAM_INFO_TOOL.description).toContain("an item with a hidden case wrong is never accepted, and one with every case right is accepted when the judges accept it with at least that confidence");
    await expect(at({}).d.examInfo()).rejects.toThrow(`The licence exam is not open at ${config.desk}.`);
  });

  it("adds the price in units from the desk's own offer on the chain this server pays on, for brainchain_sit_exam to be given", async () => {
    const offer = new Response("{}", { status: 402, headers: { "payment-required": challenge("5000000") } });
    expect(await at({ "/exams": json(info), "/x402/exams": offer }).d.examInfo()).toMatchObject({ price: info.price, priceUnits: "5000000" });
  });

  it("lists an agent's licences on the chain its id is on, and says when it has none", async () => {
    const held = { agent: { chainId: 46630, id: "20424" }, registry: "read", epoch: { id: `0x${"cd".repeat(32)}`, controller: signer.address, build: "atlas 2.1" }, licences: [{ class: "code", state: "valid", licence: { licence: { expiresAt: 1_805_184_000 }, signature: "0x01" }, audits: { passed: 1, failed: 0 } }] };
    const { d, urls } = at({ "/licences/46630/20424": json(held), "/licences/46630/7": json({ agent: { chainId: 46630, id: "7" }, registry: "unreadable", epoch: null, licences: [] }) });
    // Whether the registry was read, and the epoch the states are held to, come with them as the desk says them.
    expect(await d.licences("20424")).toEqual(held);
    expect(urls).toEqual([`${config.desk}/licences/46630/20424`]);
    expect(await d.licences("7")).toMatchObject({ registry: "unreadable", epoch: null, licences: [], next: "Agent 7 holds no licence. brainchain_exam_info says what a sitting takes, and brainchain_sit_exam opens one." });
    await expect(at({}).d.licences("20424")).rejects.toThrow(`BrainChain at ${config.desk} serves no licences.`);
    // An id no single account controls, with nothing on file, is answered with the desk's own reason.
    const uncontrolled = "Agent 99 is not registered on chain 46630, or no single account controls it.";
    await expect(at({ "/licences/46630/99": json({ error: uncontrolled }, 404) }).d.licences("99")).rejects.toThrow(new RegExp(`^${uncontrolled.replace(/[.,]/g, "\\$&")}$`));
  });

  it("returns the head and first entries of an agent's record, what its Papers say, and the command that checks it", async () => {
    const head = { head: { seq: 31, hash: `0x${"ab".repeat(32)}`, at: 1_800_000_000 }, signature: "0x02" };
    const entries = [{ entry: { seq: 1, kind: "task", outcome: "accepted", ref: "task:0x44b8:12" }, signature: "0x03" }];
    const papers = {
      version: 1,
      at: 1_800_000_060,
      epoch: { id: `0x${"cd".repeat(32)}`, controller: signer.address, build: "atlas 2.1", number: 2, since: 1_799_000_000 },
      licences: [{ class: "code", state: "valid", issuedAt: 1_800_000_000, expiresAt: 1_805_184_000, accepted: 5, of: 5, audits: { passed: 0, failed: 0 } }],
      ceiling: { units: "2500000", floor: "1000000", counted: "12500000", payers: [] },
      verify: "npx brainchain-verify testnet --record 20424",
    };
    const routes = {
      [`/agents/46630/20424/record?from=1&limit=${RECORD_PAGE}`]: json({ agent: { chainId: 46630, id: "20424" }, head, entries, next: `/agents/46630/20424/record?from=21&limit=${RECORD_PAGE}` }),
      "/papers/46630/20424": json({ type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1", name: "Atlas", brainchain: { papers, signed: "BrainChain papers\n{}", signature: "0x04" } }),
    };
    const { d, urls } = at(routes);
    expect(await d.agentRecord("20424")).toEqual({
      agent: { chainId: 46630, id: "20424" },
      record: { url: `${config.desk}/agents/46630/20424/record`, head, entries, more: `${config.desk}/agents/46630/20424/record?from=21&limit=${RECORD_PAGE}` },
      papers: { url: `${config.desk}/papers/46630/20424`, signedAt: 1_800_000_060, epoch: papers.epoch, licences: papers.licences, ceiling: papers.ceiling },
      verify: "npx brainchain-verify testnet --record 20424",
    });
    expect(urls.sort()).toEqual(Object.keys(routes).map((path) => `${config.desk}${path}`).sort());

    // An agent whose id exists and has not worked yet has Papers and no record.
    const fresh = (await at({ "/papers/46630/20424": routes["/papers/46630/20424"]! }).d.agentRecord("20424")) as { record: unknown };
    expect(fresh.record).toEqual({ url: `${config.desk}/agents/46630/20424/record`, entries: [], note: "BrainChain has no entry on record for this agent." });
    await expect(at({}).d.agentRecord("9")).rejects.toThrow("BrainChain has no record and no Papers for agent 9 on chain 46630. Check the id.");
  });

  it("keeps the record when the Papers cannot be read just now, and says why in their place", async () => {
    const record = json({ agent: { chainId: 46630, id: "20424" }, head: { head: { seq: 1 }, signature: "0x02" }, entries: [] });
    const limited = new Response(JSON.stringify({ error: "Too many requests from this address. Try again in a minute." }), { status: 429, headers: { "retry-after": "60" } });
    const read = (papers: Response) => at({ [`/agents/46630/20424/record?from=1&limit=${RECORD_PAGE}`]: record, "/papers/46630/20424": papers }).d.agentRecord("20424") as Promise<Record<string, unknown>>;
    for (const [papers, error] of [
      [limited, "BrainChain answered 429: it is busy or briefly unavailable. Try again in a minute."],
      [json({ error: "The agent's identity could not be read just now. Try again shortly." }, 503), "BrainChain answered 503: it is busy or briefly unavailable. Try again in a minute."],
      // An id no single account controls has no Papers, and the desk says so.
      [json({ error: "Agent 20424 is not registered on chain 46630, or no single account controls it." }, 404), "Agent 20424 is not registered on chain 46630, or no single account controls it."],
    ] as const) {
      const reply = await read(papers);
      expect(reply.record).toMatchObject({ head: { head: { seq: 1 } }, entries: [] });
      expect(reply.papers).toEqual({ url: `${config.desk}/papers/46630/20424`, error });
      expect(reply.verify).toBe("npx brainchain-verify testnet --record 20424");
    }
    // With neither to show, the first reason is the answer.
    await expect(at({ [`/agents/46630/9/record?from=1&limit=${RECORD_PAGE}`]: json({}, 503), "/papers/46630/9": json({}, 503) }).d.agentRecord("9")).rejects.toThrow("BrainChain answered 503");
  });
});

describe("the exam tools", () => {
  const calls: unknown[][] = [];
  const noted =
    (name: string, reply: unknown = { ok: name }) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
      return reply;
    };
  const fake = {
    examInfo: noted("info"),
    sit: noted("sit", { sitting: SITTING, deadline: DEADLINE, briefs }),
    submitExam: noted("submit"),
    examStatus: noted("status", { sitting: SITTING, state: "open" }),
    licences: noted("licences"),
    agentRecord: noted("record"),
  } as unknown as Desk;
  const body = (result: Awaited<ReturnType<typeof callTool>>) => JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>;

  it("route to the desk, with the class left out read as code", async () => {
    calls.length = 0;
    const sat = await callTool(fake, SIT_EXAM_NAME, { agentId: "20424", price: "5000000" });
    expect(sat.isError).toBe(false);
    // The briefs come whole in the reply, with every field the desk gives, and again as text blocks of their own, as written.
    expect(body(sat)).toEqual({ sitting: SITTING, deadline: DEADLINE, briefs });
    expect(sat.content.slice(1)).toEqual(briefs.map(({ index, title, brief }) => ({ type: "text", text: `Item ${index}: ${title}\n\n${brief}` })));
    await callTool(fake, SIT_EXAM_NAME, { agentId: "0", class: "code", price: "5000000" });
    // An id is any uint256, so the largest has 78 digits.
    await callTool(fake, LICENCES_NAME, { agentId: (2n ** 256n - 1n).toString() });
    await callTool(fake, EXAM_SUBMIT_NAME, { sitting: SITTING.toUpperCase().replace("0X", "0x"), item: 4, text: "  def f(): pass\n" });
    await callTool(fake, EXAM_STATUS_NAME, { sitting: SITTING });
    await callTool(fake, EXAM_STATUS_NAME, { sitting: SITTING, briefs: true });
    await callTool(fake, EXAM_INFO_NAME, {});
    await callTool(fake, LICENCES_NAME, { agentId: "20424" });
    await callTool(fake, AGENT_RECORD_NAME, { agentId: "20424" });
    expect(calls).toEqual([
      ["sit", { agentId: "20424", class: "code", price: 5_000_000n }],
      ["sit", { agentId: "0", class: "code", price: 5_000_000n }],
      ["licences", (2n ** 256n - 1n).toString()],
      ["submit", SITTING, 4, "  def f(): pass\n"],
      ["status", SITTING, false],
      ["status", SITTING, true],
      ["info"],
      ["licences", "20424"],
      ["record", "20424"],
    ]);
  });

  it("refuse what the desk would refuse, before anything is signed or sent", async () => {
    calls.length = 0;
    for (const [name, input, error] of [
      [SIT_EXAM_NAME, {}, "agentId is required."],
      [SIT_EXAM_NAME, { agentId: 20424 }, "agentId must be a string, not a number."],
      [SIT_EXAM_NAME, { agentId: "0x1f" }, 'agentId must be the agent\'s ERC-8004 id, a whole number from 0 to 2^256 - 1 written as a string with no leading zeros, such as "20424".'],
      [SIT_EXAM_NAME, { agentId: "007" }, 'agentId must be the agent\'s ERC-8004 id, a whole number from 0 to 2^256 - 1 written as a string with no leading zeros, such as "20424".'],
      [SIT_EXAM_NAME, { agentId: "7" }, "price is required."],
      [SIT_EXAM_NAME, { agentId: "7", price: 5000000 }, "price must be a string, not a number."],
      [SIT_EXAM_NAME, { agentId: "7", price: "5.00" }, 'price must be the price of a sitting in the token\'s base units, written as a string such as "5000000": the priceUnits brainchain_exam_info gives.'],
      [SIT_EXAM_NAME, { agentId: "7", price: "0" }, 'price must be the price of a sitting in the token\'s base units, written as a string such as "5000000": the priceUnits brainchain_exam_info gives.'],
      [SIT_EXAM_NAME, { agentId: "7", price: "5000000", class: "Code!" }, 'class must be one of the classes brainchain_exam_info lists, such as "code".'],
      [SIT_EXAM_NAME, { agentId: "7", maxPrice: "9" }, "Unknown field: maxPrice. This tool takes only agentId, price, class."],
      [EXAM_SUBMIT_NAME, { sitting: "0x12", item: 0, text: "x" }, "sitting must be the 0x-prefixed, 64-character hex id that brainchain_sit_exam returned."],
      [EXAM_SUBMIT_NAME, { sitting: SITTING, text: "x" }, "item is required."],
      [EXAM_SUBMIT_NAME, { sitting: SITTING, item: "1", text: "x" }, "item must be the item's index as the sitting lists it, a whole number from 0."],
      [EXAM_SUBMIT_NAME, { sitting: SITTING, item: 10, text: "x" }, "item must be the item's index as the sitting lists it, a whole number from 0."],
      [EXAM_SUBMIT_NAME, { sitting: SITTING, item: 0 }, "text is required."],
      [EXAM_SUBMIT_NAME, { sitting: SITTING, item: 0, text: " \n" }, "text is empty."],
      [EXAM_SUBMIT_NAME, { sitting: SITTING, item: 0, text: "é".repeat(MAX_WORK_BYTES / 2 + 1) }, "text is 48,002 bytes; the limit is 48,000."],
      [EXAM_STATUS_NAME, { sitting: SITTING, briefs: "yes" }, "briefs must be true or false, not a string."],
      [EXAM_STATUS_NAME, {}, "sitting is required."],
      [EXAM_INFO_NAME, { class: "code" }, "Unknown field: class. This tool takes nothing."],
      [LICENCES_NAME, { agentId: "-1" }, 'agentId must be the agent\'s ERC-8004 id, a whole number from 0 to 2^256 - 1 written as a string with no leading zeros, such as "20424".'],
      [LICENCES_NAME, { agentId: (2n ** 256n).toString() }, 'agentId must be the agent\'s ERC-8004 id, a whole number from 0 to 2^256 - 1 written as a string with no leading zeros, such as "20424".'],
      [AGENT_RECORD_NAME, { agentId: "1".repeat(79) }, 'agentId must be the agent\'s ERC-8004 id, a whole number from 0 to 2^256 - 1 written as a string with no leading zeros, such as "20424".'],
      [AGENT_RECORD_NAME, { agentId: "7", from: 21 }, "Unknown field: from. This tool takes only agentId."],
    ] as const) {
      const result = await callTool(fake, name, input);
      expect(result.isError, `${name} ${JSON.stringify(input).slice(0, 60)}`).toBe(true);
      expect(body(result)).toEqual({ error });
    }
    expect(calls).toEqual([]);
    expect(checkWork({ sitting: SITTING, item: 0, text: "x" })).toEqual({ sitting: SITTING, item: 0, text: "x" });
  });

  it("say that the key must hold the agent's id, how far the limit per payment moves, and that an item takes one delivery", () => {
    const { terms } = resolveConfig({});
    const sit = sitExamTool({ ...terms, wallet: signer.address }).description!;
    expect(sit).toContain("This server's wallet signs the request, so it must hold the agent's id on Robinhood Chain (Robinhood Chain testnet on testnet), as the id's controller or as its registered wallet.");
    expect(sit).toContain(`pays exactly that from this server's wallet ${signer.address} on Robinhood Chain. If the desk asks more than \`price\`, nothing is signed.`);
    expect(sit).toContain("`price` is the most the agent agrees to pay, in base units: pass the `priceUnits` brainchain_exam_info gives.");
    expect(sit).toContain("A sitting can cost more than this server's default limit per payment, so for this one payment the limit is the desk's price.");
    expect(sit).toContain("A limit the operator set in BRAINCHAIN_MAX_PRICE_UNITS still holds.");
    expect(sit).toContain("a price above that limit, the daily limit or this server's budget of 10 USDG per run is refused with nothing charged.");
    // In the words of the exam's own refunds field: a pass or a fail is not refunded, a sitting BrainChain could not run is.
    const refunds =
      "The fee pays for the sitting, pass or fail. If BrainChain cannot open a paid sitting, or cannot judge enough of it to decide, the sitting is void: it does not count against the agent, and the payment goes back to the paying wallet.";
    expect(sit).toContain(refunds);
    expect(sit).not.toContain("Nothing is refunded");
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toContain(`${refunds} If the payment has not arrived, write to hello@usebrainchain.com with the sitting id.`);
    expect(readme).not.toMatch(/nothing is refunded|not refunded, whatever its outcome/);
    expect(EXAM_STATUS_TOOL.description).toContain("its state (open, passed, failed or void)");
    expect(EXAM_INFO_TOOL.description).toContain("and `sitting.refunds` what the fee buys");
    expect(EXAM_INFO_TOOL.description).toContain("pass it to brainchain_sit_exam as `price`");
    expect(sit).toContain("BrainChain refuses a sitting it cannot open before anything is signed");
    expect(sit).toContain("An agent that already has a sitting gets that one back instead of a second: with its briefs, marked duplicate, when it is open and this wallet sits it, or with where it stands when it is paid for and not open yet.");
    expect(sit).toContain("Past that, the reply says to call again after retryAfterSeconds, and nothing was signed.");
    expect(sit).toContain("After a restart this server no longer holds that request, so the reply names the sitting that is paid for, and brainchain_exam_status with briefs: true reads its briefs once it is open.");
    expect(EXAM_STATUS_TOOL.description).toContain("Before a sitting opens it reads `paying` while its payment settles, `opening` once it is paid for and its items are being drawn, with BrainChain's reason when a draw failed, or `unpaid` when the payment did not settle and nothing was charged.");
    expect(LICENCES_TOOL.description).toContain("`registry` says whether BrainChain could read the identity registry for this answer.");
    expect(LICENCES_TOOL.description).toContain("When it reads `unreadable`, `epoch` is null and the states are from BrainChain's last own reading, up to ten minutes old.");
    // A licence's states in the order BrainChain reads them: an expiry first, whatever else was true.
    expect(LICENCES_TOOL.description).toContain("A licence past its expiry reads expired, whatever else was true of it. Before that it reads suspended after two failed audits in the last three, lapsed while");
    expect(sitExamTool("BRAINCHAIN_NETWORK must be mainnet or testnet.").description).toMatch(/^Invalid setting: BRAINCHAIN_NETWORK must be mainnet or testnet\. Until the operator fixes it, this tool only returns that error\. Open a sitting/);
    const submit = examSubmitTool().description!;
    expect(submit).toContain("An item takes one delivery: once sent, the work cannot be replaced or sent again");
    // The limit on an item's work is the desk's, lower than the limit on a result sent for a grade.
    expect(JSON.stringify(examSubmitTool().inputSchema)).toContain("at most 48,000 bytes");
    expect(readFileSync(new URL("../README.md", import.meta.url), "utf8")).toContain("the `text` of the finished work, at most 48,000 bytes");
    expect(examSubmitTool("BRAINCHAIN_PAYER_KEY must be 64 hex characters, with or without 0x.").description).toMatch(/^Invalid setting: BRAINCHAIN_PAYER_KEY must be 64 hex characters/);
    expect(AGENT_RECORD_TOOL.description).toContain("`npx brainchain-verify <network> --record <agentId>`");
    expect(AGENT_RECORD_TOOL.description).toContain(`its first ${RECORD_PAGE} entries`);
  });

  it("mark the sitting and a delivery as not to be repeated, and every read as read-only", () => {
    for (const tool of [sitExamTool(resolveConfig({}).terms), examSubmitTool()]) expect(tool.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
    for (const tool of [EXAM_INFO_TOOL, EXAM_STATUS_TOOL, LICENCES_TOOL, AGENT_RECORD_TOOL]) expect(tool.annotations).toEqual({ readOnlyHint: true, openWorldHint: true });
  });

  it("pause with no dash", () => {
    const tools = [EXAM_INFO_TOOL, sitExamTool(resolveConfig({}).terms), examSubmitTool(), EXAM_STATUS_TOOL, LICENCES_TOOL, AGENT_RECORD_TOOL];
    for (const tool of tools) expect(JSON.stringify(tool)).not.toContain("—");
  });
});
