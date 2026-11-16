import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { expressApp } from "../src/express.ts";
import { honoApp } from "../src/hono.ts";
import { JOB, UNREADABLE } from "../src/job.ts";
import { createJudge, type JudgeConfig } from "../src/judge.ts";
import { createSeller, type Seller } from "../src/seller.ts";
import { mockBrainChain, type MockOptions } from "./mock-brainchain.ts";

// Anvil's second default account: a public test key that holds nothing anywhere.
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const SELLER = privateKeyToAccount(KEY).address;
const ORIGIN = "https://brainchain.test";
const LANE = { payTo: "0xf848984c8A0D9E49Cc9C97380C62b34C6f3b97D1", network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" } as const;
const STRANGER = "0x000000000000000000000000000000000000dEaD";

const ORDER = {
  brief: "Write a Python function week_start(text) that takes an ISO week date such as 2026-W44 and returns the Monday of that week as a datetime.date.",
  tests: 'from datetime import date as _date\nassert week_start("2026-W44") == _date(2026, 10, 26)\nassert week_start("2027-W01") == _date(2027, 1, 4)',
};
const FUNCTION = 'from datetime import date\n\ndef week_start(text):\n    year, week = text.split("-W")\n    return date.fromisocalendar(int(year), int(week), 1)';
const BROKEN = "from datetime import date\n\ndef week_start(text):\n    return date.today()";
const fenced = (code: string) => `\`\`\`python\n${code}\n\`\`\``;

/** The payment headers the seller's store holds, oldest order first. */
async function storedHeaders(dir: string): Promise<string[]> {
  const names = await readdir(join(dir, "orders")).catch(() => []);
  const orders = await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => JSON.parse(await readFile(join(dir, "orders", name), "utf8"))));
  return orders.flatMap((order) => order.attempts.flatMap((attempt: { signed?: { headers: Record<string, string> } }) => (attempt.signed ? [attempt.signed.headers["PAYMENT-SIGNATURE"]!] : [])));
}

interface Client {
  request(path: string, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

const FRAMEWORKS: Record<"express" | "hono", (seller: Seller) => Promise<Client>> = {
  express: async (seller) => {
    const server = expressApp(seller).listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    return {
      request: (path, init) => fetch(`http://127.0.0.1:${port}${path}`, init),
      close: () => new Promise((resolve) => server.close(() => resolve())),
    };
  },
  hono: async (seller) => {
    const app = honoApp(seller);
    return { request: async (path, init) => app.request(path, init), close: async () => {} };
  },
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup(
  framework: keyof typeof FRAMEWORKS,
  given: {
    mock?: Partial<MockOptions>;
    brainchain?: ReturnType<typeof mockBrainChain>;
    judge?: Partial<JudgeConfig>;
    fetch?: typeof fetch;
    work?: (prompt: string) => Promise<string>;
    dir?: string;
  } = {},
) {
  const dir = given.dir ?? (await mkdtemp(join(tmpdir(), "reference-seller-")));
  const brainchain = given.brainchain ?? mockBrainChain({ origin: ORIGIN, ...LANE, price: 250_000n, ...given.mock });
  const printed: string[] = [];
  const logged: string[] = [];
  const config: JudgeConfig = { url: ORIGIN, ...LANE, token: "test USDC", maxUnits: 250_000n, dailyUnits: 2_500_000n, dir, key: KEY, ...given.judge };
  const judge = createJudge(config, { fetch: given.fetch ?? brainchain.fetch, pollMs: 5, log: (line) => printed.push(line) });
  const work = vi.fn(given.work ?? (async () => FUNCTION));
  const seller = await createSeller({ dir, judge, work, retryMs: 5, log: (line) => logged.push(line) });
  const client = await FRAMEWORKS[framework](seller);
  cleanups.push(async () => {
    await client.close();
    if (!given.dir) await rm(dir, { recursive: true, force: true });
  });

  const order = async (body: unknown = ORDER) => {
    const response = await client.request("/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const settled = (id: string) =>
    vi.waitFor(
      async () => {
        const view = await (await client.request(`/orders/${id}`)).json();
        if (view.state === "working" || view.state === "grading") throw new Error(`the order is still ${view.state}`);
        return view;
      },
      { timeout: 5_000, interval: 10 },
    );
  const placeAndSettle = async (body: unknown = ORDER) => settled((await order(body)).body.order);
  const spent = async () => {
    const text = await readFile(join(dir, "spend.json"), "utf8").catch(() => undefined);
    return text === undefined ? "0" : (JSON.parse(text) as { units: string }).units;
  };
  return { dir, brainchain, printed, logged, work, client, order, settled, placeAndSettle, spent };
}

describe.each(["express", "hono"] as const)("a seller on %s", (framework) => {
  it("has the delivery judged on BrainChain and releases it with the decision page once accepted", async () => {
    const { brainchain, order, settled, spent, work } = await setup(framework);
    const placed = await order();
    expect(placed).toMatchObject({ status: 202, body: { state: "working", job: JOB.title } });
    expect(placed.body).not.toHaveProperty("delivery");

    expect(await settled(placed.body.order)).toEqual({
      order: placed.body.order,
      job: JOB.title,
      state: "accepted",
      delivery: fenced(FUNCTION),
      judged: [{ accepted: true, passProbability: 0.91, bar: 0.8, tests: "passed", decision: `${ORIGIN}/decision?id=4800` }],
    });
    expect(brainchain.paid).toEqual([
      {
        path: "/x402/grades",
        payer: SELLER,
        amount: "250000",
        request: { title: JOB.title, brief: ORDER.brief, levels: JOB.levels, pass: 1, result: fenced(FUNCTION), checks: { language: "python", code: ORDER.tests } },
      },
    ]);
    expect(work).toHaveBeenCalledOnce();
    expect(work.mock.calls[0]![0]).toContain(ORDER.tests);
    expect(await spent()).toBe("250000");
  });

  it("passes the buyer's own levels and pass on to the grade", async () => {
    const { brainchain, placeAndSettle } = await setup(framework);
    const levels = ["Correct and idiomatic", "Correct", "Wrong"];
    await placeAndSettle({ ...ORDER, title: "ISO week start", levels, pass: 0 });
    expect(brainchain.paid[0]!.request).toMatchObject({ title: "ISO week start", levels, pass: 0 });
  });

  it("redoes a delivery that is not accepted, then marks a refund owed and withholds the work", async () => {
    const { brainchain, placeAndSettle, spent, work } = await setup(framework, { mock: { decide: () => ({ passProbability: 0.42, checks: "passed" }) } });
    const view = await placeAndSettle();
    expect(view).toMatchObject({
      state: "not accepted",
      refund: "owed",
      judged: [
        { accepted: false, passProbability: 0.42, decision: `${ORIGIN}/decision?id=4800` },
        { accepted: false, passProbability: 0.42, decision: `${ORIGIN}/decision?id=4801` },
      ],
    });
    expect(view).not.toHaveProperty("delivery");
    expect(work).toHaveBeenCalledTimes(2);
    expect(work.mock.calls[1]![0]).toContain("judged 42% likely to pass, below the bar of 80%");
    expect(brainchain.paid).toHaveLength(2);
    expect(await spent()).toBe("500000");
  });

  it("rejects work that fails the buyer's tests and shows the worker the failure on the redo", async () => {
    const decide = (request: Record<string, unknown>) =>
      String(request.result).includes("fromisocalendar") ? ({ passProbability: 0.95, checks: "passed" } as const) : ({ passProbability: 0.6, checks: "failed" } as const);
    const deliveries = [BROKEN, FUNCTION];
    const { placeAndSettle, work } = await setup(framework, { mock: { decide }, work: async () => deliveries.shift()! });
    const view = await placeAndSettle();
    expect(view).toMatchObject({
      state: "accepted",
      delivery: fenced(FUNCTION),
      judged: [
        { accepted: false, passProbability: 0, tests: "failed" },
        { accepted: true, passProbability: 0.95, tests: "passed" },
      ],
    });
    expect(work.mock.calls[1]![0]).toContain("The tests failed with AssertionError.\nTraceback");
    expect(work.mock.calls[1]![0]).toContain(BROKEN);
    // The run's output can quote a delivery the buyer never got, so the buyer sees only how it ended.
    expect(JSON.stringify(view)).not.toContain("Traceback");
  });

  it("reads the status URL while BrainChain answers 202", async () => {
    const { brainchain, placeAndSettle } = await setup(framework, { mock: { pending: 3 } });
    expect(await placeAndSettle()).toMatchObject({ state: "accepted", judged: [{ accepted: true }] });
    expect(brainchain.reads).toHaveLength(3);
    expect(brainchain.paid).toHaveLength(1);
  });

  it("reads a grade it paid for after a restart instead of paying again", async () => {
    const brainchain = mockBrainChain({ origin: ORIGIN, ...LANE, price: 250_000n, pending: 2 });
    // The first process pays, then never hears back while BrainChain grades.
    const stalled: typeof fetch = (input, init) => (new Request(input, init).method === "GET" ? new Promise(() => {}) : brainchain.fetch(input, init));
    const first = await setup(framework, { brainchain, fetch: stalled });
    const { order } = (await first.order()).body;
    await vi.waitFor(async () => {
      const saved = JSON.parse(await readFile(join(first.dir, "orders", `${order}.json`), "utf8"));
      expect(saved.attempts[0].paid).toBeDefined();
    });

    const second = await setup(framework, { brainchain, dir: first.dir });
    expect(await second.settled(order)).toMatchObject({ state: "accepted" });
    expect(brainchain.signed).toBe(1);
    expect(await second.spent()).toBe("250000");
  });

  it("stores the signed payment before sending it, and after a lost reply sends that same header again on restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reference-seller-"));
    const brainchain = mockBrainChain({ origin: ORIGIN, ...LANE, price: 250_000n });
    let storedFirst = false;
    // BrainChain takes the payment and grades the work, and the reply never reaches the seller.
    const lost: typeof fetch = async (input, init) => {
      const header = new Request(input, init).headers.get("payment-signature");
      if (!header) return brainchain.fetch(input, init);
      storedFirst = (await storedHeaders(dir)).includes(header);
      await brainchain.fetch(input, init);
      return new Promise(() => {});
    };
    const first = await setup(framework, { brainchain, fetch: lost, dir });
    const { order } = (await first.order()).body;
    await vi.waitFor(() => expect(brainchain.paid).toHaveLength(1));
    expect(storedFirst).toBe(true);
    expect(await first.spent()).toBe("250000");

    const second = await setup(framework, { brainchain, dir });
    expect(await second.settled(order)).toMatchObject({ state: "accepted", judged: [{ accepted: true }] });
    expect(brainchain.payments).toHaveLength(2);
    expect(brainchain.payments[1]).toEqual(brainchain.payments[0]);
    expect(brainchain.signed).toBe(1);
    expect(brainchain.paid).toHaveLength(1);
    expect(await second.spent()).toBe("250000");
    await rm(dir, { recursive: true, force: true });
  });

  it("sends the same header again when BrainChain does not answer", async () => {
    const brainchain = mockBrainChain({ origin: ORIGIN, ...LANE, price: 250_000n });
    let failures = 1;
    const flaky: typeof fetch = async (input, init) => {
      if (new Request(input, init).headers.has("payment-signature") && failures-- > 0) throw new TypeError("fetch failed");
      return brainchain.fetch(input, init);
    };
    const { placeAndSettle, spent } = await setup(framework, { brainchain, fetch: flaky });
    expect(await placeAndSettle()).toMatchObject({ state: "accepted" });
    expect(brainchain.signed).toBe(1);
    expect(brainchain.paid).toHaveLength(1);
    expect(await spent()).toBe("250000");
  });

  it("signs once more, and says so, when the stored payment expired before it ever reached BrainChain", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reference-seller-"));
    const brainchain = mockBrainChain({ origin: ORIGIN, ...LANE, price: 250_000n, maxTimeoutSeconds: 2 });
    const dropped: typeof fetch = (input, init) => (new Request(input, init).headers.has("payment-signature") ? new Promise(() => {}) : brainchain.fetch(input, init));
    const first = await setup(framework, { brainchain, fetch: dropped, dir });
    const { order } = (await first.order()).body;
    await vi.waitFor(async () => expect(await storedHeaders(dir)).toHaveLength(1));
    const [stale] = await storedHeaders(dir);
    await sleep(2_100);

    const second = await setup(framework, { brainchain, dir });
    expect(await second.settled(order)).toMatchObject({ state: "accepted" });
    expect(brainchain.payments.map((p) => p.header)).not.toContain(stale);
    expect(brainchain.signed).toBe(1);
    expect(await storedHeaders(dir)).toEqual([brainchain.payments[0]!.header]);
    expect(second.logged.filter((line) => line.includes("expired before it reached BrainChain"))).toHaveLength(1);
    expect(await second.spent()).toBe("250000");
    await rm(dir, { recursive: true, force: true });
  });

  it("fails the order on a refused payment and counts nothing against the day", async () => {
    const { placeAndSettle, spent } = await setup(framework, { mock: { refuse: "The payer's balance is below the price." } });
    expect(await placeAndSettle()).toMatchObject({
      state: "failed",
      reason: "BrainChain refused the payment: The payer's balance is below the price. Nothing was charged.",
    });
    expect(await spent()).toBe("0");
  });

  it("pays at the partner route at the partner's price", async () => {
    const { brainchain, placeAndSettle, spent } = await setup(framework, {
      mock: { partners: { acme: { price: 10_000n, payers: [SELLER] } } },
      judge: { partner: "acme" },
    });
    expect(await placeAndSettle()).toMatchObject({ state: "accepted" });
    expect(brainchain.paid).toMatchObject([{ path: "/x402/grades/for/acme", amount: "10000" }]);
    expect(await spent()).toBe("10000");
  });

  it("counts nothing when the partner route refuses a wallet that is not the partner's", async () => {
    const { placeAndSettle, spent } = await setup(framework, {
      mock: { partners: { acme: { price: 10_000n, payers: [STRANGER] } } },
      judge: { partner: "acme" },
    });
    const view = await placeAndSettle();
    expect(view.state).toBe("failed");
    expect(view.reason).toMatch(/^BrainChain refused the payment: This route is for a named partner's wallets/);
    expect(await spent()).toBe("0");
  });

  it("signs nothing for a grade priced above the per-grade cap", async () => {
    const { brainchain, placeAndSettle, spent } = await setup(framework, { mock: { price: 300_000n } });
    expect(await placeAndSettle()).toMatchObject({
      state: "failed",
      reason: "A grade costs 0.3 test USDC, above the per-grade cap of 0.25 test USDC. Nothing was paid.",
    });
    expect(brainchain.signed).toBe(0);
    expect(await spent()).toBe("0");
  });

  it("keeps the daily cap on disk, across a restart", async () => {
    const judge = { dailyUnits: 500_000n };
    const first = await setup(framework, { judge });
    expect(await first.placeAndSettle()).toMatchObject({ state: "accepted" });
    expect(await first.placeAndSettle()).toMatchObject({ state: "accepted" });
    const capped = "Grades cost 0.5 test USDC today, and 0.25 test USDC more would pass the daily cap of 0.5 test USDC. Nothing was paid.";
    expect(await first.placeAndSettle()).toMatchObject({ state: "failed", reason: capped });
    expect(first.brainchain.signed).toBe(2);

    const second = await setup(framework, { judge, dir: first.dir });
    expect(await second.placeAndSettle()).toMatchObject({ state: "failed", reason: capped });
    expect(second.brainchain.signed).toBe(0);
  });

  it("pays nobody but BrainChain's address", async () => {
    const { brainchain, placeAndSettle } = await setup(framework, { mock: { payTo: STRANGER } });
    expect(await placeAndSettle()).toMatchObject({
      state: "failed",
      reason: `BrainChain offers no test USDC transfer authorization to ${LANE.payTo} on ${LANE.network}. Nothing was paid.`,
    });
    expect(brainchain.signed).toBe(0);
  });

  it("prints each grade request in a dry run and sends nothing", async () => {
    const { brainchain, printed, placeAndSettle } = await setup(framework, { judge: { key: undefined, partner: "acme" } });
    expect(await placeAndSettle()).toMatchObject({ state: "dry" });
    expect(brainchain.seen).toEqual([]);
    expect(printed).toHaveLength(1);
    const [head, ...rest] = printed[0]!.split("\n");
    expect(head).toBe(`dry run, nothing paid: POST ${ORIGIN}/x402/grades/for/acme`);
    expect(JSON.parse(rest.join("\n"))).toEqual({
      title: JOB.title,
      brief: ORDER.brief,
      levels: JOB.levels,
      pass: 1,
      result: fenced(FUNCTION),
      checks: { language: "python", code: ORDER.tests },
    });
  });

  it("refuses an order it cannot read before any work starts", async () => {
    const { client, order, work } = await setup(framework);
    const garbled = await client.request("/orders", { method: "POST", headers: { "content-type": "application/json" }, body: "{brief" });
    expect(garbled.status).toBe(400);
    expect(await garbled.json()).toEqual({ error: UNREADABLE });
    expect(await order({ brief: ORDER.brief })).toMatchObject({ status: 400, body: { error: expect.stringMatching(/^tests is 1 to 32,000 characters/) } });
    expect(await order({ ...ORDER, pass: 2 })).toMatchObject({ status: 400, body: { error: expect.stringMatching(/^pass is the index/) } });
    expect((await client.request("/orders/nope")).status).toBe(404);
    expect(work).not.toHaveBeenCalled();
  });
});

describe("reading a grade", () => {
  const grade = `0x${"ab".repeat(32)}`;
  const taken = { grade, status: `${ORIGIN}/x402/grades/${grade}`, units: "250000" };

  it("tries a read that fails for now again, saying so, and stops at a refusal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reference-seller-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const answers: (() => Response)[] = [
      () => {
        throw new TypeError("fetch failed");
      },
      () => new Response("{}", { status: 503 }),
      () => new Response("{}", { status: 429 }),
      () => new Response(JSON.stringify({ error: "This wallet may not read that grade" }), { status: 403 }),
    ];
    const reads = vi.fn(async () => answers.shift()!());
    const printed: string[] = [];
    const judge = createJudge({ url: ORIGIN, ...LANE, token: "test USDC", maxUnits: 250_000n, dailyUnits: 2_500_000n, dir, key: KEY }, { fetch: reads as unknown as typeof fetch, pollMs: 1, log: (line) => printed.push(line) });
    await expect(judge.read(taken)).rejects.toThrow(`BrainChain answered 403 when grade ${grade} was read: This wallet may not read that grade.`);
    expect(reads).toHaveBeenCalledTimes(4);
    expect(printed).toEqual([
      `grade ${grade}: the read failed (fetch failed); reading it again in 0.001 s.`,
      `grade ${grade}: the read failed (BrainChain answered 503); reading it again in 0.001 s.`,
      `grade ${grade}: the read failed (BrainChain answered 429); reading it again in 0.001 s.`,
    ]);
  });
});
