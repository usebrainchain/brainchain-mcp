// Agent Wormhole checks that a paid response is the resource that was quoted. BrainChain grades whether it is the work
// that was asked for. The agent uses the delivery, or releases what it holds for it, only when both pass.
import { createHash } from "node:crypto";

import { keccak256 } from "viem";
import { deliveryMatches, inspectDelivery, type DeliveryQuote, type DeliveryReceipt } from "wormhole-x402/delivery";

import type { Verdict } from "./desk.ts";

/** BrainChain's cap on a delivered result sent for a grade. */
const MAX_RESULT_BYTES = 100_000;

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
}

export interface GradeRequest extends Order {
  result: string;
}

/** `unchecked` marks a delivery this script could not judge, as opposed to one found wrong. */
export type Checked = { ok: false; why: string; unchecked?: true; receipt?: DeliveryReceipt } | { ok: true; receipt: DeliveryReceipt; request: GradeRequest };

export type Outcome = { use: true; verdict: Verdict } | { use: false; why: string; unchecked?: true; verdict?: Verdict };

export const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export const pct = (p: number | undefined) => (p === undefined ? "?" : `${Math.round(p * 1000) / 10}%`);

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
  const held = receipt ? { receipt } : {};
  if (inspected.decision === "abstain") return { ok: false, unchecked: true, why: `Wormhole did not judge the delivery: ${inspected.reason ?? "no reason given"}`, ...held };
  if (inspected.decision !== "allow" || !receipt) return { ok: false, why: `Wormhole refused the delivery${receipt?.codes.length ? ` (${receipt.codes.join(", ")})` : ""}`, ...held };
  if (!bytes) return { ok: false, unchecked: true, why: "the delivery has no body to grade", receipt };
  const text = exactText(bytes);
  if (text === undefined) return { ok: false, unchecked: true, why: "the delivery is not UTF-8 text, and BrainChain grades text", receipt };
  if (bytes.length > MAX_RESULT_BYTES) return { ok: false, unchecked: true, why: `the delivery is ${bytes.length.toLocaleString("en-US")} bytes; BrainChain grades at most ${MAX_RESULT_BYTES.toLocaleString("en-US")}`, receipt };
  if (text.trim() === "") return { ok: false, unchecked: true, why: "the delivery is blank", receipt };
  return { ok: true, receipt, request: { ...order, result: text } };
}

/** The hash a record on the desk is published under, or undefined for a URL that is not one of the desk's records. */
export function recordName(url: string, desk: string): string | undefined {
  const at = URL.canParse(url) ? new URL(url) : undefined;
  if (!at || at.origin !== new URL(desk).origin || at.search || !/^(#evidence=0x[0-9a-f]{64})?$/.test(at.hash)) return undefined;
  return /^\/records\/(0x[0-9a-f]{64})\.json$/.exec(at.pathname)?.[1];
}

/**
 * Why the record does not show BrainChain graded the bytes Wormhole hashed, or undefined when it does. The record must
 * be the file its name hashes, and name the grade the verdict is for: a paid grade's record carries the grade id as a
 * decimal subject.
 */
export function confirm(receipt: DeliveryReceipt, verdict: Verdict, name: string, file: Uint8Array): string | undefined {
  if (keccak256(file) !== name) return `the record's keccak256 is ${keccak256(file)}, not ${name}, the hash it is published under`;
  let record: { kind?: unknown; subject?: unknown; request?: { state?: unknown } };
  let result: unknown;
  try {
    record = JSON.parse(Buffer.from(file).toString("utf8")) as typeof record;
    result = typeof record.request?.state === "string" ? (JSON.parse(record.request.state) as { result?: unknown } | null)?.result : undefined;
  } catch {
    return "the record is not JSON";
  }
  if (record.kind !== "grade") return "the record is not a grade's";
  if (!/^0x[0-9a-fA-F]{64}$/.test(verdict.grade) || record.subject !== BigInt(verdict.grade).toString()) return `the record is not grade ${verdict.grade}'s`;
  if (typeof result !== "string") return "the record holds no result";
  const bytes = Buffer.from(result, "utf8");
  if (!deliveryMatches(receipt, bytes)) return `the record's result has SHA-256 ${sha256(bytes)} over ${bytes.length} bytes, not ${receipt.resource_digest} over ${receipt.byte_len}`;
  return undefined;
}

/** Pays for BrainChain's grade of a delivery Wormhole allowed, and confirms the published record holds the same bytes. */
export async function gate(
  checked: Extract<Checked, { ok: true }>,
  io: { desk: string; grade: (request: GradeRequest) => Promise<Verdict>; record: (url: string) => Promise<Uint8Array> },
): Promise<Outcome> {
  const verdict = await io.grade(checked.request);
  if (!verdict.accepted) return { use: false, why: `BrainChain rejected the work at a pass probability of ${pct(verdict.passProbability)}, under its bar of ${pct(verdict.bar)}`, verdict };
  const url = verdict.decision?.record ?? "";
  const name = recordName(url, io.desk);
  if (!name) return { use: false, why: `BrainChain's verdict names ${url ? `${url}, which is not a decision record on ${io.desk}` : "no decision record"}`, verdict };
  const problem = confirm(checked.receipt, verdict, name, await io.record(url));
  if (problem) return { use: false, why: problem, verdict };
  return { use: true, verdict };
}
