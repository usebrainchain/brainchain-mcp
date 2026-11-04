import { mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { dailyLedger } from "./daily.js";

// Slows chosen reads, so two processes judging the same stale lock can be lined up at will.
const slow = vi.hoisted(() => ({ lockStatMs: 0, recordReadMs: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  const later = <T>(ms: number, value: Promise<T>) => (ms ? value.finally(() => new Promise((r) => setTimeout(r, ms))) : value);
  return {
    ...fs,
    stat: ((file: string) => later(file.endsWith(".lock") ? slow.lockStatMs : 0, fs.stat(file))) as typeof fs.stat,
    readFile: ((file: string, options: "utf8") => later(file.endsWith(".json") ? slow.recordReadMs : 0, fs.readFile(file, options))) as typeof fs.readFile,
  };
});

const DAY = Date.parse("2026-11-02T12:00:00Z");

async function ledgerAt(limit: bigint) {
  const path = join(await mkdtemp(join(tmpdir(), "daily-")), "spend.json");
  const clock = { now: DAY };
  return { path, clock, ledger: dailyLedger(path, limit, () => clock.now) };
}

describe("daily ledger", () => {
  it("refuses what would pass the limit and starts again on the next UTC day", async () => {
    const { path, clock, ledger } = await ledgerAt(2n);
    expect(await ledger.reserve(1n)).toEqual({ day: "2026-11-02", amount: 1n });
    expect(await ledger.reserve(1n)).toBeDefined();
    expect(await ledger.reserve(1n)).toBeUndefined();
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ day: "2026-11-02", units: "2" });
    clock.now += 12 * 3_600_000;
    expect(await ledger.spentToday()).toBe(0n);
    expect(await ledger.reserve(2n)).toBeDefined();
  });

  it("frees a reservation only on the day it was made", async () => {
    const { clock, ledger } = await ledgerAt(5n);
    const kept = (await ledger.reserve(3n))!;
    await ledger.release(kept);
    expect(await ledger.spentToday()).toBe(0n);
    const yesterday = (await ledger.reserve(3n))!;
    clock.now += 24 * 3_600_000;
    await ledger.reserve(4n);
    await ledger.release(yesterday);
    expect(await ledger.spentToday()).toBe(4n);
  });

  it("stops paying when the record cannot be read", async () => {
    const { path, ledger } = await ledgerAt(5n);
    await writeFile(path, "{not json");
    await expect(ledger.reserve(1n)).rejects.toThrow(/cannot be read; fix or delete it/);
  });

  it("clears a lock left by a process that died", async () => {
    const { path, ledger } = await ledgerAt(5n);
    await writeFile(`${path}.lock`, "");
    const old = new Date(Date.now() - 60_000);
    await utimes(`${path}.lock`, old, old);
    expect(await ledger.reserve(1n)).toBeDefined();
  });

  it("gives a lock left by a process that died to one taker, when a second judged it stale just before", async () => {
    const { path, ledger } = await ledgerAt(1n);
    const other = dailyLedger(path, 1n, () => DAY);
    await writeFile(`${path}.lock`, "");
    const old = new Date(Date.now() - 60_000);
    await utimes(`${path}.lock`, old, old);
    // The second taker reads the stale lock's age while the first is about to clear it,
    // and acts on that reading only once the first holds a fresh lock.
    Object.assign(slow, { lockStatMs: 60, recordReadMs: 200 });
    try {
      const first = ledger.reserve(1n);
      await new Promise((r) => setTimeout(r, 30));
      const results = await Promise.all([first, other.reserve(1n)]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ day: "2026-11-02", units: "1" });
    } finally {
      Object.assign(slow, { lockStatMs: 0, recordReadMs: 0 });
    }
  });
});
