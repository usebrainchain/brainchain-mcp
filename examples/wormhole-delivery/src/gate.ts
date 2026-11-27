// Agent Wormhole checks that a paid response is the resource that was quoted. BrainChain grades whether it is the work
// that was asked for. The agent uses the delivery, or releases what it holds for it, only when both pass.
import { createHash } from "node:crypto";

import { keccak256 } from "viem";
import { deliveryMatches, inspectDelivery, type DeliveryQuote, type DeliveryReceipt } from "wormhole-x402/delivery";

import type { Verdict } from "./desk.ts";

/** BrainChain's cap on a delivered result sent for a grade. */
export const MAX_RESULT_BYTES = 100_000;
/** BrainChain's stand-in for the result of work it has not accepted. */
const WITHHELD = "[withheld until the work is accepted]";

/** A paid response, in the shape Wormhole's verify_delivery tool takes. */
export interface Delivery {
  quote: DeliveryQuote;
  response: { status: number; contentType?: string; bodyText?: string; bodyBase64?: string };
  /** The request_digest of Wormhole's verify receipt for the same purchase, which the delivery receipt then carries. */
  request_digest?: string;
}

/** What the delivery had to be. BrainChain reads nothing else about the job. */
export interface Order {
  title?: string;
  brief: string;
  levels?: string[];
  pass?: number;
}

export interface GradeRequest extends Order {
  result: string;
}

export type Checked = { ok: false; why: string; receipt?: DeliveryReceipt } | { ok: true; receipt: DeliveryReceipt; request: GradeRequest };

export type Outcome = { use: true; receipt: DeliveryReceipt; verdict: Verdict } | { use: false; why: string; receipt?: DeliveryReceipt; verdict?: Verdict };

export const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const pct = (p: number | undefined) => (p === undefined ? "?" : `${Math.round(p * 1000) / 10}%`);

/** The body as bytes, base64 first, as Wormhole reads it. */
export function bodyOf(response: Delivery["response"]): Uint8Array | undefined {
  if (typeof response.bodyBase64 === "string") return Uint8Array.from(Buffer.from(response.bodyBase64, "base64"));
  if (typeof response.bodyText === "string") return new TextEncoder().encode(response.bodyText);
  return undefined;
}

/** The body as a string that encodes back to the same bytes, or undefined when it is not UTF-8. A byte order mark is kept. */
function exactText(bytes: Uint8Array): string | undefined {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
  return Buffer.from(text, "utf8").equals(bytes) ? text : undefined;
}

/**
 * Wormhole's delivery check, then BrainChain's limits on a result, all before anything is paid. The grade request
 * carries the delivered bytes unchanged, so the record BrainChain publishes holds exactly what Wormhole hashed.
 */
export function check(delivery: Delivery, order: Order, issuedAt?: string): Checked {
  const bytes = bodyOf(delivery.response);
  const inspected = inspectDelivery(
    delivery.quote,
    { status: delivery.response.status, contentType: delivery.response.contentType ?? null, ...(bytes ? { body: bytes } : {}) },
    { ...(delivery.request_digest ? { requestDigest: delivery.request_digest } : {}), ...(issuedAt ? { issuedAt } : {}) },
  );
  const { receipt } = inspected;
  if (inspected.decision === "abstain") return { ok: false, why: `Wormhole did not judge the delivery: ${inspected.reason ?? "no reason given"}`, ...(receipt ? { receipt } : {}) };
  if (inspected.decision !== "allow" || !receipt) {
    const codes = receipt?.codes.length ? ` (${receipt.codes.join(", ")})` : "";
    return { ok: false, why: `Wormhole refused the delivery${codes}`, ...(receipt ? { receipt } : {}) };
  }
  if (!bytes || !deliveryMatches(receipt, bytes)) return { ok: false, why: "Wormhole's receipt does not describe these bytes", receipt };
  const text = exactText(bytes);
  if (text === undefined) return { ok: false, why: "the delivery is not UTF-8 text, and BrainChain grades text", receipt };
  if (bytes.length > MAX_RESULT_BYTES) return { ok: false, why: `the delivery is ${bytes.length.toLocaleString("en-US")} bytes; BrainChain grades at most ${MAX_RESULT_BYTES.toLocaleString("en-US")}`, receipt };
  if (text.trim() === "") return { ok: false, why: "the delivery is blank", receipt };
  return { ok: true, receipt, request: { ...order, result: text } };
}

/**
 * Why the decision record does not hold the bytes Wormhole hashed, or undefined when it does. The record is published
 * under the keccak256 of its own bytes, which is also the hash BrainChain records on chain.
 */
export function confirm(receipt: DeliveryReceipt, url: string, file: Uint8Array): string | undefined {
  const name = URL.canParse(url) ? /^\/records\/(0x[0-9a-f]{64})\.json$/.exec(new URL(url).pathname)?.[1] : undefined;
  if (!name) return `${url} is not a decision record`;
  if (keccak256(file) !== name) return `the record's keccak256 is ${keccak256(file)}, not ${name}, the hash it is published under`;
  let result: unknown;
  try {
    const record = JSON.parse(Buffer.from(file).toString("utf8")) as { kind?: unknown; request?: { state?: unknown } };
    if (record.kind !== "grade" || typeof record.request?.state !== "string") return "the record is not a grade's";
    result = (JSON.parse(record.request.state) as { result?: unknown }).result;
  } catch {
    return "the record is not a grade's";
  }
  if (typeof result !== "string") return "the record holds no result";
  if (result === WITHHELD) return "the record withholds the result";
  const bytes = Buffer.from(result, "utf8");
  if (!deliveryMatches(receipt, bytes)) return `the record's result has SHA-256 ${sha256(bytes)} over ${bytes.length} bytes, not ${receipt.resource_digest} over ${receipt.byte_len}`;
  return undefined;
}

/** Checks the delivery, pays for BrainChain's grade of it, and confirms the published record holds the same bytes. */
export async function gate(
  delivery: Delivery,
  order: Order,
  io: { grade: (request: GradeRequest) => Promise<Verdict>; record: (url: string) => Promise<Uint8Array>; issuedAt?: string },
): Promise<Outcome> {
  const checked = check(delivery, order, io.issuedAt);
  if (!checked.ok) return { use: false, why: checked.why, ...(checked.receipt ? { receipt: checked.receipt } : {}) };
  const { receipt } = checked;
  const verdict = await io.grade(checked.request);
  if (!verdict.accepted) return { use: false, why: `BrainChain rejected the work at a pass probability of ${pct(verdict.passProbability)}, under its bar of ${pct(verdict.bar)}`, receipt, verdict };
  const url = verdict.decision?.record;
  if (!url) return { use: false, why: "BrainChain's verdict names no decision record", receipt, verdict };
  const problem = confirm(receipt, url, await io.record(url));
  if (problem) return { use: false, why: problem, receipt, verdict };
  return { use: true, receipt, verdict };
}
