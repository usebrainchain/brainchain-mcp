// Buys a signed quote from 0x's keyless gateway and checks it the moment it arrives.
import { createHash, createPublicKey, verify } from "node:crypto";

import { x402Client, x402HTTPClient } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { createPublicClient, getAddress, http, parseAbi, type Address, type PrivateKeyAccount } from "viem";

/** Paid per request over x402, with no API key: 0.01 USDC on Base. */
export const GATEWAY = "https://agent.api.0x.org/v1/x402/swap-allowance-holder-quote/";

/** What 0x signs: the upstream request the gateway forwards, not the gateway's own URL. */
export const SIGNED_REQUEST = { method: "GET", authority: "api.0x.org", path: "/swap/allowance-holder/quote" } as const;

/** 0x's response signing key, from docs.0x.org/docs/developer-resources/response-signatures. It rotates; a quote signed with another key is refused. */
export const SIGNING_KEY = { id: "0x-signing-key-prod-24092026", x: "19P3C981JsyQsqwVho8Tlabx51rslvdruSH59mGuWn0" } as const;

/** The components a signature must cover for it to bind the body and the request. */
export const COVERED = ["@status", "content-type", "content-digest", "@method;req", "@authority;req", "@path;req", "@query;req"] as const;

export const ACCEPT_SIGNATURE = `sig=(${COVERED.map((c) => c.replace(/^([^;]+)/, '"$1"')).join(" ")});keyid="${SIGNING_KEY.id}";tag="0x-swap-api"`;

/** 0x rejects a signature more than 60 seconds old, and so does this client, on its own clock, when the quote arrives. */
export const FRESH_SECONDS = 60;

/** Where 0x's gateway takes payment. Nothing else is paid from this client. */
export const ZEROX_PAYMENT = {
  network: "eip155:8453",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  payTo: "0xb15a55e85FdF5edc41B6c1eaf7813e2c6e6def59",
  maxUnits: 10_000n,
} as const;

/** 0x's Settler registry, the same address on every chain: ownerOf(2) is the current Settler for taker-submitted trades, prev(2) the one before it. */
export const SETTLER_REGISTRY = "0x00000000000004533Fe15556B1E086BB1A72cEae";
/** Public nodes, used unless CHAIN_RPC names another. */
export const RPCS: Record<string, string> = { "4663": "https://rpc.mainnet.chain.robinhood.com", "8453": "https://mainnet.base.org" };

export interface Trade {
  chainId: number;
  sellToken: Address;
  buyToken: Address;
  /** In the sell token's base units. */
  sellAmount: bigint;
  taker: Address;
  /** 0x's slippage tolerance; the quote's minimum out follows from it. 0x's default is 100. */
  slippageBps?: number;
}

/** 0x's response as it arrived, with the request it answers: everything the signature covers. */
export interface SignedQuote {
  request: { method: "GET"; authority: string; path: string; query: string };
  response: { status: number; contentType: string; contentDigest: string; signatureInput: string; signature: string; body: string };
  /** Unix seconds on this client's clock when the response arrived. */
  receivedAt: number;
  /** 0x's settlement of the 0.01 USDC request fee, when the gateway reported it. */
  paymentTx?: string;
}

/** The query in the order it is sent; the signature covers it exactly as sent. */
export function quoteQuery(trade: Trade): string {
  const query = new URLSearchParams({
    chainId: String(trade.chainId),
    sellToken: trade.sellToken,
    buyToken: trade.buyToken,
    sellAmount: trade.sellAmount.toString(),
    taker: trade.taker,
  });
  if (trade.slippageBps !== undefined) query.set("slippageBps", String(trade.slippageBps));
  return `?${query}`;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The payment 0x's gateway asks for, signed only if it is 0.01 USDC or less to 0x's payee on Base. */
export function zeroxPayer(account: PrivateKeyAccount): x402HTTPClient {
  return new x402HTTPClient(
    x402Client.fromConfig({
      schemes: [{ network: ZEROX_PAYMENT.network, client: new ExactEvmScheme(account) }],
      spendControls: { allowedAssets: [{ network: ZEROX_PAYMENT.network, asset: ZEROX_PAYMENT.asset, maxAmountPerPayment: ZEROX_PAYMENT.maxUnits.toString() }] },
      policies: [
        // A plain transfer authorization: not the gateway's batched wallet or its deposit scheme.
        (_version, accepts) =>
          accepts.filter((a) => a.scheme === "exact" && a.network === ZEROX_PAYMENT.network && same(a.asset, ZEROX_PAYMENT.asset) && same(a.payTo, ZEROX_PAYMENT.payTo) && a.extra?.name === "USD Coin"),
      ],
    }),
  );
}

/**
 * Pays 0x for one signed quote. The gateway charges a request it refuses as well, so a refusal is thrown with
 * 0x's reason and is not retried here.
 */
export async function buyQuote(trade: Trade, payer: x402HTTPClient, fetchImpl: typeof fetch = fetch): Promise<SignedQuote> {
  const query = quoteQuery(trade);
  // The paid retry must ask for exactly the URL the 402 was for.
  const url = `${GATEWAY}${query}`;
  const headers = { accept: "application/json", "accept-signature": ACCEPT_SIGNATURE };
  const offer = await fetchImpl(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (offer.status !== 402) throw new Error(`0x's gateway answered ${offer.status} before payment: ${(await offer.text()).slice(0, 300)}. Nothing was paid.`);
  const required = payer.getPaymentRequiredResponse((name) => offer.headers.get(name), await offer.json().catch(() => undefined));
  const payment = await payer.createPaymentPayload(required);
  const response = await fetchImpl(url, { headers: { ...headers, ...payer.encodePaymentSignatureHeader(payment) }, signal: AbortSignal.timeout(30_000) });
  const bytes = Buffer.from(await response.arrayBuffer());
  const receivedAt = Math.floor(Date.now() / 1000);
  const settled = response.headers.get("payment-response");
  const paymentTx = settled ? (payer.getPaymentSettleResponse((name) => response.headers.get(name)).transaction as string | undefined) : undefined;
  const body = bytes.toString("utf8");
  if (!response.ok) throw new Error(`0x refused the quote (${response.status}): ${body.slice(0, 300)}. The request fee of 0.01 USDC was ${paymentTx ? `paid in ${paymentTx}` : "possibly charged"}.`);
  // The digest is over these bytes; text that would not encode back to them could not be checked anywhere else.
  if (!Buffer.from(body, "utf8").equals(bytes)) throw new Error("0x's response is not valid UTF-8, so it cannot be passed on unchanged.");
  const header = (name: string) => {
    const value = response.headers.get(name);
    if (!value) throw new Error(`0x's response has no ${name} header, so it is not signed. Nothing can vouch for it; do not trade on it.`);
    return value;
  };
  return {
    request: { ...SIGNED_REQUEST, query },
    response: {
      status: response.status,
      contentType: header("content-type"),
      contentDigest: header("content-digest"),
      signatureInput: header("signature-input"),
      signature: header("signature"),
      body,
    },
    receivedAt,
    ...(paymentTx ? { paymentTx } : {}),
  };
}

/** The signature base RFC 9421 defines for the components 0x covers, and the parameters it was made with. */
export function signatureBase(quote: SignedQuote): { base: string; params: Record<string, string | number>; components: string[] } {
  const input = quote.response.signatureInput;
  const match = /^sig=\(([^)]*)\)(.*)$/.exec(input);
  if (!match) throw new Error(`The Signature-Input header is not one signature labelled sig: ${input}`);
  const components = [...match[1]!.matchAll(/"([^"]+)"((?:;[a-z]+)*)/g)].map((m) => `${m[1]}${m[2]}`);
  const params: Record<string, string | number> = {};
  for (const [, key, quoted, number] of match[2]!.matchAll(/;([a-z]+)=(?:"([^"]*)"|(\d+))/g)) params[key!] = quoted ?? Number(number);
  const value: Record<string, string> = {
    "@status": String(quote.response.status),
    "content-type": quote.response.contentType,
    "content-digest": quote.response.contentDigest,
    "@method;req": quote.request.method,
    "@authority;req": quote.request.authority,
    "@path;req": quote.request.path,
    "@query;req": quote.request.query,
  };
  const lines = components.map((c) => {
    if (!(c in value)) throw new Error(`The signature covers ${c}, which this client does not know how to rebuild.`);
    const [name, ...flags] = c.split(";");
    return `"${name}"${flags.map((f) => `;${f}`).join("")}: ${value[c]}`;
  });
  return { base: [...lines, `"@signature-params": ${input.slice("sig=".length)}`].join("\n"), params, components };
}

/**
 * Checks a quote as it arrives: signed by 0x's key over this body and this request, and fresh by this client's
 * clock. The sandbox checks the same signature again, but not freshness: it grades after the minute has passed.
 */
export function checkQuote(quote: SignedQuote, now = quote.receivedAt): void {
  const { base, params, components } = signatureBase(quote);
  const missing = COVERED.filter((c) => !components.includes(c));
  if (missing.length > 0) throw new Error(`0x's signature does not cover ${missing.join(", ")}, so it does not bind the whole quote.`);
  if (params.keyid !== SIGNING_KEY.id) throw new Error(`0x signed with key ${String(params.keyid)}, not ${SIGNING_KEY.id}. If 0x has rotated its key, update SIGNING_KEY from 0x's docs.`);
  if (params.tag !== "0x-swap-api") throw new Error(`The signature's tag is ${String(params.tag)}, not 0x-swap-api.`);
  const digest = `sha-256=:${createHash("sha256").update(quote.response.body, "utf8").digest("base64")}:`;
  if (!quote.response.contentDigest.split(",").map((d) => d.trim()).includes(digest)) throw new Error("The body's SHA-256 does not match its Content-Digest header.");
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: SIGNING_KEY.x }, format: "jwk" });
  const signature = /^sig=:([A-Za-z0-9+/=]+):$/.exec(quote.response.signature)?.[1];
  if (!signature || !verify(null, Buffer.from(base), key, Buffer.from(signature, "base64"))) throw new Error("0x's signature does not verify over this response and request.");
  const created = Number(params.created);
  if (!Number.isInteger(created)) throw new Error("The signature has no created time.");
  if (now - created > FRESH_SECONDS) throw new Error(`0x signed this quote ${now - created} seconds before it was checked, over the ${FRESH_SECONDS} seconds 0x allows. Ask for a new quote.`);
  // A little slack for a clock that runs behind 0x's.
  if (created - now > 5) throw new Error(`0x's signature is dated ${created - now} seconds ahead of this client's clock. Check the clock.`);
}

/**
 * The Settlers 0x's registry names for taker-submitted trades, read at the block 0x quoted at, so anyone can
 * repeat the read from the record. A public node can run a second behind 0x's, so the read waits for it.
 */
export async function readSettlers(quote: SignedQuote, rpc = process.env.CHAIN_RPC): Promise<{ block: number; settler: Address; previous: Address }> {
  const { blockNumber: quoted } = JSON.parse(quote.response.body) as { blockNumber?: string };
  if (!quoted || !/^\d+$/.test(quoted)) throw new Error("0x's quote names no block.");
  const chain = new URLSearchParams(quote.request.query).get("chainId") ?? "";
  const node = rpc ?? RPCS[chain];
  if (!node) throw new Error(`Set CHAIN_RPC to a node for chain ${chain}, to read 0x's Settler registry there.`);
  const blockNumber = BigInt(quoted);
  const client = createPublicClient({ transport: http(node, { timeout: 20_000 }) });
  const abi = parseAbi(["function ownerOf(uint256) view returns (address)", "function prev(uint128) view returns (address)"]);
  for (let waited = 0; (await client.getBlockNumber()) < blockNumber; waited += 500) {
    if (waited >= 15_000) throw new Error(`The node has not reached block ${blockNumber}, the quote's block, after 15 seconds.`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const [settler, previous] = await Promise.all([
    client.readContract({ address: SETTLER_REGISTRY, abi, functionName: "ownerOf", args: [2n], blockNumber }),
    client.readContract({ address: SETTLER_REGISTRY, abi, functionName: "prev", args: [2n], blockNumber }),
  ]);
  return { block: Number(blockNumber), settler: getAddress(settler), previous: getAddress(previous) };
}
