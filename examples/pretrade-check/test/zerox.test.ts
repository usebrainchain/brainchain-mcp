import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it, vi } from "vitest";
import { createPublicClient, custom, encodeErrorResult, encodeFunctionResult, numberToHex, parseAbi, zeroAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { ACCEPT_SIGNATURE, buyQuote, checkQuote, connect, quoteQuery, readSettlers, zeroxPayer, type SignedQuote } from "../src/zerox.ts";

import { created, recorded, tamperRoute } from "./helpers.ts";

const quoteOf = (name: string): SignedQuote => recorded(name).quote;

describe("a quote as it arrives", () => {
  it("asks 0x to sign the status, the body's digest and the whole request", () => {
    expect(ACCEPT_SIGNATURE).toBe('sig=("@status" "content-type" "content-digest" "@method";req "@authority";req "@path";req "@query";req);keyid="0x-signing-key-prod-24092026";tag="0x-swap-api"');
  });

  it("is checked against 0x's key over the upstream request", () => {
    const quote = quoteOf("inside");
    expect(() => checkQuote(quote)).not.toThrow();
    expect(quote.request).toMatchObject({ authority: "api.0x.org", path: "/swap/allowance-holder/quote" });
  });

  it("is refused once a minute has passed since 0x signed it", () => {
    const quote = quoteOf("inside");
    expect(() => checkQuote(quote, created(quote) + 61)).toThrow("0x signed this quote 61 seconds before it was checked, over the 60 seconds 0x allows. Ask for a new quote.");
  });

  it("is refused when its body or its request changed", () => {
    expect(() => checkQuote(quoteOf("tampered"))).toThrow("0x's signature does not verify over this response and request.");
    expect(() => checkQuote(tamperRoute(quoteOf("inside")))).toThrow("0x's signature does not verify over this response and request.");
    const quote = quoteOf("inside");
    expect(() => checkQuote({ ...quote, request: { ...quote.request, query: quote.request.query.replace("sellAmount=5000000", "sellAmount=50000000") } })).toThrow("0x's signature does not verify");
    expect(() => checkQuote({ ...quote, response: { ...quote.response, body: quote.response.body.replace("5000000", "5000001") } })).toThrow("The body's SHA-256 does not match its Content-Digest header.");
  });

  it("is refused when signed with another key", () => {
    const quote = quoteOf("inside");
    const signatureInput = quote.response.signatureInput.replace("0x-signing-key-prod-24092026", "0x-signing-key-prod-01012027");
    expect(() => checkQuote({ ...quote, response: { ...quote.response, signatureInput } })).toThrow("0x signed with key 0x-signing-key-prod-01012027, not 0x-signing-key-prod-24092026.");
  });

  it("holds the covered components to exactly the checks' list, in order, and the status to 200", () => {
    const quote = quoteOf("inside");
    const reordered = quote.response.signatureInput.replace('"@status" "content-type"', '"content-type" "@status"');
    expect(() => checkQuote({ ...quote, response: { ...quote.response, signatureInput: reordered } })).toThrow(`0x's signature covers "content-type" "@status"`);
    const more = quote.response.signatureInput.replace('"@query";req', '"@query";req "@target-uri"');
    expect(() => checkQuote({ ...quote, response: { ...quote.response, signatureInput: more } })).toThrow("not exactly");
    expect(() => checkQuote({ ...quote, response: { ...quote.response, status: 201 } })).toThrow("0x answered 201, not a quote.");
  });

  it("is refused when its query would fail the checks", () => {
    const quote = quoteOf("inside");
    expect(() => checkQuote({ ...quote, request: { ...quote.request, query: `${quote.request.query}&recipient=0x1` } })).toThrow("The quote's request would fail the checks: it asks for recipient, which the checks do not allow.");
  });

  it("puts the query in a fixed order, as the signature covers it", () => {
    const query = quoteQuery({ chainId: 4663, sellToken: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", buyToken: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", sellAmount: 5_000_000n, taker: "0xd937E50Ee21E66f7640F1a7887399e63055290fe", slippageBps: 50 });
    expect(query).toBe("?chainId=4663&sellToken=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168&buyToken=0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73&sellAmount=5000000&taker=0xd937E50Ee21E66f7640F1a7887399e63055290fe&slippageBps=50");
    expect(quoteOf("inside").request.query).toBe(query);
  });
});

describe("paying 0x's gateway", () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const trade = { chainId: 4663, sellToken: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", buyToken: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", sellAmount: 5_000_000n, taker: account.address } as const;
  const challenge = (accept: Record<string, unknown>) =>
    new Response("{}", {
      status: 402,
      headers: { "payment-required": Buffer.from(JSON.stringify({ x402Version: 2, resource: { url: "https://agent.api.0x.org/" }, accepts: [accept] })).toString("base64") },
    });
  const exact = { scheme: "exact", network: "eip155:8453", amount: "10000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0xb15a55e85FdF5edc41B6c1eaf7813e2c6e6def59", maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } };
  const signed = (headers: Record<string, string> = {}) => {
    const { response } = quoteOf("inside");
    return new Response(response.body, {
      status: 200,
      headers: { "content-type": response.contentType, "content-digest": response.contentDigest, "signature-input": response.signatureInput, signature: response.signature, ...headers },
    });
  };

  it("signs nothing for more than 0.01 USDC, for another payee or through Permit2", async () => {
    for (const accept of [{ ...exact, amount: "10001" }, { ...exact, payTo: "0x000000000000000000000000000000000000dEaD" }, { ...exact, extra: { ...exact.extra, assetTransferMethod: "permit2" } }]) {
      const fetchImpl = vi.fn(async () => challenge(accept));
      await expect(buyQuote(trade, zeroxPayer(account), { fetch: fetchImpl as typeof fetch })).rejects.toThrow("Nothing was paid.");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("refuses a paid answer that carries no signature, saying what was paid", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(challenge(exact)).mockResolvedValueOnce(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    await expect(buyQuote(trade, zeroxPayer(account), { fetch: fetchImpl as typeof fetch })).rejects.toThrow(
      "0x's response has no content-digest header, so it is not signed. Nothing can vouch for it; do not trade on it. 0x was paid 0.01 USDC for it; nothing was paid to BrainChain.",
    );
    const [url, init] = fetchImpl.mock.calls[1]!;
    expect(url).toBe(`https://agent.api.0x.org/v1/x402/swap-allowance-holder-quote/${quoteQuery(trade)}`);
    expect(init.headers).toMatchObject({ "accept-signature": ACCEPT_SIGNATURE });
    expect(Object.keys(init.headers)).toContain("PAYMENT-SIGNATURE");
  });

  it("says the fee may have been charged when the paid request gets no answer", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(challenge(exact)).mockRejectedValueOnce(new TypeError("fetch failed"));
    const error = await buyQuote(trade, zeroxPayer(account), { fetch: fetchImpl as typeof fetch }).catch((e: Error) => e);
    expect(error).toMatchObject({ message: "0x's gateway did not answer the paid request: fetch failed. The request fee of 0.01 USDC may have been charged; nothing was paid to BrainChain." });
    expect((error as Error).cause).toBeInstanceOf(TypeError);
  });

  it("keeps a paid quote whose settle header cannot be read", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(challenge(exact)).mockResolvedValueOnce(signed({ "payment-response": "not base64 json" }));
    const quote = await buyQuote(trade, zeroxPayer(account), { fetch: fetchImpl as typeof fetch, now: () => 1_795_225_000_000 });
    expect(quote.response.body).toBe(quoteOf("inside").response.body);
    expect(quote.paymentTx).toBeUndefined();
    expect(quote.receivedAt).toBe(1_795_225_000);
  });

  it("says nothing was charged when 0x's facilitator finds the wallet short, without its JSON", async () => {
    const body = JSON.stringify({ error: `${JSON.stringify({ invalidMessage: "contract call failed", invalidReason: "insufficient_funds", isValid: false, payer: account.address })}\n` });
    const fetchImpl = vi.fn().mockResolvedValueOnce(challenge(exact)).mockResolvedValueOnce(new Response(body, { status: 402, headers: { "content-type": "application/json" } }));
    const error = await buyQuote(trade, zeroxPayer(account), { fetch: fetchImpl as typeof fetch }).catch((e: Error) => e);
    expect((error as Error).message).toBe("0x's payment processor refused the payment: the wallet's USDC on Base does not cover the 0.01 USDC fee. Nothing was charged.");
  });

  it("passes on 0x's refusal of a paid request with the fee's transaction", async () => {
    const settle = Buffer.from(JSON.stringify({ success: true, transaction: "0xabc", network: "eip155:8453" })).toString("base64");
    const fetchImpl = vi.fn().mockResolvedValueOnce(challenge(exact)).mockResolvedValueOnce(new Response('{"name":"INPUT_INVALID"}', { status: 400, headers: { "payment-response": settle } }));
    await expect(buyQuote(trade, zeroxPayer(account), { fetch: fetchImpl as typeof fetch })).rejects.toThrow('0x refused the quote (400): {"name":"INPUT_INVALID"}. The request fee of 0.01 USDC was paid in 0xabc; nothing was paid to BrainChain.');
  });
});

describe("0x's Settler registry", () => {
  const abi = parseAbi(["function ownerOf(uint256) view returns (address)", "function prev(uint128) view returns (address)", "error NoInstance()"]);
  const SETTLER = "0xE8852602f84e04e284286d8Db01a41Edd0CCEFb0";
  const node = (prev: Hex | "revert") =>
    createPublicClient({
      transport: custom({
        async request({ method, params }: { method: string; params: unknown[] }) {
          if (method === "eth_blockNumber") return numberToHex(119_510_700n);
          if (method !== "eth_call") throw new Error(method);
          const { data } = params[0] as { data: Hex };
          if (data.startsWith("0x6352211e")) return encodeFunctionResult({ abi, functionName: "ownerOf", result: SETTLER });
          if (prev === "revert") throw Object.assign(new Error("execution reverted"), { code: 3, data: encodeErrorResult({ abi, errorName: "NoInstance" }) });
          return encodeFunctionResult({ abi, functionName: "prev", result: prev });
        },
      }),
    });

  it("is read at the quote's block", async () => {
    await expect(readSettlers(quoteOf("inside"), node("0x24A4d86c8A76B00EE9566eD9C9Ff4f0c3Faf0da7"))).resolves.toEqual({ block: 119510614, settler: SETTLER, previous: "0x24A4d86c8A76B00EE9566eD9C9Ff4f0c3Faf0da7" });
  });

  it("reads a chain with one Settler as having no previous one", async () => {
    await expect(readSettlers(quoteOf("inside"), node("revert"))).resolves.toMatchObject({ settler: SETTLER, previous: zeroAddress });
  });

  it("is read only from a node that answers on the mandate's chain, without printing its URL", async () => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => res.end(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(body).id, result: "0x2105" })));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/secret-key`;
    try {
      await expect(connect(8453, url)).resolves.toBeDefined();
      const error = await connect(4663, url).catch((e: Error) => e);
      expect((error as Error).message).toBe("The node CHAIN_RPC names is on chain 8453, not the mandate's chain 4663.");
      await expect(connect(1, "")).rejects.toThrow("No public node is known for chain 1. Set CHAIN_RPC to one");
    } finally {
      server.close();
    }
  });
});
