import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { tamperRoute } from "../src/measure.ts";
import { ACCEPT_SIGNATURE, buyQuote, checkQuote, quoteQuery, zeroxPayer, type SignedQuote } from "../src/zerox.ts";

const recorded = (name: string): SignedQuote => JSON.parse(readFileSync(new URL(`../fixtures/quotes/${name}.json`, import.meta.url), "utf8")).quote;
const created = (quote: SignedQuote) => Number(/created=(\d+)/.exec(quote.response.signatureInput)![1]);

describe("a quote as it arrives", () => {
  it("asks 0x to sign the status, the body's digest and the whole request", () => {
    expect(ACCEPT_SIGNATURE).toBe('sig=("@status" "content-type" "content-digest" "@method";req "@authority";req "@path";req "@query";req);keyid="0x-signing-key-prod-24092026";tag="0x-swap-api"');
  });

  it("is checked against 0x's key over the upstream request", () => {
    const quote = recorded("inside");
    expect(() => checkQuote(quote)).not.toThrow();
    expect(quote.request).toMatchObject({ authority: "api.0x.org", path: "/swap/allowance-holder/quote" });
  });

  it("is refused once a minute has passed since 0x signed it", () => {
    const quote = recorded("inside");
    expect(() => checkQuote(quote, created(quote) + 61)).toThrow("0x signed this quote 61 seconds before it was checked, over the 60 seconds 0x allows. Ask for a new quote.");
  });

  it("is refused when its body or its request changed", () => {
    expect(() => checkQuote(recorded("tampered"))).toThrow("0x's signature does not verify over this response and request.");
    const quote = recorded("inside");
    expect(() => checkQuote({ ...quote, request: { ...quote.request, query: quote.request.query.replace("sellAmount=5000000", "sellAmount=50000000") } })).toThrow("0x's signature does not verify");
    expect(() => checkQuote({ ...quote, response: { ...quote.response, body: quote.response.body.replace("5000000", "5000001") } })).toThrow("The body's SHA-256 does not match its Content-Digest header.");
  });

  it("is refused when signed with another key", () => {
    const quote = recorded("inside");
    const signatureInput = quote.response.signatureInput.replace("0x-signing-key-prod-24092026", "0x-signing-key-prod-01012027");
    expect(() => checkQuote({ ...quote, response: { ...quote.response, signatureInput } })).toThrow("0x signed with key 0x-signing-key-prod-01012027, not 0x-signing-key-prod-24092026.");
  });

  it("puts the query in a fixed order, as the signature covers it", () => {
    const query = quoteQuery({ chainId: 4663, sellToken: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", buyToken: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", sellAmount: 5_000_000n, taker: "0xd937E50Ee21E66f7640F1a7887399e63055290fe", slippageBps: 50 });
    expect(query).toBe("?chainId=4663&sellToken=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168&buyToken=0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73&sellAmount=5000000&taker=0xd937E50Ee21E66f7640F1a7887399e63055290fe&slippageBps=50");
    expect(recorded("inside").request.query).toBe(query);
  });

  it("is tampered for the measurement in one place only, with a digest that still matches", () => {
    const quote = recorded("inside");
    const tampered = tamperRoute(quote);
    const before = JSON.parse(quote.response.body).transaction.data as string;
    const after = JSON.parse(tampered.response.body).transaction.data as string;
    expect([...before].filter((c, i) => c !== after[i])).toHaveLength(1);
    expect(tampered.response.body.length).toBe(quote.response.body.length);
  });
});

describe("paying 0x's gateway", () => {
  afterEach(() => vi.unstubAllGlobals());
  const account = privateKeyToAccount(generatePrivateKey());
  const trade = { chainId: 4663, sellToken: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", buyToken: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", sellAmount: 5_000_000n, taker: account.address } as const;
  const challenge = (accept: Record<string, unknown>) =>
    new Response("{}", {
      status: 402,
      headers: { "payment-required": Buffer.from(JSON.stringify({ x402Version: 2, resource: { url: "https://agent.api.0x.org/" }, accepts: [accept] })).toString("base64") },
    });
  const exact = { scheme: "exact", network: "eip155:8453", amount: "10000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0xb15a55e85FdF5edc41B6c1eaf7813e2c6e6def59", maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } };

  it("signs nothing for more than 0.01 USDC or for another payee", async () => {
    for (const accept of [{ ...exact, amount: "10001" }, { ...exact, payTo: "0x000000000000000000000000000000000000dEaD" }]) {
      const fetchImpl = vi.fn(async () => challenge(accept));
      await expect(buyQuote(trade, zeroxPayer(account), fetchImpl as typeof fetch)).rejects.toThrow();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("refuses a paid answer that carries no signature", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(challenge(exact)).mockResolvedValueOnce(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    await expect(buyQuote(trade, zeroxPayer(account), fetchImpl as typeof fetch)).rejects.toThrow("0x's response has no content-digest header, so it is not signed.");
    const [url, init] = fetchImpl.mock.calls[1]!;
    expect(url).toBe(`https://agent.api.0x.org/v1/x402/swap-allowance-holder-quote/${quoteQuery(trade)}`);
    expect(init.headers).toMatchObject({ "accept-signature": ACCEPT_SIGNATURE });
    expect(Object.keys(init.headers)).toContain("PAYMENT-SIGNATURE");
  });
});
