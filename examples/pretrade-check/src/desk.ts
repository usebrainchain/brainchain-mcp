// Pays BrainChain's grade route for one pre-trade check and reads the verdict, from the wallet that pays 0x.
import { setTimeout as sleep } from "node:timers/promises";

import { x402Client, x402HTTPClient } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { keccak256, toBytes, type PrivateKeyAccount } from "viem";

import type { GradeRequest } from "./request.ts";

export const DESK = process.env.BRAINCHAIN_DESK_URL ?? "https://brain.usebrainchain.com";

/** BrainChain's desk on Base: 0.25 USDC a grade, as a transfer authorization. Nothing else is paid from here. */
export const GRADE_PAYMENT = {
  network: "eip155:8453",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  payTo: "0x97D558417c3D61f1074422AD843e1Db1E565b952",
  maxUnits: 250_000n,
} as const;

/** The verdict as the grade route returns it to the request that carried the result. */
export interface Verdict {
  grade: string;
  state: string;
  status: string;
  accepted?: boolean;
  passProbability?: number;
  bar?: number;
  confidence?: number;
  checks?: { language: string; outcome: "passed" | "failed" | "timed out"; error?: string; output?: string };
  levels?: { level: string; probability: number; passes: boolean }[];
  second?: { model: string; passProbability: number };
  decision?: { id: string; record: string; page?: string };
  paymentTx?: string;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

/** BrainChain's id for a grade: the hash of the signed payment with its keys sorted, so a grade can be read again if the reply is lost. */
function gradeId(payload: unknown): string {
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

/** Asks the grade route for its price without paying: a 402 means it would take the request, a 400 says why not. */
export async function priceOf(request: GradeRequest, fetchImpl: typeof fetch = fetch): Promise<string> {
  const response = await fetchImpl(`${DESK}/x402/grades`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request), signal: AbortSignal.timeout(20_000) });
  const header = response.headers.get("payment-required");
  if (response.status !== 402 || !header) return `answered ${response.status}: ${(await response.text()).slice(0, 300)}`;
  const { accepts = [] } = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { accepts?: { network: string; amount: string }[] };
  return `takes the request, unpaid: ${accepts.map((a) => `${Number(a.amount) / 1e6} on ${a.network}`).join(", ")}`;
}

/**
 * Pays for one grade and waits for its verdict. BrainChain answers within 90 seconds or with a 202 and where to read
 * the grade; reading it is free. Only the paid reply carries what the checks printed.
 */
export async function payGrade(request: GradeRequest, account: PrivateKeyAccount, options: { fetch?: typeof fetch; log?: (line: string) => void } = {}): Promise<Verdict> {
  const fetchImpl = options.fetch ?? fetch;
  const log = options.log ?? (() => {});
  const url = `${DESK}/x402/grades`;
  const body = JSON.stringify(request);
  const headers = { "content-type": "application/json", accept: "application/json" };
  const offer = await fetchImpl(url, { method: "POST", headers, body, signal: AbortSignal.timeout(30_000) });
  if (offer.status !== 402) {
    const { error } = await json(offer);
    throw new Error(`BrainChain answered ${offer.status} before payment${typeof error === "string" ? `: ${sentence(error)}` : "."} Nothing was paid.`);
  }
  const payer = new x402HTTPClient(
    x402Client.fromConfig({
      schemes: [{ network: GRADE_PAYMENT.network, client: new ExactEvmScheme(account) }],
      spendControls: { allowedAssets: [{ network: GRADE_PAYMENT.network, asset: GRADE_PAYMENT.asset, maxAmountPerPayment: GRADE_PAYMENT.maxUnits.toString() }] },
    }),
  );
  const required = payer.getPaymentRequiredResponse((name) => offer.headers.get(name));
  const accept = required.accepts.find(
    (a) => a.scheme === "exact" && a.network === GRADE_PAYMENT.network && same(a.asset, GRADE_PAYMENT.asset) && same(a.payTo, GRADE_PAYMENT.payTo) && a.extra?.assetTransferMethod === undefined && BigInt(a.amount) <= GRADE_PAYMENT.maxUnits,
  );
  if (!accept) throw new Error(`BrainChain offers no grade for at most 0.25 USDC on Base to ${GRADE_PAYMENT.payTo}. Nothing was paid.`);
  const payment = await payer.createPaymentPayload({ ...required, accepts: [accept] });
  const id = gradeId(payment.payload);
  log(`grade ${id}: paying ${Number(accept.amount) / 1e6} USDC on Base`);
  const response = await fetchImpl(url, { method: "POST", headers: { ...headers, ...payer.encodePaymentSignatureHeader(payment) }, body, signal: AbortSignal.timeout(120_000) }).catch((error: Error) => error);
  if (!(response instanceof Response)) {
    log(`grade ${id}: no reply to the paid request (${response.message}); reading the grade instead`);
    return read(`${url}/${id}`, fetchImpl, log);
  }
  const reply = (await json(response)) as unknown as Verdict & { error?: string };
  if (response.status === 400 || response.status === 402 || response.status === 403) throw new Error(`BrainChain refused the payment: ${sentence(reply.error ?? String(response.status))} Nothing was charged.`);
  if (reply.state === "graded") return reply;
  if (reply.state === "failed") throw new Error(`The payment did not go through. Nothing was charged.`);
  return read(reply.status ?? `${url}/${id}`, fetchImpl, log);
}

async function read(status: string, fetchImpl: typeof fetch, log: (line: string) => void): Promise<Verdict> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await fetchImpl(status, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) }).catch(() => undefined);
    // A paid grade is graded until it is decided, so a 404 just after paying only means the payment is still settling.
    const view = response?.ok ? ((await json(response)) as unknown as Verdict) : undefined;
    if (view?.state === "graded") return view;
    if (view?.state === "failed") throw new Error("The payment did not go through. Nothing was charged.");
    log(`${status}: ${view?.state ?? `answered ${response?.status ?? "nothing"}`}, reading again in 10 s`);
    await sleep(10_000);
  }
  throw new Error(`No verdict after 10 minutes. Read it later at ${status}; reading is free.`);
}
