import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type { Address } from "viem";

import { describe, type Mandate } from "./mandate.ts";
import type { SignedQuote } from "./zerox.ts";

/** The body of BrainChain's grade route, as docs.usebrainchain.com/other-networks describes it. */
export interface GradeRequest {
  title: string;
  brief: string;
  result: string;
  levels: string[];
  pass: number;
  checks: { language: "python"; code: string };
}

export interface Registry {
  block: number;
  settler: Address;
  /** The zero address on a chain with one Settler. */
  previous: Address;
}

/** The grade route's limits: checks up to 32,000 characters, and the result's code with the checks up to 64,000. */
export const MAX_CHECKS = 32_000;
export const MAX_PROGRAM = 64_000;

const MANDATE_SLOT = "{mandate}";
const MANDATE_OPEN = '_MANDATE = r"""\n';
const MANDATE_CLOSE = '\n"""\n';

/** This version's checks with the mandate left out. Its SHA-256 names them, whatever mandate they carry. */
export const CHECKS_TEMPLATE = `${MANDATE_OPEN}${MANDATE_SLOT}${MANDATE_CLOSE}\n${readFileSync(new URL("./checks.py", import.meta.url), "utf8").trim()}`;

export const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * The delivered block, whole: one assignment of one string of base64 to DELIVERY. A line of this form is a single
 * string literal, with no quote, backslash or newline inside it to be read two ways, so it runs no code.
 */
export const DELIVERY_FORM = /^DELIVERY = "[A-Za-z0-9+/]*={0,2}"$/;

export const REQUIREMENTS = `Check a trade against its mandate before the agent signs it.

The agent asked 0x's Swap API for a quote through 0x's keyless gateway and got back a transaction to sign. The result's Python block is one line that assigns DELIVERY a string of base64. Decoded, it is JSON: 0x's response byte for byte with its signature headers, the request that signature covers, when the agent received the response by its own clock, and the Settler contract that 0x's on-chain registry named when the agent read it. The block is that one line and nothing else, which anyone can confirm from the published record.

The checks below run after that block. They read DELIVERY as data, verify 0x's Ed25519 signature over the response and the request, decode the transaction, and test it against each rule of the mandate. They print one line per rule, pass or FAIL with the reason, and the run fails if any rule fails.

The mandate:
{mandate}

Judge whether the trade keeps the mandate, as the checks' run shows. Do not judge whether the trade is wise, its price or its timing: the mandate is the whole standard. The registry read and the time of receipt are the agent's own word; everything else the checks rely on is signed by 0x or written in this brief.`;

export const LEVELS = [
  "The checks passed: every rule prints pass, so 0x signed the quote and the transaction keeps the mandate.",
  "A rule failed, or the run did not finish.",
];

/** The mandate as the checks carry it. Its SHA-256 is printed beside the template's, so a record can be compared with the file. */
export const mandateText = (mandate: Mandate): string => JSON.stringify(mandate, null, 2);

/** The delivery's JSON: everything the checks read, and nothing else. */
export function deliveryJson(quote: SignedQuote, registry: Registry): string {
  const { response } = quote;
  return JSON.stringify({
    request: quote.request,
    response: {
      status: response.status,
      "content-type": response.contentType,
      "content-digest": response.contentDigest,
      "signature-input": response.signatureInput,
      signature: response.signature,
      body: response.body,
    },
    receivedAt: quote.receivedAt,
    registry: { block: registry.block, settler: registry.settler, previous: registry.previous },
  });
}

/** The delivered block: data only, so the checks that follow run in an interpreter nothing else has touched. */
export function deliveryCode(quote: SignedQuote, registry: Registry): string {
  if (!Number.isSafeInteger(quote.receivedAt) || !Number.isSafeInteger(registry.block)) throw new Error("The time of receipt and the registry's block must be whole numbers.");
  return `DELIVERY = "${Buffer.from(deliveryJson(quote, registry), "utf8").toString("base64")}"`;
}

/** The checks with the mandate written into them, so the brief that publishes them also publishes what they enforce. */
export function checksFor(mandate: Mandate): string {
  const json = mandateText(mandate);
  if (json.includes('"""') || json.includes("\\")) throw new Error("The mandate holds a character the checks cannot quote.");
  return CHECKS_TEMPLATE.replace(MANDATE_SLOT, () => json);
}

/** A set of checks taken apart into the mandate they carry and their template, or undefined when they carry no mandate. */
export function splitChecks(checks: string): { mandate: string; template: string } | undefined {
  const start = checks.indexOf(MANDATE_OPEN);
  const end = start < 0 ? -1 : checks.indexOf(MANDATE_CLOSE, start + MANDATE_OPEN.length);
  if (end < 0) return undefined;
  return { mandate: checks.slice(start + MANDATE_OPEN.length, end), template: `${checks.slice(0, start + MANDATE_OPEN.length)}${MANDATE_SLOT}${checks.slice(end)}` };
}

/** One grade: the mandate and checks as the brief, 0x's signed quote as the result. */
export function pretradeCheck(input: { quote: SignedQuote; registry: Registry; mandate: Mandate; trade: string }): GradeRequest {
  const code = deliveryCode(input.quote, input.registry);
  const checks = checksFor(input.mandate);
  if (checks.includes("```")) throw new Error("A code fence inside the checks would cut them short.");
  if (checks.length > MAX_CHECKS) throw new Error(`The checks are ${checks.length.toLocaleString("en-US")} characters; the grade route takes ${MAX_CHECKS.toLocaleString("en-US")}.`);
  // The sandbox joins the result's code and the checks into one program and runs at most this much.
  const program = `${code}\n\n${checks}`;
  if (program.length > MAX_PROGRAM || JSON.stringify({ language: "python", code: program }).length > 2 * MAX_PROGRAM) {
    throw new Error(`The delivery and the checks come to ${program.length.toLocaleString("en-US")} characters; the sandbox runs ${MAX_PROGRAM.toLocaleString("en-US")}.`);
  }
  return {
    title: `Pre-trade check: ${input.trade}`.slice(0, 120),
    brief: REQUIREMENTS.replace("{mandate}", () => describe(input.mandate)),
    result: `The trade the agent is about to sign: ${input.trade}, as 0x quoted it.\n\n\`\`\`python\n${code}\n\`\`\``,
    levels: LEVELS,
    pass: 0,
    checks: { language: "python", code: checks },
  };
}
