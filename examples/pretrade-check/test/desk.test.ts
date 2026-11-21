import { describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { describeOffers, deskUrl, GRADE_PAYMENT, gradeId, payGrade } from "../src/desk.ts";
import { pretradeCheck } from "../src/request.ts";

import { MANDATE, recorded } from "./helpers.ts";

const DESK = "https://brain.test";
const account = privateKeyToAccount(generatePrivateKey());
const { trade, quote, registry } = recorded("inside");
const request = pretradeCheck({ quote, registry, mandate: MANDATE, trade });
const base = { scheme: "exact", network: GRADE_PAYMENT.network, amount: "250000", asset: GRADE_PAYMENT.asset, payTo: GRADE_PAYMENT.payTo, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } };
const offer = (accept: Record<string, unknown> = base) =>
  new Response("{}", { status: 402, headers: { "payment-required": Buffer.from(JSON.stringify({ x402Version: 2, resource: { url: `${DESK}/x402/grades` }, accepts: [accept] })).toString("base64") } });
const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

/** A desk that offers a grade, answers the paid request with `paid`, and each read of the grade with the next of `reads`. */
function desk(paid: (id: string) => Response | Error, reads: ((id: string) => Response)[] = []) {
  let id = "";
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const header = (init.headers as Record<string, string>)["PAYMENT-SIGNATURE"];
      if (!header) return offer();
      id = gradeId(JSON.parse(Buffer.from(header, "base64").toString("utf8")).payload);
      const reply = paid(id);
      if (reply instanceof Error) throw reply;
      return reply;
    }
    expect(url).toBe(`${DESK}/x402/grades/${id}`);
    return (reads.shift() ?? (() => answer(404, { error: "No grade with that id." })))(id);
  });
  return fetchImpl;
}
const graded = (id: string, extra: Record<string, unknown> = {}) => ({ grade: id, state: "graded", status: `${DESK}/x402/grades/${id}`, accepted: true, checks: { language: "python", outcome: "passed" }, ...extra });
const pay = (fetchImpl: ReturnType<typeof desk>) => payGrade(request, account, { desk: DESK, fetch: fetchImpl as unknown as typeof fetch, pollMs: 1, waitMs: 1_000 });
const charged = (id: string) => `may have been charged: read ${DESK}/x402/grades/${id}, which is free, and do not run this check again, which would pay again.`;

describe("paying for the grade", () => {
  it("sends the request with its checks and reads the verdict from the paid reply", async () => {
    const fetchImpl = desk((id) => answer(200, graded(id)));
    const paid = await pay(fetchImpl);
    expect(paid.verdict).toEqual(graded(paid.id));
    expect(paid.status).toBe(`${DESK}/x402/grades/${paid.id}`);
    const sent = JSON.parse(fetchImpl.mock.calls[1]![1]!.body as string);
    expect(sent.checks).toEqual({ language: "python", code: request.checks.code });
    expect(sent.pass).toBe(0);
  });

  it("pays nobody but BrainChain, no more than 0.25 USDC, and only by transfer authorization", async () => {
    for (const accept of [{ ...base, payTo: "0x000000000000000000000000000000000000dEaD" }, { ...base, amount: "250001" }, { ...base, extra: { assetTransferMethod: "permit2" } }]) {
      const fetchImpl = vi.fn().mockResolvedValueOnce(offer(accept));
      await expect(payGrade(request, account, { desk: DESK, fetch: fetchImpl as typeof fetch })).rejects.toThrow("Nothing was paid to BrainChain.");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("passes on a request the route refuses before payment", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(answer(400, { error: "result can be at most 100,000 bytes." }));
    await expect(payGrade(request, account, { desk: DESK, fetch: fetchImpl as typeof fetch })).rejects.toThrow("BrainChain answered 400 before payment: result can be at most 100,000 bytes. Nothing was paid to BrainChain.");
  });

  it("takes a 400 to the paid request as nothing charged", async () => {
    await expect(pay(desk(() => answer(400, { error: "The payment could not be read." })))).rejects.toThrow("BrainChain refused the paid request: The payment could not be read. Nothing was charged.");
  });

  it("reads the grade by its id when the paid reply is lost", async () => {
    const paid = await pay(desk(() => new TypeError("fetch failed"), [() => answer(404, {}), (id) => answer(200, { grade: id, state: "paid", status: "" }), (id) => answer(200, graded(id))]));
    expect(paid.verdict.state).toBe("graded");
  });

  it("says the grade may have been charged when the reply is lost and no grade turns up", async () => {
    const fetchImpl = desk(() => new TypeError("fetch failed"));
    const error = await pay(fetchImpl).catch((e: Error) => e);
    const id = (error as Error).message.match(/0x[0-9a-f]{64}/)![0];
    expect((error as Error).message).toBe(`BrainChain did not answer the paid request (fetch failed) and has no grade ${id}. The 0.25 USDC grade ${charged(id)}`);
    expect((error as Error).cause).toBeDefined();
  });

  it.each([
    [202, { state: "paid" }],
    [502, { state: "unconfirmed", error: "The payment may have gone through and is being checked." }],
    [409, { state: "paying" }],
    [503, {}],
  ])("waits for the grade after a %i", async (status, body) => {
    const paid = await pay(desk((id) => answer(status, { grade: id, ...body }), [(id) => answer(200, { grade: id, state: "unconfirmed", status: "" }), (id) => answer(200, graded(id))]));
    expect(paid.verdict).toEqual(graded(paid.id));
  });

  it.each([402, 403])("reads the grade after a %i to a signed payment, and waits for it if it exists", async (status) => {
    const paid = await pay(desk(() => answer(status, { error: "settlement failed" }), [(id) => answer(200, { grade: id, state: "paying" }), (id) => answer(200, graded(id))]));
    expect(paid.verdict.accepted).toBe(true);
  });

  it.each([402, 403])("says a %i to a signed payment may have charged it when no grade exists", async (status) => {
    const error = await pay(desk(() => answer(status, { error: "settlement failed" }))).catch((e: Error) => e);
    const id = (error as Error).message.match(/0x[0-9a-f]{64}/)![0];
    expect((error as Error).message).toBe(`BrainChain refused the payment: settlement failed. The 0.25 USDC grade ${charged(id)}`);
  });

  it("says nothing was charged when the facilitator finds the wallet short", async () => {
    await expect(pay(desk(() => answer(402, { error: "insufficient_funds" })))).rejects.toThrow("BrainChain refused the payment: the wallet's USDC on Base does not cover the 0.25 USDC grade. Nothing was charged.");
  });

  it("takes a failed grade as nothing charged", async () => {
    await expect(pay(desk((id) => answer(402, { grade: id, state: "failed" })))).rejects.toThrow("The payment did not go through. Nothing was charged.");
    await expect(pay(desk((id) => answer(202, { grade: id, state: "paid" }), [(id) => answer(200, { grade: id, state: "failed" })]))).rejects.toThrow("The payment did not go through. Nothing was charged.");
  });

  it("gives up after the wait it says, without saying nothing was charged", async () => {
    const reads = Array.from({ length: 5000 }, () => (id: string) => answer(200, { grade: id, state: "paid", status: "" }));
    const error = await payGrade(request, account, { desk: DESK, fetch: desk((id) => answer(202, { grade: id, state: "paid" }), reads) as unknown as typeof fetch, pollMs: 5, waitMs: 40 }).catch((e: Error) => e);
    expect((error as Error).message).toMatch(/^No verdict for grade 0x[0-9a-f]{64} after \d+ s; it may still come\. The 0\.25 USDC grade may have been charged/);
  });

  it("refuses a read that answers for another grade", async () => {
    const other = `0x${"1".repeat(64)}`;
    await expect(pay(desk((id) => answer(202, { grade: id, state: "paid" }), [() => answer(200, graded(other))]))).rejects.toThrow(`with grade ${other}, not`);
  });
});

describe("an offer", () => {
  it("is named once per price, with its currency and chain", () => {
    const accepts = [
      { network: "eip155:4663", asset: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", amount: "250000" },
      { network: "eip155:4663", asset: "0x5fc5360d0400a0fd4f2af552add042d716f1d168", amount: "250000" },
      { network: "eip155:8453", asset: GRADE_PAYMENT.asset, amount: "250000" },
      { network: "eip155:1", asset: "0x0000000000000000000000000000000000000001", amount: "7" },
    ];
    expect(describeOffers(accepts)).toBe("0.25 USDG on Robinhood Chain, 0.25 USDC on Base, 7 base units of 0x0000000000000000000000000000000000000001 on eip155:1");
  });
});

describe("the desk's URL", () => {
  it("is BrainChain's unless set, and an https origin or a local one when set", () => {
    expect(deskUrl(undefined)).toBe("https://brain.usebrainchain.com");
    expect(deskUrl("https://brain.usebrainchain.com/")).toBe("https://brain.usebrainchain.com");
    expect(deskUrl("http://localhost:8080")).toBe("http://localhost:8080");
    for (const bad of ["http://brain.usebrainchain.com", "https://brain.usebrainchain.com/x402", "https://user:pass@brain.test", "https://brain.test/?a=1", "brain.test"]) {
      expect(() => deskUrl(bad)).toThrow(/^BRAINCHAIN_DESK_URL /);
    }
  });
});
