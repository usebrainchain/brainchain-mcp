import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { ExactEvmScheme } from "@x402/evm/exact/client";
import { x402Client, x402HTTPClient } from "@x402/fetch";
import { formatUnits, keccak256, toBytes, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { createSpend } from "./spend.ts";

/** The body of BrainChain's grade route, as docs.usebrainchain.com/other-networks describes it. */
export interface GradeRequest {
  title?: string;
  brief: string;
  /** Quality levels, best first. */
  levels: string[];
  /** The index of the lowest level that passes. */
  pass: number;
  result: string;
  checks?: { language: "python" | "javascript"; code: string };
}

/** A grade BrainChain took payment for, and where to read it. */
export interface Paid {
  grade: string;
  status: string;
  units: string;
}

export interface Verdict {
  grade: string;
  accepted: boolean;
  passProbability: number;
  bar: number;
  /** `error` and `output` come only in the reply to the paid request, and can quote the delivery. */
  checks?: { outcome: "passed" | "failed" | "timed out"; error?: string; output?: string };
  /** The public decision page. */
  decision: string;
  paymentTx?: string;
}

export interface JudgeConfig {
  url: string;
  /** Pays at /x402/grades/for/<partner>, at the price BrainChain set for that partner's wallets. */
  partner?: string;
  /** BrainChain's address. The judge pays nobody else. */
  payTo: Address;
  network: `eip155:${number}`;
  asset: Address;
  token: string;
  maxUnits: bigint;
  dailyUnits: bigint;
  /** Where the day's spending is kept. */
  dir: string;
  /** The seller's wallet key. Without one the judge prints each request and pays nothing. */
  key?: Hex;
}

export interface Judge {
  url: string;
  /** Pays for a grade and waits for the verdict. Undefined when the judge has no key and only printed the request. */
  grade(request: GradeRequest, paid: (grade: Paid) => Promise<void>): Promise<Verdict | undefined>;
  /** Waits for the verdict of a grade already paid for. Reading it is free. */
  read(grade: Paid): Promise<Verdict>;
}

const JSON_HEADERS = { "content-type": "application/json", accept: "application/json" };
/** BrainChain waits 90 seconds for a verdict before it answers 202. */
const PAID_TIMEOUT_MS = 120_000;
const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

/** BrainChain's id for a grade: the hash of the signed payment with its keys sorted. */
function gradeId(payload: unknown): Hex {
  const canonical = (value: unknown): string => {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    const source = value as Record<string, unknown>;
    const keys = Object.keys(source).filter((key) => source[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(source[key])}`).join(",")}}`;
  };
  return keccak256(toBytes(canonical(payload)));
}

async function body(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json().catch(() => undefined);
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function verdictOf(view: Record<string, unknown>): Verdict {
  const { grade, accepted, passProbability, bar, checks, decision, paymentTx } = view as {
    grade: string;
    accepted?: unknown;
    passProbability?: unknown;
    bar: number;
    checks?: Verdict["checks"];
    decision?: { page?: string; record?: string };
    paymentTx?: string;
  };
  const page = decision?.page ?? decision?.record;
  if (typeof accepted !== "boolean" || typeof passProbability !== "number" || !page) throw new Error(`BrainChain's verdict on grade ${grade} could not be read.`);
  return {
    grade,
    accepted,
    passProbability,
    bar,
    ...(checks ? { checks: { outcome: checks.outcome, ...(checks.error ? { error: checks.error } : {}), ...(checks.output ? { output: checks.output } : {}) } } : {}),
    decision: page,
    ...(paymentTx ? { paymentTx } : {}),
  };
}

export function createJudge(config: JudgeConfig, options: { fetch?: typeof fetch; pollMs?: number; log?: (line: string) => void } = {}): Judge {
  const fetchImpl = options.fetch ?? fetch;
  const pollMs = options.pollMs ?? 10_000;
  const log = options.log ?? console.log;
  const url = config.partner ? `${config.url}/x402/grades/for/${config.partner}` : `${config.url}/x402/grades`;
  const spend = createSpend(join(config.dir, "spend.json"), config.dailyUnits);
  // USDC and USDG, and their test versions, all have 6 decimals.
  const price = (units: bigint) => `${formatUnits(units, 6)} ${config.token}`;
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const payer =
    config.key &&
    new x402HTTPClient(
      x402Client.fromConfig({
        schemes: [{ network: config.network, client: new ExactEvmScheme(privateKeyToAccount(config.key)) }],
        spendControls: { allowedAssets: [{ network: config.network, asset: config.asset, maxAmountPerPayment: config.maxUnits.toString() }] },
      }),
    );

  // BrainChain settles a payment header once and answers it again from its grade, so a paid request that got no
  // answer is sent again as it was.
  async function send(init: RequestInit): Promise<Response> {
    for (let tries = 1; ; tries++) {
      const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(PAID_TIMEOUT_MS) }).catch((error: Error) => error);
      if (response instanceof Response) return response;
      if (tries === 3) throw new Error(`BrainChain did not answer the paid request (${response.message}). The payment may have gone through.`);
      await sleep(pollMs);
    }
  }

  async function grade(request: GradeRequest, paid: (grade: Paid) => Promise<void>): Promise<Verdict | undefined> {
    if (!payer) {
      log(`dry run, nothing paid: POST ${url}\n${JSON.stringify(request, null, 2)}`);
      return undefined;
    }
    const text = JSON.stringify(request);
    const offer = await fetchImpl(url, { method: "POST", headers: JSON_HEADERS, body: text, signal: AbortSignal.timeout(30_000) });
    if (offer.status !== 402) {
      const { error } = await body(offer);
      throw new Error(`BrainChain answered ${offer.status} before payment${typeof error === "string" ? `: ${sentence(error)}` : "."} Nothing was paid.`);
    }
    const required = payer.getPaymentRequiredResponse((name) => offer.headers.get(name));
    // A transfer authorization is a signature: no approval transaction, and nothing moves until BrainChain settles it.
    const accept = required.accepts.find(
      (a) =>
        a.scheme === "exact" &&
        a.network === config.network &&
        same(a.asset, config.asset) &&
        same(a.payTo, config.payTo) &&
        a.extra?.assetTransferMethod === undefined &&
        typeof a.extra?.name === "string" &&
        a.maxTimeoutSeconds <= 600,
    );
    if (!accept) throw new Error(`BrainChain offers no ${config.token} transfer authorization to ${config.payTo} on ${config.network}. Nothing was paid.`);
    const units = BigInt(accept.amount);
    if (units > config.maxUnits) throw new Error(`A grade costs ${price(units)}, above the per-grade cap of ${price(config.maxUnits)}. Nothing was paid.`);
    const today = await spend.take(units);
    if (today !== undefined) throw new Error(`Grades cost ${price(today)} today, and ${price(units)} more would pass the daily cap of ${price(config.dailyUnits)}. Nothing was paid.`);
    const payment = await payer.createPaymentPayload({ ...required, accepts: [accept] }).catch(async (error: unknown) => {
      await spend.give(units);
      throw error;
    });

    const response = await send({ method: "POST", headers: { ...JSON_HEADERS, ...payer.encodePaymentSignatureHeader(payment) }, body: text });
    const reply = await body(response);
    const reason = sentence(typeof reply.error === "string" ? reply.error : typeof reply.reason === "string" ? reply.reason : `no reason given (${response.status})`);
    if (typeof reply.grade === "string" && typeof reply.status === "string") {
      // The same request from the same wallet is answered from the first grade, and this payment is never settled.
      const charged = same(reply.grade, gradeId(payment.payload)) && reply.state !== "failed";
      if (!charged) await spend.give(units);
      if (reply.state === "failed") throw new Error(`The payment did not go through: ${reason} Nothing was charged.`);
      const taken = { grade: reply.grade, status: reply.status, units: charged ? units.toString() : "0" };
      await paid(taken);
      return response.ok && reply.state === "graded" ? verdictOf(reply) : read(taken);
    }
    // 400 is a request BrainChain refused before settling, 402 a refused payment, 403 a wallet that is not the partner's.
    if (response.status === 400 || response.status === 402 || response.status === 403) {
      await spend.give(units);
      throw new Error(`BrainChain refused the payment: ${reason} Nothing was charged.`);
    }
    throw new Error(`BrainChain answered ${response.status} to the paid request: ${reason} The payment may have gone through.`);
  }

  async function read(taken: Paid): Promise<Verdict> {
    for (;;) {
      // A read that fails is tried again: BrainChain keeps grading a paid request until it decides.
      const response = await fetchImpl(taken.status, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) }).catch(() => undefined);
      if (response?.status === 404) throw new Error(`BrainChain has no grade ${taken.grade}.`);
      const view = response?.ok ? await body(response) : {};
      if (view.state === "graded") return verdictOf(view);
      if (view.state === "failed") {
        await spend.give(BigInt(taken.units));
        throw new Error(`The payment for grade ${taken.grade} did not go through${typeof view.reason === "string" ? `: ${view.reason}` : "."} Nothing was charged.`);
      }
      await sleep(pollMs);
    }
  }

  return { url, grade, read };
}
