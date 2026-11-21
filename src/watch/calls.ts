import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createPublicClient, getAddress, http, parseAbiItem, toHex, type PublicClient } from "viem";

import { parseCall, type IndexedCall } from "../calls.js";
import { parseJsonl } from "../dataset/format.js";

export const BRAIN_URL = "https://brain.usebrainchain.com";
export const BRAINCHAIN_RPC = "https://rpc.usebrainchain.com";
export const CALLS_EVERY_MS = 60_000;

const GRADE = 2;
const RECORDED = parseAbiItem("event Recorded(uint256 indexed id, uint8 indexed kind, bytes32 indexed subject, bytes32 inputHash, bytes32 answer, uint16 confidenceBps, bytes32 payloadHash, string payloadURI)");
const SPAN = 10_000n;
const MAX_RECORD_BYTES = 2_000_000;

type Reader = Pick<PublicClient, "getBlockNumber" | "getLogs" | "getBlock">;

export interface CallIndexOptions {
  dir: string;
  brain?: string;
  /** Reads BrainChain's own chain; a test passes its own. */
  client?: Reader;
  fetch?: typeof fetch;
  say?: (line: string) => void;
}

interface Checkpoint {
  /** The last block read on each DecisionLog: the active set's and every one read before a set switch. */
  logs: Record<string, number>;
}

/**
 * The calls made with brainchain_call, read from BrainChain's DecisionLog rather than sent in, so a caller cannot leave a
 * call out: every grade recorded there whose brief holds a call is kept, with the wallet that paid for it, in
 * `calls.jsonl` beside the log. A first start begins at the chain's head. A record that cannot be read stops the read, and
 * the next one starts again at the span that held it, so no call is ever passed over.
 */
export class CallIndex {
  private readonly path: string;
  private readonly checkpointPath: string;
  private readonly brain: string;
  private readonly client: Reader;
  private readonly fetchImpl: typeof fetch;
  private readonly calls: IndexedCall[] = [];
  private readonly grades = new Set<string>();
  private checkpoint: Checkpoint;
  private reading = false;
  private timer?: NodeJS.Timeout;
  lastError?: string;

  constructor(private readonly options: CallIndexOptions) {
    this.path = join(options.dir, "calls.jsonl");
    this.checkpointPath = join(options.dir, "calls.checkpoint.json");
    this.brain = (options.brain ?? BRAIN_URL).replace(/\/$/, "");
    this.client = options.client ?? createPublicClient({ transport: http(BRAINCHAIN_RPC, { timeout: 20_000, retryCount: 2 }) });
    this.fetchImpl = options.fetch ?? fetch;
    for (const call of existsSync(this.path) ? parseJsonl<IndexedCall>(readFileSync(this.path, "utf8")) : []) this.keep(call);
    this.checkpoint = existsSync(this.checkpointPath) ? (JSON.parse(readFileSync(this.checkpointPath, "utf8")) as Checkpoint) : { logs: {} };
  }

  private keep(call: IndexedCall): boolean {
    if (this.grades.has(call.grade)) return false;
    this.grades.add(call.grade);
    this.calls.push(call);
    return true;
  }

  private save(): void {
    writeFileSync(`${this.checkpointPath}.next`, `${JSON.stringify(this.checkpoint)}\n`);
    renameSync(`${this.checkpointPath}.next`, this.checkpointPath);
  }

  start(every = CALLS_EVERY_MS): void {
    void this.read();
    this.timer = setInterval(() => void this.read(), every);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /** The DecisionLog of the active set, from the brain's network manifest. */
  private async activeLog(): Promise<{ log: string; fromBlock: number }> {
    const response = await this.fetchImpl(`${this.brain}/network.json`, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`${new URL(this.brain).hostname}/network.json answered ${response.status}`);
    const { manifest } = (await response.json()) as { manifest?: { activeSet?: { fromBlock?: number; contracts?: { DecisionLog?: string } } } };
    const log = manifest?.activeSet?.contracts?.DecisionLog;
    if (!log) throw new Error("the network manifest names no DecisionLog");
    return { log: getAddress(log), fromBlock: manifest!.activeSet!.fromBlock ?? 0 };
  }

  /** Reads the DecisionLogs from where it stopped to the head, and keeps each call found. */
  async read(): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    try {
      const [{ log, fromBlock }, head] = await Promise.all([this.activeLog(), this.client.getBlockNumber()]);
      if (!(log in this.checkpoint.logs)) {
        // The first start begins now; a log that a set switch made active is read from its first block.
        this.checkpoint.logs[log] = Object.keys(this.checkpoint.logs).length === 0 ? Number(head) : fromBlock - 1;
        this.save();
      }
      for (const address of Object.keys(this.checkpoint.logs)) await this.readLog(address as `0x${string}`, head);
      delete this.lastError;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.options.say?.(`calls: ${this.lastError}; read again in a minute.`);
    } finally {
      this.reading = false;
    }
  }

  private async readLog(address: `0x${string}`, head: bigint): Promise<void> {
    for (let from = BigInt(this.checkpoint.logs[address]!) + 1n; from <= head; from += SPAN) {
      const to = from + SPAN - 1n < head ? from + SPAN - 1n : head;
      const logs = await this.client.getLogs({ address, event: RECORDED, args: { kind: GRADE }, fromBlock: from, toBlock: to });
      for (const entry of logs) {
        const call = await this.callOf(entry.args.payloadURI ?? "", String(entry.args.id), entry.blockNumber);
        if (call && this.keep(call)) appendFileSync(this.path, `${JSON.stringify(call)}\n`);
      }
      // Saved only once every record in the span was read: a span that fails is read again whole, and the calls already
      // kept from it are known by their grade.
      this.checkpoint.logs[address] = Number(to);
      this.save();
    }
  }

  /** The call a grade's record holds, or nothing. Only the brain's own records are read. */
  private async callOf(uri: string, decision: string, block: bigint): Promise<IndexedCall | undefined> {
    const record = uri.split("#")[0]!;
    if (!record.startsWith(`${this.brain}/records/`)) return undefined;
    const response = await this.fetchImpl(record, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`the record of decision ${decision} answered ${response.status}`);
    const text = await response.text();
    if (text.length > MAX_RECORD_BYTES) return undefined;
    const payload = JSON.parse(text) as { subject?: string; answer?: string; request?: { state?: string }; payments?: { payer?: string; network?: string; amount?: string }[] };
    const brief = String((JSON.parse(payload.request?.state ?? "{}") as { task?: { brief?: unknown } }).task?.brief ?? "");
    const call = parseCall(brief);
    const payment = payload.payments?.[0];
    if (!call || !payment?.payer || !payload.subject) return undefined;
    const { timestamp } = await this.client.getBlock({ blockNumber: block });
    return {
      grade: toHex(BigInt(payload.subject), { size: 32 }),
      decision,
      at: new Date(Number(timestamp) * 1000).toISOString(),
      payer: getAddress(payment.payer),
      network: payment.network ?? "",
      amount: payment.amount ?? "",
      ...call,
      answer: payload.answer === "accept" ? "accept" : "reject",
      record,
    };
  }

  /** A wallet's calls, oldest first. */
  of(caller: string): IndexedCall[] {
    return this.calls.filter((call) => call.payer.toLowerCase() === caller.toLowerCase());
  }

  get(grade: string): IndexedCall | undefined {
    return this.calls.find((call) => call.grade === grade.toLowerCase());
  }

  status(): Record<string, unknown> {
    return { calls: this.calls.length, through: this.checkpoint.logs, ...(this.lastError ? { lastError: this.lastError } : {}) };
  }
}
