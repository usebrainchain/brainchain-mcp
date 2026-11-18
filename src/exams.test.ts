import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { keccak256, recoverMessageAddress, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { resolveConfig } from "./config.js";
import { briefsMessage, RECORD_PAGE, resultMessage, sittingGuidance, sittingMessage } from "./exams.js";
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
  MAX_RESULT_BYTES,
  SIT_EXAM_NAME,
  sitExamTool,
  type Desk,
} from "./tools.js";

// Anvil's second default account: a public test key that holds nothing anywhere.
const signer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const config = resolveConfig({ BRAINCHAIN_NETWORK: "testnet" });
const exams = `${config.desk}/x402/exams`;
const PRICE = "5000000";
const request = { agentId: "20424", class: "code" };
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
 */
function fakeDesk(paid: (sent: Paid, earlier: number) => Response | Promise<Response>, { price = PRICE, asked = price, payTo = config.payTo as string } = {}) {
  const seen: Paid[] = [];
  const unpaid: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    if (req.url !== exams) throw new Error(`unexpected request to ${req.url}`);
    const body = await req.text();
    const header = req.headers.get("payment-signature");
    if (!header) {
      unpaid.push(body);
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
    await expect(d.sit(request)).rejects.toThrow(/^The desk asked for another payment than the one it had just quoted for a sitting .* so nothing was signed\. Try again\. Nothing was charged\.$/);
    expect(raised.seen).toHaveLength(0);
    expect(d.spent()).toBe(0n);
    // The limit moved for the sitting and for nothing else: a task quoted above it is still refused.
    const tasks = desk((async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      return req.headers.get("payment-signature") ? json({}) : new Response("{}", { status: 402, headers: { "payment-required": challenge(PRICE) } });
    }) as typeof fetch);
    await expect(tasks.post({ title: "T", brief: "B", levels: ["Good", "Bad"] })).rejects.toThrow(/above this server's limit of 1 test USDG/);
  });

  it("refuses a price the budget or the daily limit cannot hold, before anything is signed", async () => {
    const { fetchImpl, seen } = fakeDesk(opened);
    const small = desk(fetchImpl, { budget: 4_000_000n });
    await expect(small.sit(request)).rejects.toThrow(
      "A sitting costs 5 test USDG, above this server's budget per run of 4 (BRAINCHAIN_BUDGET_UNITS). Raise it and restart the server to allow the sitting. Nothing was charged.",
    );
    const capped = desk(fetchImpl, { daily: 2_000_000n, stateDir: await mkdtemp(join(tmpdir(), "brainchain-mcp-")) });
    await expect(capped.sit(request)).rejects.toThrow("A sitting costs 5 test USDG, above this wallet's daily limit of 2 (BRAINCHAIN_DAILY_UNITS).");
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
    await expect(d.sit({ agentId: "20425", class: "code" })).rejects.toThrow(/already signed payments for 5 of its 9 test USDG budget.*Nothing was charged\.$/);
    expect(seen).toHaveLength(1);
    expect(d.spent()).toBe(5_000_000n);
  });

  it("pays the desk alone", async () => {
    const { fetchImpl, seen } = fakeDesk(opened, { payTo: "0x000000000000000000000000000000000000dEaD" });
    await expect(desk(fetchImpl).sit(request)).rejects.toThrow(/it named 0x000000000000000000000000000000000000dEaD as the payee, and this server pays only/);
    expect(seen).toHaveLength(0);
  });

  it("says when the desk names no price for a sitting", async () => {
    const d = desk((async () => json({ error: "No such route." }, 404)) as typeof fetch);
    await expect(d.sit(request)).rejects.toThrow(/named no price for a sitting on Robinhood Chain testnet, so nothing was signed\..*brainchain_exam_info says\. Nothing was charged\.$/);
  });

  it("passes on the desk's refusal in its own words, with nothing counted", async () => {
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

  it("says a sitting paid for here is not open yet when its status is read before the desk shows it", async () => {
    const { fetchImpl, seen } = fakeDesk((sent) => json({ message: "The sitting is paid for and its items are being drawn.", sitting: sent.id, state: "paid" }, 202));
    const d = createDesk({
      config,
      signer,
      approveCommand: "approve",
      postTimeoutMs: 40,
      askAgainMs: 20,
      // The sitting's own address answers 404 until the desk has opened it.
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => (String(input).startsWith(`${config.desk}/exams/`) ? json({ error: "Not found." }, 404) : fetchImpl(input, init))) as typeof fetch,
    });
    await d.sit(request);
    expect(await d.examStatus(seen[0]!.id, false)).toEqual({
      sitting: seen[0]!.id,
      done: false,
      next: "The sitting is paid for, and the desk has not opened it yet. Call brainchain_sit_exam again with the same agentId and class: it sends the same request with the same payment, which the desk does not charge twice.",
      retryAfterSeconds: 30,
    });
  });

  it("keeps a payment the desk did not confirm, and shows the same one again", async () => {
    let down = true;
    const { fetchImpl, seen } = fakeDesk((sent) => {
      if (down) throw new TypeError("fetch failed");
      return opened(sent);
    });
    const d = desk(fetchImpl);
    const first = (await d.sit(request)) as Record<string, unknown>;
    expect(first).toMatchObject({ sitting: seen[0]!.id, possiblyCharged: true, done: false });
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
    await expect(d.sit(request)).rejects.toThrow("The desk holds no sitting for that payment and takes it no more (This payment was already used. Sign a new one). Call brainchain_sit_exam again to sit: it signs a new payment.");
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
    // Another agent, or another class, is another sitting.
    await d.sit({ agentId: "20425", class: "code" });
    expect(seen).toHaveLength(2);
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
    expect(reply).toMatchObject({ state: "submitted", next: "Delivered, and the desk judges it next. Read the outcome with brainchain_exam_status." });
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
      error: "The desk did not confirm the delivery (fetch failed). The work may have arrived. Read the sitting with brainchain_exam_status, and send the item again only if it still reads open.",
    });
    expect(await desk((async () => new Response("bad gateway", { status: 502 })) as typeof fetch).submitExam(SITTING, 0, work)).toMatchObject({ possiblyDelivered: true, error: expect.stringMatching(/^The desk answered 502\./) });
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
    expect(passed.next).toBe("Passed, with 4 of 5 accepted. The licence is in licence. It is valid until 2100-03-02T00:00:00Z, for as long as the agent's id keeps its controller and its build.");
    const failed = (await reader(() => json(view(SITTING, { state: "failed", items: judged(3) }))).d.examStatus(SITTING, false)) as Record<string, unknown>;
    expect(failed).toMatchObject({ done: true, next: "Failed, with 3 of 5 accepted, and a pass takes 4. brainchain_exam_info says how long the agent waits before it may sit again." });
  });

  it("refuses an id the desk does not know, passes on its refusal of a signature, and asks again later when it is busy", async () => {
    await expect(reader(() => json({ error: "Not found." }, 404)).d.examStatus(SITTING, false)).rejects.toThrow(/^The desk has no sitting with this id\. Check the id: it must be one that brainchain_sit_exam returned\.$/);
    const stranger = reader(() => json({ error: "The signature is not the sitting wallet's signature of the briefs message." }, 403)).d.examStatus(SITTING, true);
    await expect(stranger).rejects.toThrow("The signature is not the sitting wallet's signature of the briefs message.");
    expect(await reader(() => new Response("{}", { status: 503, headers: { "retry-after": "7" } })).d.examStatus(SITTING, false)).toMatchObject({ done: false, retryAfterSeconds: 7 });
  });
});

describe("sittingGuidance", () => {
  const at = (items: Record<string, unknown>[], extra: Record<string, unknown> = {}) => sittingGuidance({ state: "open", deadline: 1_800_007_200, passMark: 4, items, ...extra }, 1_800_000_000_000);

  it("names one open item, waits while the desk judges, and says when the time ran out", () => {
    expect(at([{ index: 0, state: "submitted" }, { index: 1, state: "open" }]).next).toMatch(/^Deliver item 1 with brainchain_exam_submit before /);
    expect(at([{ index: 0, state: "submitted" }, { index: 1, state: "judged", accepted: true }])).toEqual({
      done: false,
      next: "Every item is delivered or missed, and the desk is judging what was delivered. Read the sitting again after retryAfterSeconds.",
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
    sitting: { items: 5, passMark: 4, minutes: 120, licenceDays: 60, waitAfterFailingDays: 7 },
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
    expect(await at({ "/exams": json(info) }).d.examInfo()).toEqual({ ...info, pool: { usesPerItem: 3, inUse: 2, retired: 4 } });
    await expect(at({}).d.examInfo()).rejects.toThrow(`The licence exam is not open at ${config.desk}.`);
  });

  it("lists an agent's licences on the chain its id is on, and says when it has none", async () => {
    const held = { agent: { chainId: 46630, id: "20424" }, licences: [{ class: "code", state: "valid", licence: { licence: { expiresAt: 1_805_184_000 }, signature: "0x01" }, audits: { passed: 1, failed: 0 } }] };
    const { d, urls } = at({ "/licences/46630/20424": json(held), "/licences/46630/7": json({ agent: { chainId: 46630, id: "7" }, licences: [] }) });
    expect(await d.licences("20424")).toEqual(held);
    expect(urls).toEqual([`${config.desk}/licences/46630/20424`]);
    expect(await d.licences("7")).toMatchObject({ licences: [], next: "Agent 7 holds no licence. brainchain_exam_info says what a sitting takes, and brainchain_sit_exam opens one." });
    await expect(at({}).d.licences("20424")).rejects.toThrow("The licence exam is not open");
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
      record: { url: `${config.desk}/agents/46630/20424/record`, head, entries, next: `${config.desk}/agents/46630/20424/record?from=21&limit=${RECORD_PAGE}` },
      papers: { url: `${config.desk}/papers/46630/20424`, signedAt: 1_800_000_060, epoch: papers.epoch, licences: papers.licences, ceiling: papers.ceiling },
      verify: "npx brainchain-verify testnet --record 20424",
    });
    expect(urls.sort()).toEqual(Object.keys(routes).map((path) => `${config.desk}${path}`).sort());

    // An agent whose id exists and has not worked yet has Papers and no record.
    const fresh = (await at({ "/papers/46630/20424": routes["/papers/46630/20424"]! }).d.agentRecord("20424")) as { record: unknown };
    expect(fresh.record).toEqual({ url: `${config.desk}/agents/46630/20424/record`, entries: [], note: "The desk has no entry on record for this agent." });
    await expect(at({}).d.agentRecord("9")).rejects.toThrow("The desk has no record and no Papers for agent 9 on chain 46630. Check the id.");
    await expect(at({ "/papers/46630/9": json({ error: "The agent's identity could not be read just now. Try again shortly." }, 503) }).d.agentRecord("9")).rejects.toThrow(
      "The desk answered 503: it is busy or briefly unavailable. Try again in a minute.",
    );
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
    const sat = await callTool(fake, SIT_EXAM_NAME, { agentId: "20424" });
    expect(sat.isError).toBe(false);
    // The briefs follow the summary as text blocks of their own, as written.
    expect(body(sat)).toEqual({ sitting: SITTING, deadline: DEADLINE, briefs: briefs.map(({ index, title, state }) => ({ index, title, state })) });
    expect(sat.content.slice(1)).toEqual(briefs.map(({ index, title, brief }) => ({ type: "text", text: `Item ${index}: ${title}\n\n${brief}` })));
    await callTool(fake, SIT_EXAM_NAME, { agentId: "0", class: "code" });
    await callTool(fake, EXAM_SUBMIT_NAME, { sitting: SITTING.toUpperCase().replace("0X", "0x"), item: 4, text: "  def f(): pass\n" });
    await callTool(fake, EXAM_STATUS_NAME, { sitting: SITTING });
    await callTool(fake, EXAM_STATUS_NAME, { sitting: SITTING, briefs: true });
    await callTool(fake, EXAM_INFO_NAME, {});
    await callTool(fake, LICENCES_NAME, { agentId: "20424" });
    await callTool(fake, AGENT_RECORD_NAME, { agentId: "20424" });
    expect(calls).toEqual([
      ["sit", { agentId: "20424", class: "code" }],
      ["sit", { agentId: "0", class: "code" }],
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
      [SIT_EXAM_NAME, { agentId: "0x1f" }, 'agentId must be the agent\'s ERC-8004 id, a whole number written as a string, such as "20424".'],
      [SIT_EXAM_NAME, { agentId: "007" }, 'agentId must be the agent\'s ERC-8004 id, a whole number written as a string, such as "20424".'],
      [SIT_EXAM_NAME, { agentId: "7", class: "Code!" }, 'class must be one of the classes brainchain_exam_info lists, such as "code".'],
      [SIT_EXAM_NAME, { agentId: "7", maxPrice: "9" }, "Unknown field: maxPrice. This tool takes only agentId, class."],
      [EXAM_SUBMIT_NAME, { sitting: "0x12", item: 0, text: "x" }, "sitting must be the 0x-prefixed, 64-character hex id that brainchain_sit_exam returned."],
      [EXAM_SUBMIT_NAME, { sitting: SITTING, text: "x" }, "item is required."],
      [EXAM_SUBMIT_NAME, { sitting: SITTING, item: "1", text: "x" }, "item must be the item's index as the sitting lists it, a whole number from 0."],
      [EXAM_SUBMIT_NAME, { sitting: SITTING, item: 10, text: "x" }, "item must be the item's index as the sitting lists it, a whole number from 0."],
      [EXAM_SUBMIT_NAME, { sitting: SITTING, item: 0 }, "text is required."],
      [EXAM_SUBMIT_NAME, { sitting: SITTING, item: 0, text: " \n" }, "text is empty."],
      [EXAM_SUBMIT_NAME, { sitting: SITTING, item: 0, text: "é".repeat(MAX_RESULT_BYTES / 2 + 1) }, "text is 100,002 bytes; the limit is 100,000."],
      [EXAM_STATUS_NAME, { sitting: SITTING, briefs: "yes" }, "briefs must be true or false, not a string."],
      [EXAM_STATUS_NAME, {}, "sitting is required."],
      [EXAM_INFO_NAME, { class: "code" }, "Unknown field: class. This tool takes nothing."],
      [LICENCES_NAME, { agentId: "-1" }, 'agentId must be the agent\'s ERC-8004 id, a whole number written as a string, such as "20424".'],
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
    expect(sit).toContain(`pays exactly that from this server's wallet ${signer.address} on Robinhood Chain.`);
    expect(sit).toContain("for this one call that limit is set to the price the desk states, and no further.");
    expect(sit).toContain("a price above this server's budget of 10 USDG per run is refused with nothing charged.");
    expect(sit).toContain("Nothing is refunded, whatever the outcome.");
    expect(sitExamTool("BRAINCHAIN_NETWORK must be mainnet or testnet.").description).toMatch(/^Invalid setting: BRAINCHAIN_NETWORK must be mainnet or testnet\. Until the operator fixes it, this tool only returns that error\. Open a sitting/);
    const submit = examSubmitTool().description!;
    expect(submit).toContain("An item takes one delivery: once sent, the work cannot be replaced or sent again");
    expect(examSubmitTool("BRAINCHAIN_PAYER_KEY must be 64 hex characters, with or without 0x.").description).toMatch(/^Invalid setting: BRAINCHAIN_PAYER_KEY must be 64 hex characters/);
    expect(AGENT_RECORD_TOOL.description).toContain("`npx brainchain-verify <network> --record <agentId>`");
    expect(AGENT_RECORD_TOOL.description).toContain(`its first ${RECORD_PAGE} entries`);
  });

  it("mark the sitting and a delivery as not to be repeated, and every read as read-only", () => {
    for (const tool of [sitExamTool(resolveConfig({}).terms), examSubmitTool()]) expect(tool.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
    for (const tool of [EXAM_INFO_TOOL, EXAM_STATUS_TOOL, LICENCES_TOOL, AGENT_RECORD_TOOL]) expect(tool.annotations).toEqual({ readOnlyHint: true, openWorldHint: true });
  });

  it("never name the model behind BrainChain's decisions", () => {
    const tools = [EXAM_INFO_TOOL, sitExamTool(resolveConfig({}).terms), examSubmitTool(), EXAM_STATUS_TOOL, LICENCES_TOOL, AGENT_RECORD_TOOL];
    for (const tool of tools) expect(JSON.stringify(tool)).not.toMatch(/\bJev\b|—/);
  });
});
