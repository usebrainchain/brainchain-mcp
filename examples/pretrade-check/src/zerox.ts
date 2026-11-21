// Buys a signed quote from 0x's keyless gateway and checks it the moment it arrives.
import { createHash, createPublicKey, verify } from "node:crypto";

import { x402Client, x402HTTPClient } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  getAddress,
  http,
  parseAbi,
  zeroAddress,
  type Address,
  type PrivateKeyAccount,
  type PublicClient,
} from "viem";

import type { Registry } from "./request.ts";

/** Paid per request over x402, with no API key: 0.01 USDC on Base. */
export const GATEWAY = "https://agent.api.0x.org/v1/x402/swap-allowance-holder-quote/";

/** What 0x signs: the upstream request the gateway forwards, not the gateway's own URL. */
export const SIGNED_REQUEST = { method: "GET", authority: "api.0x.org", path: "/swap/allowance-holder/quote" } as const;

/** 0x's response signing key, from docs.0x.org/docs/developer-resources/response-signatures. It rotates; a quote signed with another key is refused. */
export const SIGNING_KEY = { id: "0x-signing-key-prod-24092026", x: "19P3C981JsyQsqwVho8Tlabx51rslvdruSH59mGuWn0" } as const;

/** The components a signature must cover, in this order, for it to bind the body and the request; the checks require the same. */
export const COVERED = ['"@status"', '"content-type"', '"content-digest"', '"@method";req', '"@authority";req', '"@path";req', '"@query";req'] as const;

export const ACCEPT_SIGNATURE = `sig=(${COVERED.join(" ")});keyid="${SIGNING_KEY.id}";tag="0x-swap-api"`;

/** 0x rejects a signature more than 60 seconds old, and so does this client, on its own clock, when the quote arrives. */
export const FRESH_SECONDS = 60;

/** Where 0x's gateway takes payment. Nothing else is paid from this client. */
export const ZEROX_PAYMENT = {
  network: "eip155:8453",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  payTo: "0xb15a55e85FdF5edc41B6c1eaf7813e2c6e6def59",
  maxUnits: 10_000n,
} as const;

/** AllowanceHolder, the contract every quote's transaction calls and the only spender an approval may name. */
export const ALLOWANCE_HOLDER = "0x0000000000001fF3684f28c67538d4D072C22734";
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

const QUERY = ["chainId", "sellToken", "buyToken", "sellAmount", "taker"];
const QUERY_OPTIONAL = ["slippageBps"];

/**
 * The query read as the checks read it: the names this client sends, each once, with values of letters and digits.
 * Nothing is percent-decoded, so 0x, this client and the checks all read the same values.
 */
export function parseQuery(query: string): { values: Record<string, string>; names: string[]; problems: string[] } {
  if (!query.startsWith("?")) return { values: {}, names: [], problems: ["it does not start with ?"] };
  const values: Record<string, string> = {};
  const names: string[] = [];
  const problems: string[] = [];
  for (const part of query.slice(1).split("&")) {
    const at = part.indexOf("=");
    const name = at < 0 ? part : part.slice(0, at);
    const value = at < 0 ? "" : part.slice(at + 1);
    names.push(name);
    if (at < 0 || !/^[A-Za-z]+$/.test(name) || !/^[A-Za-z0-9]+$/.test(value)) problems.push(`'${part}' is not a name=value pair of letters and digits`);
    else if (![...QUERY, ...QUERY_OPTIONAL].includes(name)) problems.push(`it asks for ${name}, which the checks do not allow`);
    else if (name in values) problems.push(`it names ${name} twice`);
    else values[name] = value;
  }
  problems.push(...QUERY.filter((name) => !(name in values)).map((name) => `it has no ${name}`));
  return { values, names, problems };
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
const messageOf = (error: unknown) => (error instanceof BaseError ? error.shortMessage : error instanceof Error ? error.message : String(error));

/** The payment 0x's gateway asks for, signed only as a transfer authorization of 0.01 USDC or less to 0x's payee on Base. */
export function zeroxPayer(account: PrivateKeyAccount): x402HTTPClient {
  return new x402HTTPClient(
    x402Client.fromConfig({
      schemes: [{ network: ZEROX_PAYMENT.network, client: new ExactEvmScheme(account) }],
      spendControls: { allowedAssets: [{ network: ZEROX_PAYMENT.network, asset: ZEROX_PAYMENT.asset, maxAmountPerPayment: ZEROX_PAYMENT.maxUnits.toString() }] },
      policies: [
        // EIP-3009 only: not Permit2, the gateway's batched wallet or its deposit scheme.
        (_version, accepts) =>
          accepts.filter(
            (a) => a.scheme === "exact" && a.network === ZEROX_PAYMENT.network && same(a.asset, ZEROX_PAYMENT.asset) && same(a.payTo, ZEROX_PAYMENT.payTo) && a.extra?.name === "USD Coin" && a.extra?.assetTransferMethod === undefined,
          ),
      ],
    }),
  );
}

/**
 * Why the facilitator refused a payment it never settled, from a 402's body: 0x's gateway puts the facilitator's
 * verification, with isValid false and its invalidReason, as JSON inside the error string.
 */
function unverified(body: string): string | undefined {
  const parse = (text: unknown): unknown => {
    if (typeof text !== "string") return text;
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  };
  const outer = parse(body) as { error?: unknown } | undefined;
  const inner = parse(outer?.error) as { isValid?: unknown; invalidReason?: unknown } | undefined;
  return inner?.isValid === false && typeof inner.invalidReason === "string" ? inner.invalidReason : undefined;
}

/**
 * Pays 0x for one signed quote. The gateway charges a request it refuses as well, so a refusal is thrown with
 * 0x's reason and is not retried here.
 */
export async function buyQuote(trade: Trade, payer: x402HTTPClient, options: { fetch?: typeof fetch; now?: () => number } = {}): Promise<SignedQuote> {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const query = quoteQuery(trade);
  const { problems } = parseQuery(query);
  if (problems.length > 0) throw new Error(`The quote request would not pass the checks: ${problems.join("; ")}.`);
  // The paid retry must ask for exactly the URL the 402 was for.
  const url = `${GATEWAY}${query}`;
  const headers = { accept: "application/json", "accept-signature": ACCEPT_SIGNATURE };
  const offer = await fetchImpl(url, { headers, signal: AbortSignal.timeout(30_000) }).catch((error: unknown) => {
    throw new Error(`0x's gateway did not answer: ${messageOf(error)}. Nothing was paid.`, { cause: error });
  });
  if (offer.status !== 402) throw new Error(`0x's gateway answered ${offer.status} before payment: ${(await offer.text()).slice(0, 300)}. Nothing was paid.`);
  let payment;
  try {
    const required = payer.getPaymentRequiredResponse((name) => offer.headers.get(name), await offer.json().catch(() => undefined));
    payment = await payer.createPaymentPayload(required);
  } catch (error) {
    throw new Error(`0x's gateway asks for a payment this client does not sign, at most 0.01 USDC on Base to ${ZEROX_PAYMENT.payTo}: ${messageOf(error)}. Nothing was paid.`, { cause: error });
  }
  const unsure = "The request fee of 0.01 USDC may have been charged; nothing was paid to BrainChain.";
  let response: Response;
  let bytes: Buffer;
  try {
    response = await fetchImpl(url, { headers: { ...headers, ...payer.encodePaymentSignatureHeader(payment) }, signal: AbortSignal.timeout(30_000) });
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    throw new Error(`0x's gateway did not answer the paid request: ${messageOf(error)}. ${unsure}`, { cause: error });
  }
  const receivedAt = Math.floor(now() / 1000);
  // A settle header that cannot be read only loses the fee's transaction, never a quote already paid for.
  let paymentTx: string | undefined;
  try {
    paymentTx = response.headers.get("payment-response") ? (payer.getPaymentSettleResponse((name) => response.headers.get(name)).transaction as string | undefined) : undefined;
  } catch {
    paymentTx = undefined;
  }
  const body = bytes.toString("utf8");
  if (!response.ok) {
    const refused = response.status === 402 ? unverified(body) : undefined;
    if (refused === "insufficient_funds") throw new Error(`0x's payment processor refused the payment: the wallet's USDC on Base does not cover the 0.01 USDC fee. Nothing was charged.`);
    if (refused) throw new Error(`0x's payment processor refused the payment (${refused}). Nothing was charged.`);
    const fee = paymentTx ? `The request fee of 0.01 USDC was paid in ${paymentTx}; nothing was paid to BrainChain.` : unsure;
    throw new Error(`0x refused the quote (${response.status}): ${body.slice(0, 300)}. ${fee}`);
  }
  const paid = `0x was paid 0.01 USDC for it${paymentTx ? ` in ${paymentTx}` : ""}; nothing was paid to BrainChain.`;
  // The digest is over these bytes; text that would not encode back to them could not be checked anywhere else.
  if (!Buffer.from(body, "utf8").equals(bytes)) throw new Error(`0x's response is not valid UTF-8, so it cannot be passed on unchanged. ${paid}`);
  const header = (name: string) => {
    const value = response.headers.get(name);
    if (!value) throw new Error(`0x's response has no ${name} header, so it is not signed. Nothing can vouch for it; do not trade on it. ${paid}`);
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

/**
 * Checks a quote as it arrives, as the checks will: signed by 0x's key over exactly these components, this body and
 * this request, and fresh by this client's clock. The sandbox checks the same signature again, but grades after the
 * minute has passed.
 */
export function checkQuote(quote: SignedQuote, now = quote.receivedAt): void {
  const { request, response } = quote;
  if (response.status !== 200) throw new Error(`0x answered ${response.status}, not a quote.`);
  if (request.method !== SIGNED_REQUEST.method || request.authority !== SIGNED_REQUEST.authority || request.path !== SIGNED_REQUEST.path) throw new Error("The quote does not answer 0x's quote endpoint.");
  const { problems } = parseQuery(request.query);
  if (problems.length > 0) throw new Error(`The quote's request would fail the checks: ${problems.join("; ")}.`);
  const input = /^sig=\(([^)]*)\)((?:;[a-z]+=(?:"[^"]*"|\d+))*)$/.exec(response.signatureInput);
  if (!input) throw new Error(`The Signature-Input header is not one signature labelled sig: ${response.signatureInput}`);
  if (input[1] !== COVERED.join(" ")) throw new Error(`0x's signature covers ${input[1]}, not exactly ${COVERED.join(" ")}.`);
  const params: Record<string, string | number> = {};
  for (const [, key, quoted, number] of input[2]!.matchAll(/;([a-z]+)=(?:"([^"]*)"|(\d+))/g)) params[key!] = quoted ?? Number(number);
  if (params.keyid !== SIGNING_KEY.id) throw new Error(`0x signed with key ${String(params.keyid)}, not ${SIGNING_KEY.id}. If 0x has rotated its key, update SIGNING_KEY from 0x's docs.`);
  if (params.tag !== "0x-swap-api") throw new Error(`The signature's tag is ${String(params.tag)}, not 0x-swap-api.`);
  const created = params.created;
  if (typeof created !== "number" || !Number.isSafeInteger(created)) throw new Error("The signature has no created time.");
  const digest = `sha-256=:${createHash("sha256").update(response.body, "utf8").digest("base64")}:`;
  if (!response.contentDigest.split(",").map((d) => d.trim()).includes(digest)) throw new Error("The body's SHA-256 does not match its Content-Digest header.");
  const values = [String(response.status), response.contentType, response.contentDigest, request.method, request.authority, request.path, request.query];
  const base = [...COVERED.map((c, i) => `${c}: ${values[i]}`), `"@signature-params": ${response.signatureInput.slice("sig=".length)}`].join("\n");
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: SIGNING_KEY.x }, format: "jwk" });
  const signature = /^sig=:([A-Za-z0-9+/]+={0,2}):$/.exec(response.signature)?.[1];
  if (!signature || signature.length % 4 !== 0 || !verify(null, Buffer.from(base), key, Buffer.from(signature, "base64"))) throw new Error("0x's signature does not verify over this response and request.");
  if (now - created > FRESH_SECONDS) throw new Error(`0x signed this quote ${now - created} seconds before it was checked, over the ${FRESH_SECONDS} seconds 0x allows. Ask for a new quote.`);
  // A little slack for a clock that runs behind 0x's.
  if (created - now > 5) throw new Error(`0x's signature is dated ${created - now} seconds ahead of this client's clock. Check the clock.`);
}

/**
 * A node for the chain, checked to be on it. The URL is never printed: a node's URL often carries its key.
 */
export async function connect(chainId: number, rpc = process.env.CHAIN_RPC): Promise<PublicClient> {
  const node = rpc || RPCS[chainId];
  const named = rpc ? "The node CHAIN_RPC names" : `The public node for chain ${chainId}`;
  if (!node) throw new Error(`No public node is known for chain ${chainId}. Set CHAIN_RPC to one, so 0x's Settler registry can be read there.`);
  const client = createPublicClient({ transport: http(node, { timeout: 20_000, retryCount: 1 }) });
  const answered = await client.getChainId().catch((error: unknown) => {
    throw new Error(`${named} does not answer: ${messageOf(error)}`, { cause: error });
  });
  if (answered !== chainId) throw new Error(`${named} is on chain ${answered}, not the mandate's chain ${chainId}.`);
  return client;
}

const REGISTRY_ABI = parseAbi(["function ownerOf(uint256) view returns (address)", "function prev(uint128) view returns (address)", "error NoInstance()"]);

/**
 * The Settlers 0x's registry names for taker-submitted trades, read at the block 0x quoted at, so anyone can
 * repeat the read from the record. A public node can run a second behind 0x's, so the read waits for it.
 */
export async function readSettlers(quote: SignedQuote, client: PublicClient): Promise<Registry> {
  const { blockNumber: quoted } = JSON.parse(quote.response.body) as { blockNumber?: unknown };
  if (typeof quoted !== "string" || !/^\d+$/.test(quoted)) throw new Error("0x's quote names no block.");
  const blockNumber = BigInt(quoted);
  try {
    for (let waited = 0; (await client.getBlockNumber({ cacheTime: 0 })) < blockNumber; waited += 500) {
      if (waited >= 15_000) throw new Error(`the node has not reached block ${blockNumber}, the quote's block, after 15 seconds`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const [settler, previous] = await Promise.all([
      client.readContract({ address: SETTLER_REGISTRY, abi: REGISTRY_ABI, functionName: "ownerOf", args: [2n], blockNumber }),
      client.readContract({ address: SETTLER_REGISTRY, abi: REGISTRY_ABI, functionName: "prev", args: [2n], blockNumber }).catch((error: unknown) => {
        // A chain that has had one Settler has no previous one, and the registry says so by reverting.
        const reverted = error instanceof BaseError ? error.walk((e) => e instanceof ContractFunctionRevertedError) : undefined;
        if (reverted instanceof ContractFunctionRevertedError && reverted.data?.errorName === "NoInstance") return zeroAddress;
        throw error;
      }),
    ]);
    if (same(settler, zeroAddress)) throw new Error(`the registry names no Settler at block ${blockNumber}`);
    return { block: Number(blockNumber), settler: getAddress(settler), previous: getAddress(previous) };
  } catch (error) {
    throw new Error(`0x's Settler registry could not be read: ${messageOf(error)}.`, { cause: error });
  }
}
