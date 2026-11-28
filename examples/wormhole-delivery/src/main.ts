// Use a paid delivery only when Agent Wormhole finds it is what was quoted and BrainChain grades it as the work asked for.
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { privateKeyToAccount } from "viem/accounts";
import type { PrivateKeyAccount } from "viem";
import type { DeliveryReceipt } from "wormhole-x402/delivery";

import { DEFAULT_DESK, deskUrl, payGrade, priceOf, type Verdict } from "./desk.ts";
import { check, confirm, gate, pct, recordName, type Delivery, type Order, type Outcome } from "./gate.ts";
import { messageOf } from "./shared.ts";

const SAMPLES = fileURLToPath(new URL("../fixtures/", import.meta.url));
/** BrainChain's limits on a grade request's brief and title, in characters. */
const MAX_BRIEF = 32_000;
const MAX_TITLE = 120;
/** Far more than a grade record of a 100,000-byte result and a 32,000-character brief. */
const MAX_RECORD_BYTES = 2_000_000;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const USAGE = `Usage:
  npm run gate -- --sample
  npm run gate -- --dry --delivery <file> --brief <file> [--title <text>]
  npm run gate -- --delivery <file> --brief <file> [--title <text>]

  --delivery <file>  the paid response as JSON, as Wormhole's verify_delivery takes it:
                     {"quote": {...}, "response": {"status", "contentType", "bodyText" or "bodyBase64"}, "request_digest"}
  --brief <file>     what the delivery had to be, as UTF-8 text of at most 32,000 characters;
                     BrainChain reads nothing else about the job
  --title <text>     one line of at most 120 characters naming the deliverable
  --dry              Wormhole's check and BrainChain's price; nothing is paid
  --sample           Wormhole's check on the sample deliveries in fixtures/, and the recorded grades; nothing is paid
  -h, --help         this text

A paid run reads the paying wallet's key from the file BRAINCHAIN_PAYER_KEY_FILE names and pays BrainChain
0.25 USDC on Base for the grade. BRAINCHAIN_DESK_URL replaces BrainChain's desk.

Exit codes:
  0  use the delivery; with --dry, BrainChain would grade it
  1  the run stopped short, such as on malformed input, a delivery this script cannot grade, or a grade that did not finish
  2  do not use the delivery: Wormhole refused it, BrainChain rejected it, or the record does not confirm it`;

export interface Io {
  log: (line: string) => void;
  error: (line: string) => void;
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
  account: (file: string | undefined) => Promise<PrivateKeyAccount>;
  now: () => Date;
  /** Between reads of a grade still being decided. */
  pollMs?: number;
}

const defaultIo: Io = { log: console.log, error: console.error, fetch: (...args) => fetch(...args), env: process.env, account: (file) => loadAccount(file), now: () => new Date() };

/** The key that pays for the grade. It is read from a file and never printed. */
export async function loadAccount(file: string | undefined): Promise<PrivateKeyAccount> {
  if (!file) throw new Error("Set BRAINCHAIN_PAYER_KEY_FILE to a file holding the paying wallet's private key. It pays 0.25 USDC to BrainChain on Base.");
  const mode = await stat(file).then(
    (s) => {
      if (!s.isFile()) throw new Error(`BRAINCHAIN_PAYER_KEY_FILE names ${file}, which is not a file.`);
      return s.mode;
    },
    (error: NodeJS.ErrnoException) => {
      throw new Error(`BRAINCHAIN_PAYER_KEY_FILE names ${file}, which ${error.code === "ENOENT" ? "does not exist" : `cannot be read (${error.code ?? error.message})`}.`, { cause: error });
    },
  );
  // As brainchain-mcp does: a key other accounts on the machine can read is a key they can spend.
  if (process.platform !== "win32" && (mode & 0o077) !== 0) throw new Error(`Other accounts can read ${file}. Run chmod 600 on it first.`);
  const key = (await readFile(file, "utf8")).trim().replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(key)) throw new Error("BRAINCHAIN_PAYER_KEY_FILE does not hold a 64-character hex private key.");
  return privateKeyToAccount(`0x${key}`);
}

/** Reads a UTF-8 text file and drops a leading byte order mark. Text that is not UTF-8 is refused rather than read with replacements. */
async function readText(file: string): Promise<string> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(file));
  } catch (error) {
    throw new Error(error instanceof TypeError ? `${file} is not UTF-8 text.` : `${file} cannot be read: ${messageOf(error)}`, { cause: error });
  }
  if (text.includes("\0")) throw new Error(`${file} is not UTF-8 text.`);
  return text;
}

export async function readDelivery(file: string): Promise<Delivery> {
  const text = await readText(file);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not JSON: ${messageOf(error)}`, { cause: error });
  }
  const delivery = value as Partial<Delivery> | null;
  const response = delivery?.response;
  if (typeof delivery?.quote !== "object" || delivery.quote === null || Array.isArray(delivery.quote)) throw new Error(`${file} needs a quote object: the merchant's quote the payment was made against.`);
  if (typeof response !== "object" || response === null || !Number.isInteger(response.status)) throw new Error(`${file} needs a response with the HTTP status that arrived after paying.`);
  if (response.bodyText !== undefined && typeof response.bodyText !== "string") throw new Error(`${file}: response.bodyText must be a string.`);
  if (response.bodyBase64 !== undefined && typeof response.bodyBase64 !== "string") throw new Error(`${file}: response.bodyBase64 must be a string.`);
  if (response.bodyText !== undefined && response.bodyBase64 !== undefined) throw new Error(`${file}: give the body once, as bodyText or as bodyBase64.`);
  if (response.bodyBase64 !== undefined && !BASE64.test(response.bodyBase64)) throw new Error(`${file}: response.bodyBase64 is not base64.`);
  if (response.contentType !== undefined && typeof response.contentType !== "string") throw new Error(`${file}: response.contentType must be a string.`);
  if (delivery.request_digest !== undefined && typeof delivery.request_digest !== "string") throw new Error(`${file}: request_digest must be a string.`);
  return delivery as Delivery;
}

async function readOrder(file: string | undefined, title: string | undefined): Promise<Order> {
  if (!file) throw new Error("--brief names the file that says what the delivery had to be. Run with --help for the usage.");
  const brief = (await readText(file)).trim();
  if (!brief) throw new Error(`${file} is empty.`);
  if (brief.length > MAX_BRIEF) throw new Error(`${file} holds a brief of ${brief.length.toLocaleString("en-US")} characters; BrainChain takes at most ${MAX_BRIEF.toLocaleString("en-US")}.`);
  if (title !== undefined && (!title.trim() || title.length > MAX_TITLE || /[\n\r]/.test(title))) throw new Error(`--title is one line of 1 to ${MAX_TITLE} characters.`);
  return { ...(title ? { title: title.trim() } : {}), brief };
}

const wormholeLine = (receipt: DeliveryReceipt) =>
  `Wormhole: ${receipt.decision}, HTTP ${receipt.http_status}${receipt.byte_len === null ? "" : `, ${receipt.byte_len} bytes, SHA-256 ${receipt.resource_digest}`}${receipt.codes.length ? `, ${receipt.codes.join(", ")}` : ""}`;

function report(outcome: Outcome, io: Io): number {
  const { verdict } = outcome;
  if (verdict) io.log(`BrainChain: ${verdict.accepted ? "accepted" : "rejected"} at a pass probability of ${pct(verdict.passProbability)} (bar ${pct(verdict.bar)}), decision ${verdict.decision?.id ?? "?"}${verdict.decision?.page ? `, ${verdict.decision.page}` : ""}`);
  if (outcome.use) {
    io.log("Record: holds the same bytes, published under its own keccak256.");
    io.log("Use the delivery.");
    return 0;
  }
  if (outcome.ungraded) {
    io.log(`Not graded: ${outcome.why}.`);
    return 1;
  }
  io.log(`Do not use the delivery: ${outcome.why}.`);
  return 2;
}

async function sample(io: Io): Promise<number> {
  const order = await readOrder(join(SAMPLES, "brief.txt"), undefined);
  io.log(`Brief: ${order.brief}\n`);
  const dir = join(SAMPLES, "deliveries");
  for (const file of (await readdir(dir)).filter((name) => name.endsWith(".json")).sort()) {
    const checked = check(await readDelivery(join(dir, file)), order, io.now().toISOString());
    const name = basename(file, ".json");
    const receipt = checked.receipt;
    io.log(`${name}: ${receipt ? `HTTP ${receipt.http_status}${receipt.byte_len === null ? "" : `, ${receipt.byte_len} bytes`}` : "no receipt"}`);
    if (!checked.ok) {
      io.log(`  Stops here, and nothing is paid to BrainChain: ${checked.why}.`);
      continue;
    }
    io.log(`  Wormhole allows it (SHA-256 ${checked.receipt.resource_digest}). It goes to BrainChain's grade.`);
    const recorded = await readFile(join(SAMPLES, "recorded", `${name}.json`), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!recorded) continue;
    const verdict = JSON.parse(recorded) as Verdict;
    io.log(`  Recorded on mainnet: BrainChain ${verdict.accepted ? "accepted" : "rejected"} it at a pass probability of ${pct(verdict.passProbability)} (bar ${pct(verdict.bar)}), ${verdict.decision?.page ?? `decision ${verdict.decision?.id}`}`);
    if (!verdict.accepted || !verdict.decision?.record) continue;
    const record = recordName(verdict.decision.record, DEFAULT_DESK);
    const problem = record ? confirm(checked.receipt, verdict, record, new Uint8Array(await readFile(join(SAMPLES, "records", `${verdict.decision.id}.json`)))) : "its URL is not one of the desk's records";
    io.log(problem ? `  The saved record does not hold these bytes: ${problem}.` : "  Its decision record holds the same bytes, so its result hashes to Wormhole's SHA-256.");
  }
  return 0;
}

export async function main(argv: string[], io: Io = defaultIo): Promise<number> {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        delivery: { type: "string" },
        brief: { type: "string" },
        title: { type: "string" },
        dry: { type: "boolean" },
        sample: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
    if (values.help) {
      io.log(USAGE);
      return 0;
    }
    if (argv.length === 0) {
      io.log(USAGE);
      return 1;
    }
    if (values.sample) {
      if (values.delivery || values.brief || values.title || values.dry) throw new Error("--sample takes no other flags.");
      return await sample(io);
    }
    if (!values.delivery) throw new Error("--delivery names the paid response to check. Run with --help for the usage.");
    const delivery = await readDelivery(values.delivery);
    const order = await readOrder(values.brief, values.title);
    const desk = deskUrl(io.env.BRAINCHAIN_DESK_URL);
    const checked = check(delivery, order, io.now().toISOString());
    if (checked.receipt) io.log(wormholeLine(checked.receipt));
    if (!checked.ok) return report({ use: false, why: checked.why, ...(checked.ungraded ? { ungraded: true } : {}) }, io);
    if (values.dry) {
      const price = await priceOf(checked.request, { desk, fetch: io.fetch }).catch((error: unknown) => {
        throw new Error(`BrainChain did not answer: ${messageOf(error)}. Nothing was paid to BrainChain.`, { cause: error });
      });
      io.log(price.text);
      return price.takes ? 0 : 1;
    }
    const outcome = await gate(checked, {
      desk,
      // The key is read only once Wormhole has allowed the delivery.
      grade: async (request) => {
        const account = await io.account(io.env.BRAINCHAIN_PAYER_KEY_FILE);
        io.log(`Paying from ${account.address}.`);
        return (await payGrade(request, account, { desk, fetch: io.fetch, log: io.log, ...(io.pollMs ? { pollMs: io.pollMs } : {}) })).verdict;
      },
      record: async (url) => {
        const link = url.split("#")[0]!;
        const unread = (why: string, cause?: unknown) =>
          new Error(`BrainChain accepted the work, but its record ${link} ${why}. Reading it again is free; running this again pays for another grade.`, cause === undefined ? undefined : { cause });
        const failed = (error: unknown) => {
          throw unread(`could not be read (${messageOf(error)})`, error);
        };
        const response = await io.fetch(link, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) }).catch(failed);
        if (!response.ok) throw unread(`answered ${response.status}`);
        const tooBig = `is over ${MAX_RECORD_BYTES.toLocaleString("en-US")} bytes`;
        if (Number(response.headers.get("content-length") ?? 0) > MAX_RECORD_BYTES) throw unread(tooBig);
        const file = new Uint8Array(await response.arrayBuffer().catch(failed));
        if (file.length > MAX_RECORD_BYTES) throw unread(tooBig);
        return file;
      },
    });
    return report(outcome, io);
  } catch (error) {
    io.error(messageOf(error));
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
