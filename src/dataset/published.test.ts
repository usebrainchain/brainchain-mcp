import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { jsonl, sha256, symbolBucket, type Manifest } from "./format.js";
import { datasetReader, DatasetError, MANIFEST_MS, PUBLISHED_URL } from "./published.js";

const TOKEN = "0x020bfC650A365f8BB26819deAAbF3E21291018b4";
const rates = { readAt: "2026-11-20T22:00:00.000Z", headBlock: 100, cut: "2026-11-20T21:59:00.000Z", kinds: [], pools: { piece: 10_000, counts: [], ends: [] } };

/** A dataset of one day as the build leaves it: its files and a manifest with each one's hash. */
function day(date: string, overrides: Record<string, string> = {}): Record<string, string> {
  const files: Record<string, string> = {
    "tokens.jsonl": jsonl([{ token: TOKEN, symbol: "CASHCAT", sources: ["KuCoin"], observedAt: rates.readAt }]),
    "events.jsonl": jsonl([{ token: TOKEN, step: "custody", source: "BitGo", at: "2026-07-28T07:09:00.000Z", atFrom: "push", observedAt: rates.readAt }]),
    "outcomes.jsonl": "",
    "base-rates.json": JSON.stringify(rates),
    [symbolBucket("CASHCAT")]: jsonl([{ symbol: "CASHCAT", token: TOKEN }, { symbol: "cashcat", token: "0x1111111111111111111111111111111111111111" }]),
  };
  const manifest: Manifest = { date, readAt: rates.readAt, headBlock: 100, files: Object.fromEntries(Object.entries(files).map(([path, text]) => [path, { sha256: sha256(text), rows: text.split("\n").filter(Boolean).length }])) };
  return { ...files, [`manifests/${date}.json`]: JSON.stringify(manifest), ...overrides };
}

function write(dir: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

describe("the published dataset", () => {
  it("reads the newest day in a directory, checks every file against its manifest, and names the manifest by its hash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "data-"));
    write(dir, day("2026-11-19"));
    write(dir, day("2026-11-20"));
    const read = await datasetReader(dir).load();
    expect(read.ref).toMatchObject({ source: "local directory", date: "2026-11-20", headBlock: 100, readAt: rates.readAt });
    expect(read.ref.manifest).toBe(sha256(day("2026-11-20")["manifests/2026-11-20.json"]!));
    expect(read.tokens).toHaveLength(1);
    expect(read.steps[0]).toMatchObject({ step: "custody" });
    expect(await datasetReader(dir).symbol("cashcat")).toHaveLength(2);
    expect(await datasetReader(dir).symbol("NOPE")).toEqual([]);
  });

  it("refuses a file that does not hash to its manifest entry, and a setting that is neither an address nor a full path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "data-"));
    write(dir, day("2026-11-20", { "events.jsonl": "{}\n" }));
    await expect(datasetReader(dir).load()).rejects.toThrow(/events.jsonl does not match the SHA-256 its manifest of 2026-11-20 gives/);
    expect(() => datasetReader("data/here")).toThrow(DatasetError);
    await expect(datasetReader(mkdtempSync(join(tmpdir(), "data-"))).load()).rejects.toThrow(/No dataset was published in the last 7 days at local directory, so there is nothing to count yet: counts appear once one is\. BRAINCHAIN_DATASET points the tools at a directory or another address that holds one\./);
  });

  it("looks for the newest manifest on GitHub a day at a time, and keeps what it found", async () => {
    const files = day("2026-11-19");
    const asked: string[] = [];
    let clock = Date.parse("2026-11-21T10:00:00Z");
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const path = String(input).slice(PUBLISHED_URL.length);
      asked.push(path);
      return path in files ? new Response(files[path]) : new Response("404: Not Found", { status: 404 });
    }) as typeof fetch;
    const reader = datasetReader(undefined, fetchImpl, () => clock);
    expect((await reader.load()).ref.date).toBe("2026-11-19");
    expect(asked.slice(0, 3)).toEqual(["manifests/2026-11-21.json", "manifests/2026-11-20.json", "manifests/2026-11-19.json"]);
    const count = asked.length;
    await reader.load();
    expect(asked).toHaveLength(count);
    clock += MANIFEST_MS + 1;
    await reader.load();
    expect(asked.length).toBeGreaterThan(count);
  });
});
