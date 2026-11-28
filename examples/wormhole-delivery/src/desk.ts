// Pays BrainChain's grade route for one delivery and reads the verdict.
import { setTimeout as sleep } from "node:timers/promises";

import { x402Client, x402HTTPClient } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { keccak256, toBytes, type PrivateKeyAccount } from "viem";

import type { GradeRequest } from "./gate.ts";
import { messageOf, same, USDC_BASE } from "./shared.ts";

export const DEFAULT_DESK = "https://brain.usebrainchain.com";

/** BrainChain's desk on Base: 0.25 USDC a grade, as a transfer authorization. Nothing else is paid from here. */
export const GRADE_PAYMENT = {
  network: "eip155:8453",
  asset: USDC_BASE,
  payTo: "0x97D558417c3D61f1074422AD843e1Db1E565b952",
  maxUnits: 250_000n,
} as const;

/** The verdict as the grade route returns it. */
export interface Verdict {
  grade: string;
  state: string;
  status: string;
  accepted?: boolean;
  passProbability?: number;
  bar?: number;
  confidence?: number;
  levels?: { level: string; probability: number; passes: boolean }[];
  second?: { model: string; passProbability: number };
  decision?: { id: string; record: string; page?: string };
  paymentTx?: string;
}

/** A paid grade: the id and status URL this client computed from its own payment, and the verdict read for it. */
export interface Paid {
  id: string;
  status: string;
  verdict: Verdict;
}

/**
 * The desk to pay and read: BrainChain's own unless BRAINCHAIN_DESK_URL names another, which must be https (or http on
 * this machine, for a local desk) and take payment at the same address on Base, since nothing else is paid.
 */
export function deskUrl(value = process.env.BRAINCHAIN_DESK_URL): string {
  if (!value) return DEFAULT_DESK;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("BRAINCHAIN_DESK_URL is not a URL.");
  }
  const local = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if ((url.protocol !== "https:" && !local) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("BRAINCHAIN_DESK_URL must be an https origin, such as https://brain.usebrainchain.com, or http on localhost or 127.0.0.1.");
  }
  return url.origin;
}

const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

/** BrainChain's id for a grade: the hash of the signed payment with its keys sorted, so a grade can be read again if the reply is lost. */
export function gradeId(payload: unknown): string {
  const canonical = (value: unknown): string => {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    const source = value as Record<string, unknown>;
    const keys = Object.keys(source).filter((key) => source[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(source[key])}`).join(",")}}`;
  };
  return keccak256(toBytes(canonical(payload)));
}

async function json(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json().catch(() => undefined);
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The currencies BrainChain takes, by chain and token address, to name its offers. */
const CURRENCIES: Record<string, { name: string; symbol: string; decimals: number }> = {
  [`eip155:8453/${USDC_BASE.toLowerCase()}`]: { name: "Base", symbol: "USDC", decimals: 6 },
  "eip155:4663/0x5fc5360d0400a0fd4f2af552add042d716f1d168": { name: "Robinhood Chain", symbol: "USDG", decimals: 6 },
};

/** An x402 offer list in words, each price once: "0.25 USDC on Base, 0.25 USDG on Robinhood Chain". */
export function describeOffers(accepts: { network: string; asset: string; amount: string }[]): string {
  const named = accepts.map(({ network, asset, amount }) => {
    const currency = CURRENCIES[`${network}/${asset.toLowerCase()}`];
    return currency ? `${Number(amount) / 10 ** currency.decimals} ${currency.symbol} on ${currency.name}` : `${amount} base units of ${asset} on ${network}`;
  });
  return [...new Set(named)].join(", ");
}

/** Asks the grade route for its price without paying: a 402 means it would take the request, a 400 says why not. */
export async function priceOf(request: GradeRequest, options: { desk?: string; fetch?: typeof fetch } = {}): Promise<{ takes: true; text: string } | { takes: false; text: string }> {
  const fetchImpl = options.fetch ?? fetch;
  const response = await fetchImpl(`${options.desk ?? DEFAULT_DESK}/x402/grades`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request), signal: AbortSignal.timeout(20_000) });
  const header = response.headers.get("payment-required");
  if (response.status !== 402 || !header) return { takes: false, text: `BrainChain's grade route answered ${response.status}: ${(await response.text()).slice(0, 300)}` };
  const { accepts = [] } = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { accepts?: { network: string; asset: string; amount: string }[] };
  return { takes: true, text: `BrainChain would grade this request for ${describeOffers(accepts)}` };
}

/** A grade BrainChain cannot find, which is no proof that nothing was charged. */
class Missing extends Error {}

interface Options {
  desk?: string;
  fetch?: typeof fetch;
  log?: (line: string) => void;
  /** How long to wait for a verdict, and between reads of it. */
  waitMs?: number;
  pollMs?: number;
}

/**
 * Pays for one grade and waits for its verdict. BrainChain answers within 90 seconds or with a 202 and where to read
 * the grade; reading it is free. Once the payment is signed, every error says what may have been charged.
 */
export async function payGrade(request: GradeRequest, account: PrivateKeyAccount, options: Options = {}): Promise<Paid> {
  const fetchImpl = options.fetch ?? fetch;
  const log = options.log ?? (() => {});
  const desk = options.desk ?? DEFAULT_DESK;
  const url = `${desk}/x402/grades`;
  const body = JSON.stringify(request);
  const headers = { "content-type": "application/json", accept: "application/json" };
  const offer = await fetchImpl(url, { method: "POST", headers, body, signal: AbortSignal.timeout(30_000) }).catch((error: unknown) => {
    throw new Error(`BrainChain did not answer: ${messageOf(error)}. Nothing was paid to BrainChain.`, { cause: error });
  });
  if (offer.status !== 402) {
    const { error } = await json(offer);
    throw new Error(`BrainChain answered ${offer.status} before payment${typeof error === "string" ? `: ${sentence(error)}` : "."} Nothing was paid to BrainChain.`);
  }
  const payer = new x402HTTPClient(
    x402Client.fromConfig({
      schemes: [{ network: GRADE_PAYMENT.network, client: new ExactEvmScheme(account) }],
      spendControls: { allowedAssets: [{ network: GRADE_PAYMENT.network, asset: GRADE_PAYMENT.asset, maxAmountPerPayment: GRADE_PAYMENT.maxUnits.toString() }] },
    }),
  );
  let payment;
  let price = 0;
  try {
    const required = payer.getPaymentRequiredResponse((name) => offer.headers.get(name));
    // EIP-3009 only: an offer with an asset transfer method, Permit2 among them, is not signed.
    const accept = required.accepts.find(
      (a) => a.scheme === "exact" && a.network === GRADE_PAYMENT.network && same(a.asset, GRADE_PAYMENT.asset) && same(a.payTo, GRADE_PAYMENT.payTo) && a.extra?.assetTransferMethod === undefined && BigInt(a.amount) <= GRADE_PAYMENT.maxUnits,
    );
    if (!accept) throw new Error("no offer matches");
    payment = await payer.createPaymentPayload({ ...required, accepts: [accept] });
    price = Number(accept.amount) / 1e6;
  } catch (error) {
    throw new Error(`Not signing BrainChain's offer: this client pays at most 0.25 USDC on Base to ${GRADE_PAYMENT.payTo}, by transfer authorization (${messageOf(error)}). Nothing was paid to BrainChain.`, { cause: error });
  }
  const id = gradeId(payment.payload);
  const status = `${url}/${id}`;
  const charged = (why: string, cause?: unknown) =>
    new Error(`${sentence(why)} The ${price} USDC grade may have been charged. Read ${status} (free) first; running this again pays again.`, cause === undefined ? undefined : { cause });
  /** Reads the grade by its id until it is decided. If BrainChain cannot find it `missing` reads in a row, the error is `absent`'s. */
  const wait = async (missing: number, absent: (cause: Missing) => Error): Promise<Paid> => {
    try {
      return { id, status, verdict: await waitFor(id, status, { fetch: fetchImpl, log, charged, missing, waitMs: options.waitMs ?? 600_000, pollMs: options.pollMs ?? 10_000 }) };
    } catch (error) {
      throw error instanceof Missing ? absent(error) : error;
    }
  };

  log(`Paying ${price} USDC on Base for grade ${id}.`);
  const response = await fetchImpl(url, { method: "POST", headers: { ...headers, ...payer.encodePaymentSignatureHeader(payment) }, body, signal: AbortSignal.timeout(120_000) }).catch((error: Error) => error);
  if (!(response instanceof Response)) {
    log(`No reply to the paid request (${response.message}). Reading grade ${id} instead.`);
    // The request may still be on its way, so a grade BrainChain cannot find yet is read a few more times.
    return wait(3, (cause) => charged(`BrainChain did not answer the paid request (${response.message}) and has no grade ${id}`, cause));
  }
  const reply = (await json(response)) as unknown as Verdict & { error?: string };
  const refusal = typeof reply.error === "string" ? reply.error : `answered ${response.status}`;
  // A 400 is the only answer given before anything settles.
  if (response.status === 400) throw new Error(`BrainChain refused the paid request: ${sentence(refusal)} Nothing was charged.`);
  if (response.ok && reply.state === "graded") return { id, status, verdict: reply };
  if (reply.state === "failed") throw new Error("The payment did not go through. Nothing was charged.");
  log(`BrainChain answered ${response.status}${reply.state ? ` (${reply.state})` : ""}. Reading grade ${id}.`);
  // A 402 or 403 after a signed payment can still follow a saved payment: a grade by this id is the answer, and its absence is not proof of no charge.
  if (response.status === 402 || response.status === 403) {
    return wait(0, (cause) =>
      // A payment the facilitator would not verify because the wallet is short is never settled.
      refusal === "insufficient_funds"
        ? new Error(`BrainChain refused the payment: the wallet's USDC on Base does not cover the ${price} USDC grade. Nothing was charged.`, { cause })
        : charged(`BrainChain refused the payment: ${refusal}`, cause),
    );
  }
  return wait(3, (cause) => charged(`BrainChain answered ${response.status} and has no grade ${id}`, cause));
}

/** Reads a grade until it is decided. A grade it cannot find more than `missing` times in a row is thrown as Missing. */
async function waitFor(
  id: string,
  status: string,
  options: { fetch: typeof fetch; log: (line: string) => void; charged: (why: string, cause?: unknown) => Error; missing: number; waitMs: number; pollMs: number },
): Promise<Verdict> {
  const started = Date.now();
  let absent = 0;
  for (;;) {
    const response = await options.fetch(status, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) }).catch(() => undefined);
    const view = response?.ok ? ((await json(response)) as unknown as Verdict) : undefined;
    if (view && view.grade !== id) throw options.charged(`BrainChain answered ${status} with grade ${String(view.grade)}, not ${id}`);
    if (view?.state === "graded") return view;
    if (view?.state === "failed") throw new Error("The payment did not go through. Nothing was charged.");
    absent = response?.status === 404 ? absent + 1 : 0;
    if (absent > options.missing) throw new Missing(`BrainChain has no grade ${id}`);
    const waited = Date.now() - started;
    if (waited + options.pollMs > options.waitMs) throw options.charged(`No verdict for grade ${id} after ${Math.round(waited / 1000)} s; it may still come`);
    const state = view?.state ?? (response ? `answered ${response.status}` : "not answering");
    options.log(`Grade ${id} is ${state}, ${Math.round(waited / 1000)} s after paying. Reading it again in ${options.pollMs / 1000} s.`);
    await sleep(options.pollMs);
  }
}
