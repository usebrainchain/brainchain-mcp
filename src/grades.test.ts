import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveConfig } from "./config.js";
import { createDesk, orderIdOf } from "./payments.js";
import { callTool, checkGrade, GET_GRADE_NAME, GRADE_NAME, MAX_RESULT_BYTES, type Desk } from "./tools.js";

// Anvil's second default account: a public test key that holds nothing anywhere.
const signer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const config = resolveConfig({ BRAINCHAIN_NETWORK: "testnet" });
const grades = `${config.desk}/x402/grades`;
const request = { brief: "Sort 67, 84, 26, 52 and 83, then give the sum.", result: "sorted: 26,52,67,83,84\nsum: 312" };

function challenge(): string {
  const accepts = [{ scheme: "exact", network: config.network, amount: "250000", asset: config.asset, payTo: config.payTo, maxTimeoutSeconds: 300, extra: { assetTransferMethod: "permit2" } }];
  return Buffer.from(JSON.stringify({ x402Version: 2, error: "Payment required", resource: { url: grades, mimeType: "application/json" }, accepts })).toString("base64");
}

/** A desk that challenges unpaid grade requests and hands paid ones to `paid`. */
function fakeDesk(paid: (payment: { payload: unknown }) => Response, unpaid?: () => Response) {
  const seen: { payload: unknown }[] = [];
  const urls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    urls.push(req.url);
    const header = req.headers.get("payment-signature");
    if (!header) return unpaid?.() ?? new Response("{}", { status: 402, headers: { "payment-required": challenge() } });
    const payment = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { payload: unknown };
    seen.push(payment);
    return paid(payment);
  }) as typeof fetch;
  return { fetchImpl, seen, urls };
}

const verdict = (payment: { payload: unknown }, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ grade: orderIdOf(payment), state: "graded", accepted: true, answer: "accept", passProbability: 0.91, bar: 0.8, ...extra }), { status: 200 });

const desk = (fetchImpl: typeof fetch) =>
  createDesk({ config, signer, approveCommand: "npx -y brainchain-mcp approve", fetch: fetchImpl, postTimeoutMs: 10_000 });

describe("grading", () => {
  it("pays once at the grades route and returns the verdict, the price and where to read it", async () => {
    const { fetchImpl, seen, urls } = fakeDesk((p) => verdict(p));
    const d = desk(fetchImpl);
    const reply = (await d.grade(request)) as Record<string, unknown>;
    const id = orderIdOf(seen[0]!);
    expect(seen).toHaveLength(1);
    expect(urls.every((url) => url === grades)).toBe(true);
    expect(reply).toMatchObject({ grade: id, price: "0.25 test USDG", statusUrl: `${grades}/${id}`, accepted: true, done: true });
    expect(reply.next).toMatch(/accepts the work at 91%/);
    expect(d.spent()).toBe(250_000n);
  });

  it("answers an identical request from the first grade instead of paying again", async () => {
    const { fetchImpl, seen } = fakeDesk((p) => verdict(p));
    const d = desk(fetchImpl);
    const first = (await d.grade(request)) as Record<string, unknown>;
    const again = (await d.grade(request)) as Record<string, unknown>;
    expect(seen).toHaveLength(1);
    expect(again).toMatchObject({ grade: first.grade, duplicate: true });
  });

  it("says a grade still being decided is not done and when to read it", async () => {
    const { fetchImpl } = fakeDesk((p) => new Response(JSON.stringify({ grade: orderIdOf(p), state: "paid" }), { status: 202 }));
    const reply = (await desk(fetchImpl).grade(request)) as Record<string, unknown>;
    expect(reply).toMatchObject({ done: false, retryAfterSeconds: 20 });
    expect(reply.next).toMatch(/brainchain_get_grade/);
  });

  it("treats any reply to a signed payment other than 400 or 402 as possibly charged, with the grade's id", async () => {
    const { fetchImpl, seen } = fakeDesk(() => new Response(JSON.stringify({ error: "Jev could not grade the work just now." }), { status: 502 }));
    const reply = (await desk(fetchImpl).grade(request)) as Record<string, unknown>;
    expect(reply).toMatchObject({ grade: orderIdOf(seen[0]!), possiblyCharged: true });
    expect(reply.error).toMatch(/brainchain_get_grade; do not send it again/);
  });

  it("reports a request the desk refuses before payment, with nothing charged", async () => {
    const { fetchImpl, seen } = fakeDesk((p) => verdict(p), () => new Response(JSON.stringify({ error: "brief is empty" }), { status: 400 }));
    const d = desk(fetchImpl);
    await expect(d.grade(request)).rejects.toThrow(/brief is empty\. Nothing was charged\./);
    expect(seen).toHaveLength(0);
    expect(d.spent()).toBe(0n);
  });
});

describe("reading a grade", () => {
  const id = `0x${"ab".repeat(32)}`;
  const reader = (response: Response) => desk((async () => response) as typeof fetch);

  it("returns a decided verdict as done", async () => {
    const view = (await reader(new Response(JSON.stringify({ grade: id, state: "graded", accepted: false, passProbability: 0.42 }))).getGrade(id)) as Record<string, unknown>;
    expect(view).toMatchObject({ done: true });
    expect(view.next).toMatch(/does not accept the work at 42%/);
  });

  it("says an unknown id was never charged", async () => {
    const view = (await reader(new Response(JSON.stringify({ error: "No grade with that id." }), { status: 404 })).getGrade(id)) as Record<string, unknown>;
    expect(view).toMatchObject({ done: true, error: "The desk has no grade with this id." });
  });

  it("asks again later when the desk is busy", async () => {
    const view = (await reader(new Response("{}", { status: 503 })).getGrade(id)) as Record<string, unknown>;
    expect(view).toMatchObject({ done: false, retryAfterSeconds: 30 });
  });
});

describe("checkGrade", () => {
  it("keeps what the desk accepts, trimmed", () => {
    expect(checkGrade({ ...request, title: "  Croupier  ", levels: ["Exact", "Close", "Wrong"], pass: 1 })).toEqual({ ...request, title: "Croupier", levels: ["Exact", "Close", "Wrong"], pass: 1 });
  });

  it("refuses what the desk would refuse", () => {
    expect(() => checkGrade({ brief: "x" })).toThrow("result is required.");
    expect(() => checkGrade({ brief: "x", result: "​ " })).toThrow("result is empty.");
    expect(() => checkGrade({ brief: "x", result: "é".repeat(MAX_RESULT_BYTES / 2 + 1) })).toThrow(/the limit is 100,000/);
    expect(() => checkGrade({ ...request, title: "one\ntwo" })).toThrow("title must be one line.");
    expect(() => checkGrade({ ...request, levels: ["only one"] })).toThrow(/2 to 5 quality levels/);
    expect(() => checkGrade({ ...request, levels: ["Good", "Good"] })).toThrow(/repeats/);
    expect(() => checkGrade({ ...request, pass: 0 })).toThrow(/pass needs levels/);
    expect(() => checkGrade({ ...request, levels: ["A", "B", "C"], pass: 2 })).toThrow(/from 0 to 1/);
  });
});

describe("the grade tools", () => {
  const refuse = async (): Promise<never> => {
    throw new Error("not this");
  };
  const noDesk: Desk = { post: refuse, get: refuse, grade: async (r) => ({ graded: r }), getGrade: async (id) => ({ read: id }) };

  it("route to the desk and refuse unknown fields and bad ids", async () => {
    const graded = await callTool(noDesk, GRADE_NAME, request);
    expect(graded.isError).toBe(false);
    expect((await callTool(noDesk, GRADE_NAME, { ...request, bounty: 5 })).content[0]).toMatchObject({ text: expect.stringContaining("Unknown field: bounty") });
    expect((await callTool(noDesk, GET_GRADE_NAME, { grade: "0x12" })).isError).toBe(true);
    const read = await callTool(noDesk, GET_GRADE_NAME, { grade: `0x${"AB".repeat(32)}` });
    expect(read.content[0]).toMatchObject({ text: expect.stringContaining(`0x${"ab".repeat(32)}`) });
  });
});

describe("a grade's money", () => {
  afterEach(() => vi.restoreAllMocks());

  const later = () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 16 * 60_000);
  };
  /** A desk whose reads all answer `read`; paid POSTs go to `paid`. */
  function withReads(paid: (payment: { payload: unknown }) => Response, read: () => Response) {
    const inner = fakeDesk(paid);
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => ((init?.method ?? (input instanceof Request ? input.method : "GET")) === "GET" ? read() : inner.fetchImpl(input, init))) as typeof fetch;
    return { ...inner, fetchImpl };
  }
  const gone = () => new Response("{}", { status: 404 });

  it("keeps a charged grade's hold when its id is read as a task's order", async () => {
    const { fetchImpl } = withReads((p) => verdict(p), gone);
    const d = desk(fetchImpl);
    const { grade } = (await d.grade(request)) as { grade: string };
    later();
    await d.get(grade);
    expect(d.spent()).toBe(250_000n);
  });

  it("releases a grade the desk never knew once the window has passed, and says it can be sent again", async () => {
    const { fetchImpl } = withReads((p) => verdict(p), gone);
    const d = desk(fetchImpl);
    const { grade } = (await d.grade(request)) as { grade: string };
    later();
    const read = (await d.getGrade(grade)) as Record<string, unknown>;
    expect(read).toMatchObject({ grade, done: true });
    expect(read.next).toMatch(/never charged, so you can send it again/);
    expect(d.spent()).toBe(0n);
  });

  it("finishes a failed grade and gives back what it held", async () => {
    const { fetchImpl } = withReads((p) => verdict(p), () => new Response(JSON.stringify({ state: "failed" }), { status: 200 }));
    const d = desk(fetchImpl);
    const { grade } = (await d.grade(request)) as { grade: string };
    const read = (await d.getGrade(grade)) as Record<string, unknown>;
    expect(read).toMatchObject({ done: true });
    expect(read.next).toMatch(/nothing was charged/);
    expect(d.spent()).toBe(0n);
  });

  it("books nothing for a payment the desk cancelled to answer from an earlier grade", async () => {
    const first = `0x${"cd".repeat(32)}`;
    const { fetchImpl } = fakeDesk((p) => verdict(p, { grade: first }));
    const d = desk(fetchImpl);
    const reply = (await d.grade(request)) as Record<string, unknown>;
    expect(reply).toMatchObject({ grade: first, duplicate: true, price: "0 test USDG" });
    expect(d.spent()).toBe(0n);
  });

  it("quotes a grade's own price when the wallet cannot pay", async () => {
    const { fetchImpl, urls } = withReads(() => new Response(JSON.stringify({ error: "insufficient funds" }), { status: 402 }), gone);
    const d = createDesk({ config, signer, approveCommand: "x", fetch: fetchImpl, postTimeoutMs: 10_000, funds: async () => ({ balance: 100_000n, allowance: 10n ** 18n }) });
    await expect(d.grade(request)).rejects.toThrow(/a grade costs 0\.25\. Nothing was charged\. Send at least 0\.15/);
    expect(urls.every((url) => url === grades)).toBe(true);
  });
});
