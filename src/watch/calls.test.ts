import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { toHex } from "viem";
import { describe, expect, it } from "vitest";

import { CALL_HEADER } from "../calls.js";
import { CallIndex } from "./calls.js";

const BRAIN = "https://brain.example";
const LOG = "0x53e0137e45C8bAc1018802aD36060cDda3B159F0";
const PAYER = "0xFe4d9d7c5c530c9652A46D0BF6178b041Bc2F858";
const CASHCAT = "0x020bfC650A365f8BB26819deAAbF3E21291018b4";
const MANIFEST = "de49a2b06c4ec15d5e1d8ed3ec1cb2299210d6584b488f73ee227bc3ab1c615d";

const callBrief = `Work delivered outside BrainChain, sent in for a grade.\n\nTitle: BrainChain call\n\n${CALL_HEADER}\ntoken: ${CASHCAT}\noutcome: any\ndays: 30\ndataset: 2026-11-22 ${MANIFEST}\n\nThe caller calls ...`;

interface Entry {
  id: number;
  block: number;
  record: string;
}

function chain(entries: Entry[], head: { block: number }, records: Record<string, unknown>, failing = new Set<string>()) {
  const asked: [number, number][] = [];
  const client = {
    getBlockNumber: async () => BigInt(head.block),
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      asked.push([Number(fromBlock), Number(toBlock)]);
      return entries.filter((entry) => entry.block >= Number(fromBlock) && entry.block <= Number(toBlock)).map((entry) => ({ args: { id: BigInt(entry.id), payloadURI: entry.record }, blockNumber: BigInt(entry.block) }));
    },
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ timestamp: 1_795_000_000n + blockNumber }),
  };
  const fetchImpl = (async (url: string) => {
    if (url === `${BRAIN}/network.json`) return new Response(JSON.stringify({ manifest: { activeSet: { fromBlock: 2787, contracts: { DecisionLog: LOG } } } }));
    const key = url.split("#")[0]!;
    if (key.startsWith(`${BRAIN}/x402/grades/`)) return new Response(JSON.stringify({ state: "graded", accepted: true }));
    if (failing.has(key)) return new Response("busy", { status: 503 });
    return key in records ? new Response(JSON.stringify(records[key])) : new Response("missing", { status: 404 });
  }) as typeof fetch;
  return { client: client as never, fetch: fetchImpl, asked };
}

const record = (subject: bigint, brief: string, payer = PAYER) => ({ subject: subject.toString(), request: { state: JSON.stringify({ task: { brief }, result: "facts" }) }, payments: [{ payer, network: "eip155:4663", amount: "250000" }] });

describe("the call index", () => {
  it("starts at the head, then keeps every grade whose brief is a call, with its payer and time, and nothing else", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brainchain-calls-"));
    const head = { block: 4_000 };
    const entries: Entry[] = [
      { id: 1, block: 3_990, record: `${BRAIN}/records/0x01.json` },
      { id: 2, block: 4_010, record: `${BRAIN}/records/0x02.json#evidence=0xff` },
      { id: 3, block: 4_011, record: `${BRAIN}/records/0x03.json` },
      { id: 4, block: 4_012, record: "https://elsewhere.example/records/0x04.json" },
    ];
    const records = {
      [`${BRAIN}/records/0x01.json`]: record(1n, callBrief),
      [`${BRAIN}/records/0x02.json`]: record(2n, callBrief),
      [`${BRAIN}/records/0x03.json`]: record(3n, "Convert an ISO 8601 duration"),
      "https://elsewhere.example/records/0x04.json": record(4n, callBrief),
    };
    const { client, fetch } = chain(entries, head, records);
    const index = new CallIndex({ dir, brain: BRAIN, client, fetch });
    await index.read();
    expect(index.of(PAYER)).toEqual([]);
    head.block = 4_020;
    await index.read();
    const [call] = index.of(PAYER.toLowerCase());
    expect(index.of(PAYER)).toHaveLength(1);
    expect(call).toEqual({
      grade: toHex(2n, { size: 32 }),
      decision: "2",
      at: new Date((1_795_000_000 + 4_010) * 1000).toISOString(),
      payer: PAYER,
      network: "eip155:4663",
      amount: "250000",
      token: CASHCAT,
      outcome: "any",
      days: 30,
      dataset: { date: "2026-11-22", manifest: MANIFEST },
      accepted: true,
      record: `${BRAIN}/records/0x02.json`,
    });
    expect(index.get(toHex(2n, { size: 32 }).toUpperCase().replace("0X", "0x"))).toEqual(call);
    // A restart keeps the calls and the place it read to.
    const again = new CallIndex({ dir, brain: BRAIN, client, fetch });
    await again.read();
    expect(again.of(PAYER)).toEqual([call]);
    expect(readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("reads a span again whole when one of its records cannot be read, so no call is passed over", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brainchain-calls-"));
    const head = { block: 100 };
    const entries: Entry[] = [
      { id: 7, block: 110, record: `${BRAIN}/records/0x07.json` },
      { id: 8, block: 111, record: `${BRAIN}/records/0x08.json` },
    ];
    const failing = new Set([`${BRAIN}/records/0x08.json`]);
    const { client, fetch } = chain(entries, head, { [`${BRAIN}/records/0x07.json`]: record(7n, callBrief), [`${BRAIN}/records/0x08.json`]: record(8n, callBrief) }, failing);
    const said: string[] = [];
    const index = new CallIndex({ dir, brain: BRAIN, client, fetch, say: (line) => said.push(line) });
    await index.read();
    head.block = 120;
    await index.read();
    expect(index.of(PAYER)).toHaveLength(1);
    expect(said).toEqual(["calls: the record of decision 8 answered 503; read again in a minute."]);
    expect(index.status()).toMatchObject({ calls: 1, through: { [LOG]: 100 }, lastError: "the record of decision 8 answered 503" });
    failing.clear();
    await index.read();
    expect(index.of(PAYER).map((call) => call.decision)).toEqual(["7", "8"]);
    expect(index.status()).toEqual({ calls: 2, through: { [LOG]: 120 } });
  });

  it("pages every call in the order it kept them, and a restart keeps each call at its place", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brainchain-calls-"));
    const head = { block: 200 };
    const entries: Entry[] = [5, 6, 7].map((id) => ({ id, block: 200 + id, record: `${BRAIN}/records/0x0${id}.json` }));
    const records = Object.fromEntries(entries.map(({ id, record: uri }) => [uri, record(BigInt(id), callBrief, id === 6 ? CASHCAT : PAYER)]));
    const { client, fetch } = chain(entries, head, records);
    const index = new CallIndex({ dir, brain: BRAIN, client, fetch });
    await index.read();
    head.block = 210;
    await index.read();
    const first = index.page(0, 2);
    expect([first.calls.map((call) => call.decision), first.next, first.total]).toEqual([["5", "6"], 2, 3]);
    expect(index.page(first.next, 2)).toMatchObject({ calls: [{ decision: "7" }], next: 3, total: 3 });
    expect(index.page(3, 2)).toEqual({ calls: [], next: 3, total: 3 });
    const again = new CallIndex({ dir, brain: BRAIN, client, fetch });
    expect(again.page(0, 10)).toEqual(index.page(0, 10));
  });
});
