import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { GRADE_PAYMENT, payGrade, type Verdict } from "../src/desk.ts";
import { describeTrade, report, toSign, tradeOf } from "../src/main.ts";
import { parseMandate } from "../src/mandate.ts";
import { pretradeCheck, type Registry } from "../src/request.ts";
import type { SignedQuote } from "../src/zerox.ts";

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const MANDATE = parseMandate(read("../fixtures/mandate.json"));
const { trade, quote, registry } = read("../fixtures/quotes/inside.json") as { trade: string; quote: SignedQuote; registry: Registry };
const measured = read("../measured.json") as { runs: ({ case: string } & Verdict & { checks: Verdict["checks"] })[] };

describe("the trade from the command line", () => {
  it("is read in whole tokens of a token the mandate lists", () => {
    const t = tradeOf(MANDATE, MANDATE.wallet, { sell: "usdg", buy: "WETH", amount: "5", slippage: "50" });
    expect(t).toMatchObject({ chainId: 4663, sellAmount: 5_000_000n, slippageBps: 50, buyToken: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" });
    expect(describeTrade(MANDATE, t)).toBe("sell 5 USDG for WETH on Robinhood Chain");
  });

  it("takes any token to buy by its address, and leaves the verdict on it to the checks", () => {
    const t = tradeOf(MANDATE, MANDATE.wallet, { sell: "USDG", buy: "0x42b96dbc55e79e930d866c1ee486a342366546bc", amount: "5" });
    expect(describeTrade(MANDATE, t)).toBe("sell 5 USDG for 0x42b96dbc55e79E930d866c1eE486A342366546BC on Robinhood Chain");
  });

  it("refuses to sell a token the mandate does not list", () => {
    expect(() => tradeOf(MANDATE, MANDATE.wallet, { sell: "BRAIN", buy: "WETH", amount: "1" })).toThrow("--sell names a token the mandate lists: USDG, WETH, ETH.");
  });
});

describe("after the verdict", () => {
  it("gives the approval and the transaction 0x quoted, unchanged", () => {
    const body = JSON.parse(quote.response.body);
    expect(toSign(quote)).toEqual({
      approve: { token: body.sellToken, spender: "0x0000000000001ff3684f28c67538d4d072c22734", amount: "5000000" },
      transaction: { to: body.transaction.to, data: body.transaction.data, value: "0", gas: body.transaction.gas, gasPrice: body.transaction.gasPrice },
    });
  });

  it("names the rules a refused trade broke", () => {
    const refused = measured.runs.find((r) => r.case === "outside")!;
    const lines = report({ ...refused, status: "" });
    expect(lines[0]).toMatch(/^Refused: pass probability 0%, bar 80%/);
    expect(lines).toContain("FAIL  tokens: sells USDG; buys 0x42b96dbc55e79e930d866c1ee486a342366546bc, which the mandate does not list");
  });
});

describe("paying for the grade", () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const request = pretradeCheck({ quote, registry, mandate: MANDATE, trade });
  const offer = (accept: Record<string, unknown>) =>
    new Response("{}", { status: 402, headers: { "payment-required": Buffer.from(JSON.stringify({ x402Version: 2, resource: { url: "https://brain.test/" }, accepts: [accept] })).toString("base64") } });
  const base = { scheme: "exact", network: GRADE_PAYMENT.network, amount: "250000", asset: GRADE_PAYMENT.asset, payTo: GRADE_PAYMENT.payTo, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } };

  it("sends the request with its checks and reads the verdict from the paid reply", async () => {
    const verdict = { grade: "0x1", state: "graded", status: "s", accepted: true, passProbability: 0.9 };
    const fetchImpl = vi.fn().mockResolvedValueOnce(offer(base)).mockResolvedValueOnce(new Response(JSON.stringify(verdict), { status: 200 }));
    await expect(payGrade(request, account, { fetch: fetchImpl as typeof fetch })).resolves.toEqual(verdict);
    const sent = JSON.parse(fetchImpl.mock.calls[1]![1].body as string);
    expect(sent.checks).toEqual({ language: "python", code: request.checks.code });
    expect(sent.pass).toBe(0);
  });

  it("pays nobody but BrainChain, and no more than 0.25 USDC", async () => {
    for (const accept of [{ ...base, payTo: "0x000000000000000000000000000000000000dEaD" }, { ...base, amount: "250001" }, { ...base, extra: { assetTransferMethod: "permit2" } }]) {
      const fetchImpl = vi.fn().mockResolvedValueOnce(offer(accept));
      await expect(payGrade(request, account, { fetch: fetchImpl as typeof fetch })).rejects.toThrow("Nothing was paid.");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("passes on a request the route refuses before payment", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response('{"error":"result can be at most 100,000 bytes."}', { status: 400 }));
    await expect(payGrade(request, account, { fetch: fetchImpl as typeof fetch })).rejects.toThrow("BrainChain answered 400 before payment: result can be at most 100,000 bytes. Nothing was paid.");
  });
});
