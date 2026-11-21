import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { keccak256 } from "viem";

import { DEFAULT_DESK } from "../src/desk.ts";
import { parseMandate } from "../src/mandate.ts";
import type { GradeRequest, Registry } from "../src/request.ts";
import type { Run } from "../src/sandbox.ts";
import type { SignedQuote } from "../src/zerox.ts";

export const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
export const MANDATE = parseMandate(read("../fixtures/mandate.json"));
export const MANDATE_FILE = fileURLToPath(new URL("../fixtures/mandate.json", import.meta.url));
export const recorded = (name: string): { trade: string; quote: SignedQuote; registry: Registry } => read(`../fixtures/quotes/${name}.json`);
export const created = (quote: SignedQuote) => Number(/created=(\d+)/.exec(quote.response.signatureInput)![1]);

const digestOf = (body: string) => `sha-256=:${createHash("sha256").update(body, "utf8").digest("base64")}:`;

/**
 * Rewrites one byte inside the Settler actions, the route, in the body as sent, and recomputes the body's digest:
 * every mandate rule still holds, so only 0x's signature can catch it.
 */
export function tamperRoute(quote: SignedQuote): SignedQuote {
  const { body } = quote.response;
  const start = body.indexOf('"data":"0x') + '"data":"0x'.length;
  const end = body.indexOf('"', start);
  // Past exec's head and Settler's slippage words, inside the actions.
  const at = start + Math.floor((end - start) / 2);
  const nibble = (parseInt(body[at]!, 16) + 1) % 16;
  const changed = `${body.slice(0, at)}${nibble.toString(16)}${body.slice(at + 1)}`;
  return { ...quote, response: { ...quote.response, body: changed, contentDigest: digestOf(changed) } };
}

/**
 * The second bypass from the review, in the new form: a block that patches hashlib.sha512 before the checks import it,
 * so Ed25519's challenge hashes to zero and a signature of (base point, 1) verifies over anything. DELIVERY is still a
 * genuine string, holding a tampered route under that signature.
 */
export function sha512Bypass(delivery: string): string {
  return [
    '__hashlib__ = __import__("hashlib")',
    "__sha512__ = __hashlib__.sha512",
    // RFC 8032's first vector still hashes truly, so the checks' self-test passes.
    '__hashlib__.sha512 = lambda data=b"": __sha512__(data) if data.startswith(bytes.fromhex("e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155")) else type("Zero", (), {"digest": lambda self: bytes(64)})()',
    delivery,
  ].join("\n");
}

/** A signature that verifies only if SHA-512 is patched as above: R is the base point and s is 1. */
export function forgedSignature(quote: SignedQuote): SignedQuote {
  const signature = Buffer.concat([Buffer.from("5866666666666666666666666666666666666666666666666666666666666666", "hex"), Buffer.from([1]), Buffer.alloc(31)]).toString("base64");
  return { ...quote, response: { ...quote.response, signature: `sig=:${signature}:` } };
}

/** A grade record as BrainChain publishes it, named by the hash of the whole record even when it is served withheld. */
export function recordOf(request: Pick<GradeRequest, "brief" | "result" | "checks" | "title">, run: Run, options: { answer?: string; withheld?: boolean } = {}) {
  const checks = run.outcome === "passed" ? "passed" : "failed";
  const brief = ["Work delivered outside BrainChain, sent in for a grade. Nobody was hired here; judge the result against the brief below.", `Title: ${request.title}`, request.brief, `\`\`\`python checks\n${request.checks.code}\n\`\`\``].join("\n\n");
  const hidden = "[withheld until the work is accepted]";
  const execution = { checks, language: "python", outcome: run.outcome, output: run.output, ...(run.error ? { error: run.error } : {}) };
  const grade = `0x${"12".repeat(32)}`;
  const answer = options.answer ?? (checks === "passed" ? "accept" : "reject");
  const bytesOf = (state: object) => Buffer.from(JSON.stringify({ answer, checks, kind: "grade", request: { state: JSON.stringify(state) }, subject: BigInt(grade).toString() }));
  const whole = bytesOf({ execution, result: request.result, task: { brief } });
  const bytes = options.withheld ? bytesOf({ execution: { ...execution, output: hidden, error: hidden }, result: hidden, task: { brief } }) : whole;
  const url = `${DEFAULT_DESK}/records/${keccak256(whole)}.json`;
  const view = { grade, state: "graded", accepted: answer === "accept", passProbability: answer === "accept" ? 0.9 : 0, decision: { id: "9999", record: url } };
  /** The record and its grade, as BrainChain's desk serves them. */
  const routes = { [url]: () => new Response(bytes), [`${DEFAULT_DESK}/x402/grades/${grade}`]: () => Response.json(view) };
  return { bytes, url, routes };
}

/** A fetch that answers each URL from a table, and 404 for any other. */
export function serve(routes: Record<string, () => Response | Promise<Response>>): typeof fetch & { urls: string[] } {
  const urls: string[] = [];
  const handler = async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    urls.push(url);
    return (routes[url.split("#")[0]!] ?? (() => new Response("{}", { status: 404 })))();
  };
  return Object.assign(handler as typeof fetch, { urls });
}
