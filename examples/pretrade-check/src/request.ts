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
  previous: Address;
}

/** The grade route's limits: checks up to 32,000 characters, and the result's code with the checks up to 64,000. */
export const MAX_CHECKS = 32_000;
export const MAX_PROGRAM = 64_000;

export const CHECKS = readFileSync(new URL("./checks.py", import.meta.url), "utf8").trim();

export const REQUIREMENTS = `Check a trade against its mandate before the agent signs it.

The agent asked 0x's Swap API for a quote through 0x's keyless gateway and got back a transaction to sign. The result's Python block defines DELIVERY: 0x's response byte for byte with its signature headers, the request that signature covers, when the agent received the response by its own clock, and the Settler contract that 0x's on-chain registry named when the agent read it. The block must do nothing but assign DELIVERY.

The checks below run after that block. They verify 0x's Ed25519 signature over the response and the request, decode the transaction, and test it against each rule of the mandate. They print one line per rule, pass or FAIL with the reason, and the run fails if any rule fails.

The mandate:
{mandate}

Judge whether the trade keeps the mandate, as the checks' run shows. Do not judge whether the trade is wise, its price or its timing: the mandate is the whole standard. The registry read and the time of receipt are the agent's own word; everything else the checks rely on is signed by 0x or written in this brief.`;

export const LEVELS = [
  "The checks passed: every rule prints pass, so 0x signed the quote and the transaction keeps the mandate.",
  "A rule failed, the run did not finish, or the delivery's code does more than assign DELIVERY.",
];

type Literal = string | number | { [key: string]: Literal };

/** A Python literal for JSON-shaped data. JSON's string escapes are all valid in Python, so the text comes through unchanged. */
function python(value: Literal, indent = ""): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`${value} is not an integer the checks can read exactly.`);
    return String(value);
  }
  const inner = `${indent}    `;
  return `{\n${Object.entries(value).map(([key, v]) => `${inner}${JSON.stringify(key)}: ${python(v, inner)},`).join("\n")}\n${indent}}`;
}

/** The delivery as the checks read it: data only, under the one name they allow. */
export function deliveryCode(quote: SignedQuote, registry: Registry): string {
  const { response } = quote;
  return `DELIVERY = ${python({
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
    registry: { ...registry },
  })}`;
}

/** The checks with the mandate written into them, so the brief that publishes them also publishes what they enforce. */
export function checksFor(mandate: Mandate): string {
  const json = JSON.stringify(mandate, null, 2);
  if (json.includes('"""') || json.includes("\\")) throw new Error("The mandate holds a character the checks cannot quote.");
  // Taken before anything of the checks' own exists: every name here came from the delivery.
  return `_DELIVERED = sorted(n for n in globals() if not (n.startswith("__") and n.endswith("__")))\n\n_MANDATE = r"""\n${json}\n"""\n\n${CHECKS}`;
}

/** One grade: the mandate and checks as the brief, 0x's signed quote as the result. */
export function pretradeCheck(input: { quote: SignedQuote; registry: Registry; mandate: Mandate; trade: string }): GradeRequest {
  const code = deliveryCode(input.quote, input.registry);
  const checks = checksFor(input.mandate);
  if (checks.includes("```") || code.includes("```")) throw new Error("A code fence inside the checks or the delivery would cut them short.");
  if (checks.length > MAX_CHECKS) throw new Error(`The checks are ${checks.length.toLocaleString("en-US")} characters; the grade route takes ${MAX_CHECKS.toLocaleString("en-US")}.`);
  // The sandbox joins the result's code and the checks into one program and runs at most this much.
  const program = `${code}\n\n${checks}`;
  if (program.length > MAX_PROGRAM || JSON.stringify({ language: "python", code: program }).length > 2 * MAX_PROGRAM) {
    throw new Error(`The delivery and the checks come to ${program.length.toLocaleString("en-US")} characters; the sandbox runs ${MAX_PROGRAM.toLocaleString("en-US")}.`);
  }
  return {
    title: `Pre-trade check: ${input.trade}`.slice(0, 120),
    brief: REQUIREMENTS.replace("{mandate}", describe(input.mandate)),
    result: `The trade the agent is about to sign: ${input.trade}, as 0x quoted it.\n\n\`\`\`python\n${code}\n\`\`\``,
    levels: LEVELS,
    pass: 0,
    checks: { language: "python", code: checks },
  };
}
