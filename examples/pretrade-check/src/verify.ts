// Confirms a published pre-trade decision from its record: the delivered block was data and nothing else, the checks
// were this version's with the given mandate, and run again here they give the outcome BrainChain published.
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { createPublicClient, http, keccak256, parseAbiItem, toHex, type PublicClient } from "viem";

import { deskUrl, readGrade, type Verdict } from "./desk.ts";
import { readMandate } from "./mandate.ts";
import { checksFor, CHECKS_TEMPLATE, DELIVERY_FORM, EARLIER_TEMPLATES, mandateText, sha256, splitChecks } from "./request.ts";
import { CHECKS_FENCE, CHECKS_OPENER, pythonBlocks, runLocally } from "./sandbox.ts";

/** What a record's request.state holds for a grade: the brief, the result and BrainChain's run of the checks. */
export interface State {
  task?: { brief?: string };
  result?: string;
  execution?: { checks?: string; outcome?: string; error?: string; output?: string };
}

/** BrainChain's stand-in for work it has not accepted, in the result and in what the run printed. */
const WITHHELD = "[withheld until the work is accepted]";

export async function fetchRecord(url: string, fetchImpl: typeof fetch = fetch): Promise<{ bytes: Buffer; record: Record<string, unknown> }> {
  const response = await fetchImpl(url.split("#")[0]!, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`The record answered ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const record: unknown = JSON.parse(bytes.toString("utf8"));
  if (typeof record !== "object" || record === null || Array.isArray(record)) throw new Error("The record is not a JSON object.");
  return { bytes, record: record as Record<string, unknown> };
}

export function recordState(record: Record<string, unknown>): State | undefined {
  const state = (record.request as { state?: unknown } | undefined)?.state;
  if (typeof state !== "string") return undefined;
  try {
    return JSON.parse(state) as State;
  } catch {
    return undefined;
  }
}

type Mark = "ok" | "FAIL" | "skip";

/** BrainChain's chain and the public node `npx brainchain-verify mainnet` reads it from. */
export const BRAINCHAIN = { chainId: 274663, rpc: "https://rpc.usebrainchain.com" } as const;
const RECORDED = parseAbiItem("event Recorded(uint256 indexed id, uint8 indexed kind, bytes32 indexed subject, bytes32 inputHash, bytes32 answer, uint16 confidenceBps, bytes32 payloadHash, string payloadURI)");

export interface VerifyIo {
  fetch: typeof fetch;
  log: (line: string) => void;
  desk: string;
  /** A client for BrainChain's chain, to read a decision by its id. */
  brainchain?: PublicClient;
}

/** A decision's number, from its id or its page's URL. */
function decisionId(target: string): bigint | undefined {
  if (/^\d+$/.test(target)) return BigInt(target);
  const page = URL.canParse(target) ? new URL(target) : undefined;
  if (!page || page.protocol !== "https:" || !["usebrainchain.com", "www.usebrainchain.com"].includes(page.hostname) || page.pathname !== "/decision") return undefined;
  if (page.searchParams.has("set")) throw new Error("A decision page of an earlier contract set is read by its record's URL, which the page links.");
  const id = page.searchParams.get("id") ?? "";
  if (!/^\d+$/.test(id)) throw new Error(`${target} names no decision id.`);
  return BigInt(id);
}

/**
 * The record a decision names on chain: the payloadURI of its Recorded event on the DecisionLog the desk's
 * network.json names as active, read from BrainChain's public node, as brainchain-verify reads it.
 */
async function recordOfDecision(id: bigint, io: VerifyIo): Promise<string> {
  const response = await io.fetch(`${io.desk}/network.json`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  const active = response.ok ? ((await response.json()) as { manifest?: { activeSet?: { fromBlock?: number; contracts?: { DecisionLog?: `0x${string}` } } } }).manifest?.activeSet : undefined;
  const log = active?.contracts?.DecisionLog;
  if (!log || !Number.isSafeInteger(active.fromBlock)) throw new Error(`${io.desk}/network.json names no active DecisionLog.`);
  const client = io.brainchain ?? createPublicClient({ transport: http(BRAINCHAIN.rpc, { timeout: 20_000 }) });
  const chainId = await client.getChainId();
  if (chainId !== BRAINCHAIN.chainId) throw new Error(`BrainChain's node answers for chain ${chainId}, not ${BRAINCHAIN.chainId}.`);
  const [recorded] = await client.getLogs({ address: log, event: RECORDED, args: { id }, fromBlock: BigInt(active.fromBlock!), strict: true });
  if (!recorded) throw new Error(`DecisionLog ${log}, BrainChain's current one, has no decision ${id}.`);
  return recorded.args.payloadURI;
}

export async function verify(target: string, mandateFile: string, io: VerifyIo): Promise<number> {
  const mandate = await readMandate(mandateFile);
  const lines: [Mark, string][] = [];
  const line = (mark: Mark, text: string) => {
    lines.push([mark, text]);
    io.log(`  ${mark.padEnd(5)} ${text}`);
  };

  const decision = decisionId(target);
  let url = decision === undefined ? target : await recordOfDecision(decision, io);
  let view: Verdict | undefined;
  if (/^0x[0-9a-fA-F]{64}$/.test(target)) {
    view = await readGrade(target.toLowerCase(), { desk: io.desk, fetch: io.fetch });
    if (view.state !== "graded" || !view.decision?.record) throw new Error(`Grade ${target} is ${view.state}, with no decision yet. Reading it again is free.`);
    url = view.decision.record;
  }
  const name = new RegExp(`^${io.desk.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/records/(0x[0-9a-f]{64})\\.json(?:#evidence=0x[0-9a-f]{64})?$`).exec(url)?.[1];
  if (!name) throw new Error(`${url} is not a decision record on ${io.desk}: give a decision id, its page, a grade id or ${io.desk}/records/<hash>.json.`);
  const { bytes, record } = await fetchRecord(url, io.fetch);
  const state = recordState(record);
  if (record.kind !== "grade" || !state) throw new Error("The record is not a grade's.");
  const withheld = state.result === WITHHELD;
  // A paid grade's record names it by its id, as a decimal number.
  const grade = typeof record.subject === "string" && /^\d+$/.test(record.subject) ? toHex(BigInt(record.subject), { size: 32 }) : undefined;
  if (!view && grade) view = await readGrade(grade, { desk: io.desk, fetch: io.fetch }).catch(() => undefined);
  const percent = (p: unknown) => (typeof p === "number" ? `${Math.round(p * 1000) / 10}%` : "?");
  const outcome = view?.accepted === undefined ? `answered ${String(record.answer)} at ${percent(record.confidence)}` : `${view.accepted ? "accepted" : "refused"} at a pass probability of ${percent(view.passProbability)}`;
  io.log(`Decision ${view?.decision?.id ?? "?"}${grade ? `, grade ${grade}` : ""}: ${outcome}, checks ${String(record.checks)}, from ${url.split("#")[0]}`);

  if (!grade) line("FAIL", "grade: the record names no grade");
  else if (!view) line("skip", `grade: BrainChain shows no grade ${grade}`);
  else if (view.grade !== grade || view.decision?.record?.split("#")[0] !== url.split("#")[0]) line("FAIL", `grade: grade ${view.grade}'s verdict links ${view.decision?.record ?? "no record"}, not this one for grade ${grade}`);
  else line("ok", `grade: its verdict links this record, as decision ${view.decision?.id}`);
  if (keccak256(bytes) === name) line("ok", "record: its keccak256 is the hash it is published under");
  else if (withheld) line("skip", "record: served without the delivery, as for any work BrainChain did not accept, so its hash cannot match its name");
  else line("FAIL", `record: its keccak256 is ${keccak256(bytes)}, not ${name}, the hash it is published under`);

  const result = state.result ?? "";
  const blocks = pythonBlocks(result);
  let pure = false;
  if (withheld) line("skip", "delivery: withheld until the work is accepted");
  else if (blocks.length !== 1) line("FAIL", `delivery: the result has ${blocks.length} Python blocks, and BrainChain runs them all before the checks`);
  else if (DELIVERY_FORM.test(blocks[0]!)) {
    pure = true;
    line("ok", `delivery: one line assigning DELIVERY a string of ${blocks[0]!.length - 'DELIVERY = ""'.length} base64 characters, which runs no code`);
  } else if (blocks[0]!.startsWith("DELIVERY = {")) line("FAIL", "delivery: the earlier form, a Python dict; this version vouches only for one base64 string");
  else line("FAIL", "delivery: the block is more than one base64 string assigned to DELIVERY, so code may have run before the checks");

  const brief = state.task?.brief ?? "";
  const fences = [...brief.matchAll(CHECKS_FENCE)].map((m) => m[1]!.trim());
  const published = fences.length === 1 && [...brief.matchAll(CHECKS_OPENER)].length === 1 ? fences[0]! : undefined;
  const parts = published === undefined ? undefined : splitChecks(published);
  const template = sha256(CHECKS_TEMPLATE);
  const ours = mandateText(mandate);
  const theirs = parts && sha256(parts.template);
  // Checks this version knows, its own or an earlier wording of the same rules, are code it can run.
  const known = parts && (parts.template === CHECKS_TEMPLATE || EARLIER_TEMPLATES.get(theirs!) === parts.template) ? parts.template : undefined;
  const canonical = known !== undefined && published === checksFor(mandate, known);
  if (published === undefined) line("FAIL", `checks: the brief holds ${fences.length} Python checks blocks, not one`);
  else if (known === CHECKS_TEMPLATE) line("ok", `checks: this version's, template SHA-256 ${template}`);
  else if (known) line("ok", `checks: an earlier wording of the same rules, kept in src/templates, template SHA-256 ${theirs}`);
  else line("FAIL", `checks: not this version's: their template's SHA-256 is ${theirs ?? "unknown, as they carry no mandate"}, this version's ${template}`);
  if (parts && parts.mandate === ours) line("ok", `mandate: the checks carry the mandate in ${basename(mandateFile)}, SHA-256 ${sha256(ours)}`);
  else if (published !== undefined) {
    const wallet = parts && /"wallet": "(0x[0-9a-fA-F]{40})"/.exec(parts.mandate)?.[1];
    line("FAIL", `mandate: the checks carry ${parts ? `a mandate${wallet ? ` for wallet ${wallet}` : ""} with SHA-256 ${sha256(parts.mandate)}` : "no mandate"}, not the one in ${basename(mandateFile)}, SHA-256 ${sha256(ours)}`);
  }

  // Only a block of data followed by checks this version knows is run on this machine: anything else is code from the record.
  if (!pure || !canonical) line("skip", "rerun: skipped; only a block of data followed by known checks is run here");
  else {
    const run = await runLocally({ result, checks: { language: "python", code: published! } });
    const execution = state.execution ?? {};
    const decided = run.outcome === "passed" ? "passed" : "failed";
    const problems = [
      ...(execution.outcome !== run.outcome ? [`BrainChain's run ${String(execution.outcome)}, this one ${run.outcome}`] : []),
      ...(execution.output !== run.output ? ["the two runs printed different text"] : []),
      ...(record.checks !== decided || state.execution?.checks !== decided ? [`the record says the checks ${String(record.checks)}`] : []),
      ...(decided === "failed" && record.answer !== "reject" ? ["the record accepts work whose checks failed"] : []),
    ];
    const trade = run.output.split("\n")[0] ?? "";
    if (problems.length === 0) line("ok", `rerun: ${run.outcome} here, printing exactly what BrainChain's run printed. ${trade}`);
    else line("FAIL", `rerun: ${problems.join("; ")}`);
  }

  const failed = lines.filter(([mark]) => mark === "FAIL").map(([, text]) => text.split(":")[0]);
  const skipped = lines.some(([mark]) => mark === "skip");
  if (failed.length > 0) {
    // The first version's checks began by listing the names the delivery defined.
    const earlier = lines.some(([mark, text]) => mark === "FAIL" && text.startsWith("delivery: the earlier form")) || published?.startsWith("_DELIVERED = ");
    io.log(
      earlier
        ? `\nVerdict: earlier form. This decision was made before the delivery became one string, so this version cannot vouch for it (failed: ${failed.join(", ")}).`
        : `\nVerdict: mismatch on ${failed.join(", ")}. Do not rely on this decision.`,
    );
  } else if (skipped) {
    io.log("\nVerdict: not verified. BrainChain publishes the delivery only for work it accepts, so this decision cannot be run again.");
  } else {
    io.log(`\nVerdict: match. The published block is data and nothing else, the checks are ${known === CHECKS_TEMPLATE ? "this version's" : "an earlier wording of its rules"} with the mandate in ${basename(mandateFile)}, and they ${record.checks === "passed" ? "pass" : "fail"} here as they did on BrainChain.`);
  }
  io.log(`To confirm the record on chain: npx brainchain-verify mainnet ${view?.decision?.id ?? "<decision id>"}`);
  return failed.length > 0 ? 2 : skipped ? 1 : 0;
}

const USAGE = `npm run verify -- <target> --mandate <file>

The target is a decision id such as 1004, its page (https://usebrainchain.com/decision?id=1004), a grade id or a
decision record's URL. The mandate is the file the decision's checks should carry.

Exit codes: 0 the record matches; 2 it does not, or is of the earlier form; 1 it could not be checked.`;

export async function cli(argv: string[], io: Omit<VerifyIo, "desk"> & { desk?: string; error: (line: string) => void } = { fetch, log: console.log, error: console.error }): Promise<number> {
  try {
    const { values, positionals } = parseArgs({ args: argv, options: { mandate: { type: "string" }, help: { type: "boolean", short: "h" } }, allowPositionals: true });
    if (values.help) {
      io.log(USAGE);
      return 0;
    }
    if (positionals.length !== 1) throw new Error(`verify takes one decision id, decision page, grade id or record URL. See --help.`);
    if (!values.mandate) throw new Error("verify needs --mandate <file>: the mandate the decision's checks should carry.");
    return await verify(positionals[0]!, values.mandate, { ...io, desk: io.desk ?? deskUrl() });
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await cli(process.argv.slice(2));
