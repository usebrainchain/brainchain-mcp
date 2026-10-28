import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";

import { REPOST_AFTER_MINUTES, resolveConfig } from "./config.js";
import { canonicalStringify, createDesk, guidance, orderIdOf } from "./payments.js";
import { callTool, checkBrief, POST_TASK_NAME, type Desk } from "./tools.js";

// Anvil's second default account: a public test key that holds nothing anywhere.
const signer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const config = resolveConfig({ BRAINCHAIN_NETWORK: "testnet" });
const endpoint = `${config.desk}/x402/tasks`;
const task = { title: "Explain a Merkle proof", brief: "In two paragraphs.", levels: ["Accurate and complete", "Accurate", "Wrong"] };

interface ChallengeOverrides {
  amount?: string;
  payTo?: string;
  maxTimeoutSeconds?: number;
}

function challenge(terms: ChallengeOverrides = {}): string {
  const required = {
    x402Version: 2,
    error: "Payment required",
    resource: { url: endpoint, description: "A BrainChain task", mimeType: "application/json" },
    accepts: [
      {
        scheme: "exact",
        network: config.network,
        amount: terms.amount ?? "1000000",
        asset: config.asset,
        payTo: terms.payTo ?? config.payTo,
        maxTimeoutSeconds: terms.maxTimeoutSeconds ?? 300,
        extra: { assetTransferMethod: "permit2" },
      },
    ],
  };
  return Buffer.from(JSON.stringify(required)).toString("base64");
}

/** A desk that challenges unpaid requests and hands paid ones to `paid`. */
function fakeDesk(paid: (payment: { payload: unknown }) => Response | Promise<Response>, terms?: ChallengeOverrides) {
  const seen: { payload: unknown }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const header = request.headers.get("payment-signature");
    if (!header) return new Response("{}", { status: 402, headers: { "payment-required": challenge(terms) } });
    const payment = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { payload: unknown };
    seen.push(payment);
    return paid(payment);
  }) as typeof fetch;
  return { fetchImpl, seen };
}

const accepted = (payment: { payload: unknown }) =>
  new Response(JSON.stringify({ order: orderIdOf(payment), status: `/x402/tasks/${orderIdOf(payment)}` }), { status: 202 });

function desk(fetchImpl: typeof fetch, overrides: Partial<typeof config> = {}) {
  return createDesk({ config: { ...config, ...overrides }, signer, approveCommand: "npx -y brainchain-mcp approve", fetch: fetchImpl, postTimeoutMs: 10_000 });
}

describe("order ids", () => {
  it("match the desk's: keccak256 of the payload with sorted keys", () => {
    const payload = {
      signature: "0xabc",
      permit2Authorization: {
        permitted: { token: "0x1eC185467cA2D5d1c24f0EdCB91301Bca4d0a787", amount: "1000000" },
        spender: "0x402",
        nonce: "123",
        deadline: "1792900000",
        witness: { to: "0xf848984c8A0D9E49Cc9C97380C62b34C6f3b97D1", validAfter: "0", extra: "0x" },
        from: "0x01",
      },
    };
    // Computed with the desk's own serializer.
    expect(orderIdOf({ payload })).toBe("0xd3df7ba38a2d01e400f6c151b798543edf69d329ee7f44709c1c4b9da48ce955");
    expect(canonicalStringify({ b: [1, { d: null, c: true }], a: "x" })).toBe('{"a":"x","b":[1,{"c":true,"d":null}]}');
  });
});

describe("posting", () => {
  it("pays once and returns the desk's order, the price paid and where to read it", async () => {
    const { fetchImpl, seen } = fakeDesk(accepted);
    const d = desk(fetchImpl);
    const reply = (await d.post(task)) as Record<string, unknown>;
    const order = orderIdOf(seen[0]!);
    expect(seen).toHaveLength(1);
    expect(reply).toMatchObject({ order, price: "1 test USDG", statusUrl: `${endpoint}/${order}` });
    expect(reply).not.toHaveProperty("duplicate");
    expect(d.spent()).toBe(1_000_000n);
  });

  it("returns the order id when the paid request fails, so the model does not pay twice", async () => {
    const { fetchImpl, seen } = fakeDesk(() => {
      throw new TypeError("fetch failed");
    });
    const reply = (await desk(fetchImpl).post(task)) as { order: string; possiblyCharged: boolean; error: string };
    expect(reply.possiblyCharged).toBe(true);
    expect(reply).toMatchObject({ order: orderIdOf(seen[0]!), price: "1 test USDG", statusUrl: `${endpoint}/${orderIdOf(seen[0]!)}` });
    expect(reply.error).toMatch(/do not post the task again/);
  });

  it("treats a duplicate (409) and a gateway error as possibly charged", async () => {
    for (const status of [409, 502]) {
      const { fetchImpl, seen } = fakeDesk(() => new Response(JSON.stringify({ error: "busy" }), { status }));
      const reply = (await desk(fetchImpl).post(task)) as { order: string; possiblyCharged: boolean };
      expect(reply).toMatchObject({ possiblyCharged: true, order: orderIdOf(seen[0]!) });
    }
  });

  it("treats any reply to a signed payment other than 400 or 402 as possibly charged", async () => {
    for (const status of [408, 429, 403]) {
      const { fetchImpl, seen } = fakeDesk(() => new Response("{}", { status }));
      const d = desk(fetchImpl);
      const reply = (await d.post(task)) as { order: string; possiblyCharged: boolean };
      expect(reply).toMatchObject({ possiblyCharged: true, order: orderIdOf(seen[0]!) });
      expect(d.spent()).toBe(1_000_000n);
    }
  });

  it("releases the budget when the desk rejects the request", async () => {
    const { fetchImpl } = fakeDesk(() => new Response(JSON.stringify({ error: "brief must be 1 to 32,000 characters." }), { status: 400 }));
    const d = desk(fetchImpl);
    await expect(d.post(task)).rejects.toThrow(/Nothing was charged/);
    expect(d.spent()).toBe(0n);
  });

  it("reports a task too large to post as the desk's error, before or after signing", async () => {
    const tooLarge = () => new Response(JSON.stringify({ error: "The task is too large to post." }), { status: 400 });
    const { fetchImpl, seen } = fakeDesk(tooLarge);
    const d = desk(fetchImpl);
    await expect(d.post(task)).rejects.toThrow("The task is too large to post. Nothing was charged.");
    expect(seen).toHaveLength(1);
    expect(d.spent()).toBe(0n);
    await expect(desk((async () => tooLarge()) as typeof fetch).post(task)).rejects.toThrow("The task is too large to post. Nothing was charged.");
  });

  it("refuses a desk that answers without asking for payment", async () => {
    const free = (async () => new Response("<html>ok</html>", { status: 200 })) as typeof fetch;
    await expect(desk(free).post(task)).rejects.toThrow(`The desk at ${config.desk} answered 200 without asking for payment`);
  });

  it("stops at the budget before signing", async () => {
    const { fetchImpl, seen } = fakeDesk(accepted);
    const d = desk(fetchImpl, { budget: 1_500_000n });
    await d.post(task);
    await expect(d.post({ ...task, brief: "In one paragraph." })).rejects.toThrow(/BRAINCHAIN_BUDGET_UNITS/);
    expect(seen).toHaveLength(1);
    expect(d.spent()).toBe(1_000_000n);
  });

  it("refuses to pay anyone but the desk, or for longer than 600 seconds", async () => {
    for (const terms of [{ payTo: "0x000000000000000000000000000000000000dEaD" }, { maxTimeoutSeconds: 3_600 }]) {
      const { fetchImpl, seen } = fakeDesk(accepted, terms);
      await expect(desk(fetchImpl).post(task)).rejects.toThrow(/does not accept/);
      expect(seen).toHaveLength(0);
    }
  });

  it("names the price when the desk asks more than the cap", async () => {
    const { fetchImpl, seen } = fakeDesk(accepted, { amount: "2000000" });
    await expect(desk(fetchImpl).post(task)).rejects.toThrow(/asks 2 test USDG per task, above this server's limit of 1/);
    expect(seen).toHaveLength(0);
  });
});

describe("posting the same task again", () => {
  it("signs once for two identical posts in flight", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { fetchImpl, seen } = fakeDesk(async (payment) => {
      await gate;
      return accepted(payment);
    });
    const d = desk(fetchImpl);
    const first = d.post(task);
    const second = d.post({ ...task, levels: [...task.levels] });
    release();
    expect(await second).toEqual({ ...(await first as object), duplicate: true });
    expect(seen).toHaveLength(1);
    expect(d.spent()).toBe(1_000_000n);
  });

  it("returns the first order for an identical post after it completed, and signs again once the window has passed", async () => {
    const { fetchImpl, seen } = fakeDesk(accepted);
    const d = desk(fetchImpl);
    const first = (await d.post(task)) as { order: string };
    expect(await d.post(task)).toEqual({ ...first, duplicate: true });
    expect(seen).toHaveLength(1);

    const later = Date.now() + REPOST_AFTER_MINUTES * 60_000;
    vi.spyOn(Date, "now").mockReturnValue(later);
    try {
      await d.post(task);
    } finally {
      vi.restoreAllMocks();
    }
    expect(seen).toHaveLength(2);
  });

  it("keeps a possiblyCharged reply, so a retry does not pay again", async () => {
    const { fetchImpl, seen } = fakeDesk(() => new Response("{}", { status: 502 }));
    const d = desk(fetchImpl);
    const first = (await d.post(task)) as { possiblyCharged: boolean };
    expect(first.possiblyCharged).toBe(true);
    expect(await d.post(task)).toEqual({ ...first, duplicate: true });
    expect(seen).toHaveLength(1);
  });

  it("signs anew for a different brief, or after a post that charged nothing", async () => {
    let refuse = true;
    const { fetchImpl, seen } = fakeDesk((payment) => (refuse ? new Response(JSON.stringify({ error: "busy" }), { status: 400 }) : accepted(payment)));
    const d = desk(fetchImpl);
    await expect(d.post(task)).rejects.toThrow(/Nothing was charged/);
    refuse = false;
    const retried = (await d.post(task)) as { order: string };
    const other = (await d.post({ ...task, brief: "In one paragraph." })) as { order: string };
    expect(seen).toHaveLength(3);
    expect(other.order).not.toBe(retried.order);
    expect(d.spent()).toBe(2_000_000n);
  });
});

describe("paying on Base", () => {
  const base = resolveConfig({ BRAINCHAIN_NETWORK: "testnet", BRAINCHAIN_PAY_ON: "base" });
  /** The desk's real challenge: USDG on Robinhood Chain first, then USDC on Base. */
  function bothLanes(paid: (payment: { payload: unknown; accepted?: { network?: string } }) => Response) {
    const usdc = { scheme: "exact", network: base.network, amount: "1000000", asset: base.asset, payTo: base.payTo, maxTimeoutSeconds: 300, extra: { name: "USDC", version: "2" } };
    const usdg = { ...usdc, network: config.network, asset: config.asset, extra: { assetTransferMethod: "permit2" } };
    const header = Buffer.from(JSON.stringify({ x402Version: 2, resource: { url: endpoint }, accepts: [usdg, usdc] })).toString("base64");
    const seen: { payload: unknown; accepted?: { network?: string } }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const signature = request.headers.get("payment-signature");
      if (!signature) return new Response(JSON.stringify({ error: "not enough USDC" }), { status: 402, headers: { "payment-required": header } });
      const payment = JSON.parse(Buffer.from(signature, "base64").toString("utf8")) as { payload: unknown; accepted?: { network?: string } };
      seen.push(payment);
      return paid(payment);
    }) as typeof fetch;
    return { fetchImpl, seen };
  }

  it("picks the Base accept and signs a transfer authorization, not a Permit2 transfer", async () => {
    const { fetchImpl, seen } = bothLanes(accepted);
    await createDesk({ config: base, signer, approveCommand: "unused", fetch: fetchImpl }).post(task);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.accepted?.network).toBe("eip155:84532");
    expect(seen[0]!.payload).toHaveProperty("authorization");
    expect(seen[0]!.payload).not.toHaveProperty("permit2Authorization");
  });

  it("never suggests a Permit2 approval when a payment on Base is refused", async () => {
    const { fetchImpl } = bothLanes(() => new Response(JSON.stringify({ error: "insufficient_funds" }), { status: 402 }));
    const d = createDesk({ config: base, signer, approveCommand: "npx -y brainchain-mcp approve", fetch: fetchImpl, funds: async () => ({ balance: 5_000_000n }) });
    const error = await d.post(task).catch((e: Error) => e);
    expect(String(error)).toMatch(/refused the payment/);
    expect(String(error)).not.toMatch(/Permit2|approve/);
  });

  it("says how much to send, and where, when the wallet is short", async () => {
    const { fetchImpl } = bothLanes(() => new Response(JSON.stringify({ error: "insufficient_funds" }), { status: 402 }));
    const d = createDesk({ config: base, signer: () => signer, approveCommand: "unused", fetch: fetchImpl, funds: async () => ({ balance: 400_000n }) });
    await expect(d.post(task)).rejects.toThrow(`Send at least 0.6 test USDC to ${signer.address} on Base Sepolia, then post again.`);
  });
});

describe("input checks", () => {
  const never: Desk = {
    post: async () => {
      throw new Error("should not be called");
    },
    get: async () => ({}),
  };
  it("rejects briefs the desk would refuse, before anything is signed", async () => {
    for (const input of [
      { ...task, title: "   " },
      { ...task, title: "x".repeat(121) },
      { ...task, brief: "" },
      { ...task, brief: "x".repeat(32_001) },
      { ...task, levels: ["only one"] },
      { ...task, levels: ["a", "b", "c", "d"] },
      { ...task, levels: ["a", "x".repeat(201)] },
    ]) {
      const result = await callTool(never, POST_TASK_NAME, input);
      expect(result.isError).toBe(true);
    }
  });

  it("measures what is sent: trimmed, with briefs up to 32,000 characters", () => {
    expect(checkBrief({ ...task, title: ` ${"x".repeat(120)} `, brief: "x".repeat(32_000) })).toMatchObject({ title: "x".repeat(120) });
  });
});

describe("reading an order", () => {
  it("stops at an order the desk does not know, unless this server paid for it in the last 15 minutes", async () => {
    const order = `0x${"ab".repeat(32)}`;
    expect(await desk((async () => new Response("{}", { status: 404 })) as typeof fetch).get(order)).toMatchObject({
      done: true,
      error: "The desk has no order with this id.",
      next: expect.stringMatching(/^Check the order id/),
    });

    // The paid request drops, so the desk may not have recorded the order yet.
    let paid = "";
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.method === "GET") return new Response(JSON.stringify({ error: "No order with that id." }), { status: 404 });
      const header = request.headers.get("payment-signature");
      if (!header) return new Response("{}", { status: 402, headers: { "payment-required": challenge() } });
      paid = orderIdOf(JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { payload: unknown });
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const d = desk(fetchImpl);
    expect(await d.post(task)).toMatchObject({ possiblyCharged: true, order: paid });
    const settling = (await d.get(paid)) as { done: boolean; next: string; retryAfterSeconds: number };
    expect(settling).toMatchObject({ done: false, retryAfterSeconds: 60 });
    expect(settling.next).toMatch(/nothing was charged and you can post the task again/);

    vi.spyOn(Date, "now").mockReturnValue(Date.now() + REPOST_AFTER_MINUTES * 60_000);
    try {
      expect(await d.get(paid)).toMatchObject({ done: true, error: "The desk has no order with this id." });
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("guides the caller through an unavailable desk instead of failing", async () => {
    const order = `0x${"ab".repeat(32)}`;
    const reply = (status: number) => (async () => new Response("{}", { status })) as typeof fetch;
    expect(await desk(reply(502)).get(order)).toMatchObject({ done: false, retryAfterSeconds: 30 });
    const offline = (async () => Promise.reject(new TypeError("fetch failed"))) as typeof fetch;
    expect(await desk(offline).get(order)).toMatchObject({ done: false, retryAfterSeconds: 30 });
  });

  it("waits out a busy desk, honouring Retry-After", async () => {
    const order = `0x${"ab".repeat(32)}`;
    const reply = (status: number, headers: Record<string, string> = {}) => (async () => new Response("{}", { status, headers })) as typeof fetch;
    for (const status of [408, 425, 429, 503]) expect(await desk(reply(status)).get(order)).toMatchObject({ done: false, retryAfterSeconds: 30 });
    expect(await desk(reply(429, { "retry-after": "120" })).get(order)).toMatchObject({ done: false, retryAfterSeconds: 120 });
    const at = new Date(Date.now() + 90_000).toUTCString();
    const { retryAfterSeconds } = (await desk(reply(503, { "retry-after": at })).get(order)) as { retryAfterSeconds: number };
    expect(retryAfterSeconds).toBeGreaterThan(80);
    expect(retryAfterSeconds).toBeLessThanOrEqual(91);
  });

  it("reads an order again when a 2xx reply is not JSON", async () => {
    const html = (async () => new Response("<html>maintenance</html>", { status: 200 })) as typeof fetch;
    expect(await desk(html).get(`0x${"ab".repeat(32)}`)).toMatchObject({ done: false, retryAfterSeconds: 30, error: "The desk's reply could not be read." });
  });

  it("cuts a long result and links the full record", async () => {
    const result = `${config.desk}/records/0x${"1".repeat(64)}.txt`;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input) === result) return new Response("y".repeat(25_000));
      return new Response(JSON.stringify({ order: "0x01", state: "posted", task: { status: "graded", accepted: true }, result }));
    }) as typeof fetch;
    const view = (await desk(fetchImpl).get(`0x${"a".repeat(64)}`)) as { resultText: string; done: boolean };
    expect(view.done).toBe(true);
    expect(view.resultText.startsWith("y".repeat(20_000))).toBe(true);
    expect(view.resultText).not.toContain("y".repeat(20_001));
    expect(view.resultText).toContain(`Cut at 20,000 of 25,000 characters. The full result is at ${result}.`);
  });

  it("keeps the order when the result cannot be fetched", async () => {
    const result = `${config.desk}/records/0x${"1".repeat(64)}.txt`;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input) === result) throw new TypeError("fetch failed");
      return new Response(JSON.stringify({ order: "0x01", state: "posted", task: { status: "graded", accepted: true }, result }));
    }) as typeof fetch;
    const view = (await desk(fetchImpl).get(`0x${"a".repeat(64)}`)) as Record<string, unknown>;
    expect(view.resultError).toMatch(/could not be fetched/);
    expect(view.done).toBe(false);
  });

  it("says when to stop polling", () => {
    expect(guidance({ resultText: "done", task: { status: "graded", accepted: true } }, config)).toMatchObject({ done: true });
    // A desk that serves results before grading must not read as accepted.
    expect(guidance({ resultText: "draft", state: "posted", task: { status: "delivered" } }, config)).toMatchObject({ done: false, retryAfterSeconds: 30 });
    expect(guidance({ state: "posted", task: { status: "submitted" } }, config)).toMatchObject({ done: false, retryAfterSeconds: 30 });
    for (const state of ["paid-out", "refunded", "refund-failed", "failed"]) expect(guidance({ state }, config).done).toBe(true);
    expect(guidance({ state: "posted", task: { status: "graded", accepted: false } }, config)).toMatchObject({ done: true });
    expect(guidance({ state: "unconfirmed" }, config)).toMatchObject({ done: false, retryAfterSeconds: 30 });
    expect(guidance({ state: "posted", task: { status: "hired" } }, config)).toMatchObject({ done: false, retryAfterSeconds: 60 });
    expect(guidance({ state: "something-new" }, config)).toMatchObject({ done: false });
  });
});
