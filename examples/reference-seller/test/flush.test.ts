import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { describe, expect, it, vi } from "vitest";

import { writeJson } from "../src/files.ts";
import { JOB } from "../src/job.ts";
import type { Judge } from "../src/judge.ts";
import { createSeller, type Order } from "../src/seller.ts";

vi.mock("../src/files.ts", async (importOriginal) => {
  const files = await importOriginal<typeof import("../src/files.ts")>();
  return { ...files, writeJson: vi.fn(files.writeJson) };
});

const grade = `0x${"ab".repeat(32)}`;
const judge: Judge = {
  url: "https://brainchain.test",
  sign: async () => ({ url: "https://brainchain.test/x402/grades", body: "{}", headers: {}, grade, units: "250000", validBefore: "0" }),
  send: async (_signed, paid) => {
    await paid({ grade, status: `https://brainchain.test/x402/grades/${grade}`, units: "250000" });
    return { grade, accepted: true, passProbability: 0.91, bar: 0.8, decision: "https://brainchain.test/decision?id=1" };
  },
  read: async () => Promise.reject(new Error("a paid grade is never read here")),
  lapsed: async () => false,
};

describe("flushing a seller", () => {
  it("waits for the record of an order that has settled in memory and is still being written", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reference-seller-"));
    // The last save, the one that records the verdict, waits until the test lets it through.
    const { writeJson: write } = await vi.importActual<typeof import("../src/files.ts")>("../src/files.ts");
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.mocked(writeJson).mockImplementation(async (file, value) => {
      if ((value as Order).state === "accepted") await gate;
      return write(file, value);
    });

    const seller = await createSeller({ dir, judge, work: async () => "def week_start(text):\n    pass", log: () => {} });
    const { order } = await seller.order({ brief: "Write week_start.", tests: "assert True", levels: JOB.levels, pass: JOB.pass });
    await vi.waitFor(() => expect(seller.view(order)?.state).toBe("accepted"));
    const recorded = async () => (JSON.parse(await readFile(join(dir, "orders", `${order}.json`), "utf8")) as Order).state;
    expect(await recorded()).toBe("grading");

    let flushed = false;
    const flushing = seller.flush().then(() => (flushed = true));
    await sleep(20);
    expect(flushed).toBe(false);
    release();
    await flushing;
    expect(await recorded()).toBe("accepted");
    await rm(dir, { recursive: true, force: true });
  });
});
