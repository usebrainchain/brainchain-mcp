import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { keccak256 } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";

import type { Verdict } from "../src/desk.ts";
import { check, confirm, gate, recordName, sha256, type Delivery, type GradeRequest } from "../src/gate.ts";
import { loadAccount, main, type Io } from "../src/main.ts";

import { answer, mockDesk } from "./helpers.ts";

const fixture = (path: string) => fileURLToPath(new URL(`../fixtures/${path}`, import.meta.url));
const delivery = async (name: string): Promise<Delivery> => JSON.parse(await readFile(fixture(`deliveries/${name}.json`), "utf8")) as Delivery;
const order = { brief: "An hourly weather forecast for Berlin on 29 November 2026, as JSON." };
const DESK = "https://brain.usebrainchain.com";
const GRADE = `0x${"12".repeat(32)}`;

/** A grade record as the desk publishes it, and the URL it is published under. */
function published(request: GradeRequest, options: { result?: string; grade?: string } = {}) {
  const state = JSON.stringify({ result: options.result ?? request.result, task: { brief: request.brief } });
  const file = new TextEncoder().encode(JSON.stringify({ answer: "accept", kind: "grade", request: { state }, subject: BigInt(options.grade ?? GRADE).toString() }));
  return { file, url: `${DESK}/records/${keccak256(file)}.json#evidence=0x${"ab".repeat(32)}` };
}

const verdict = (accepted: boolean, record?: string): Verdict => ({
  grade: GRADE,
  state: "graded",
  status: `${DESK}/x402/grades/${GRADE}`,
  accepted,
  passProbability: accepted ? 0.94 : 0.08,
  bar: 0.8,
  ...(record ? { decision: { id: "812", record, page: "https://usebrainchain.com/decision?id=812" } } : {}),
});

async function allowed(name = "asked") {
  const checked = check(await delivery(name), order);
  if (!checked.ok) throw new Error(checked.why);
  return checked;
}

describe("check", () => {
  it("passes the asked-for forecast on as the exact bytes Wormhole hashed", async () => {
    const asked = await delivery("asked");
    const checked = await allowed();
    expect(checked.receipt.resource_digest).toBe(sha256(new TextEncoder().encode(asked.response.bodyText)));
    expect(checked.request).toEqual({ ...order, result: asked.response.bodyText });
  });

  it("passes a forecast for another city too: Wormhole checks the quote, not the brief", async () => {
    expect(check(await delivery("another-city"), order).ok).toBe(true);
  });

  it("refuses a second 402 and an error page before anything is paid", async () => {
    expect(check(await delivery("charged-again"), order)).toMatchObject({ ok: false, why: expect.stringContaining("X402-402") });
    expect(check(await delivery("error-page"), order)).toMatchObject({ ok: false, why: expect.stringContaining("X402-403") });
    expect(check(await delivery("charged-again"), order)).not.toHaveProperty("ungraded");
  });

  it("marks what it cannot grade as ungraded rather than wrong", () => {
    const binary: Delivery = { quote: { mimeType: "application/octet-stream" }, response: { status: 200, contentType: "application/octet-stream", bodyBase64: Buffer.from([0xff, 0xfe, 0x00, 0x81, 0x9c]).toString("base64") } };
    expect(check(binary, order)).toMatchObject({ ok: false, ungraded: true, why: expect.stringContaining("not UTF-8") });
    const big: Delivery = { quote: {}, response: { status: 200, contentType: "text/plain", bodyText: "a".repeat(100_001) } };
    expect(check(big, order)).toMatchObject({ ok: false, ungraded: true, why: expect.stringContaining("100,000") });
    const blank: Delivery = { quote: {}, response: { status: 200, contentType: "text/plain", bodyText: " \n " } };
    expect(check(blank, order)).toMatchObject({ ok: false, ungraded: true, why: "the delivery is blank" });
  });

  it("keeps a byte order mark, so the result still hashes to Wormhole's digest", () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("Berlin, 2.1 C at midnight")]);
    const checked = check({ quote: {}, response: { status: 200, contentType: "text/plain", bodyBase64: bytes.toString("base64") } }, order);
    if (!checked.ok) throw new Error(checked.why);
    expect(sha256(Buffer.from(checked.request.result, "utf8"))).toBe(checked.receipt.resource_digest);
  });

  it("carries the verify receipt's request_digest into the delivery receipt", async () => {
    expect(check({ ...(await delivery("asked")), request_digest: "rd-1" }, order).receipt?.request_digest).toBe("rd-1");
  });
});

describe("the record", () => {
  it("is named only by a URL on the desk, with nothing but an evidence hash after it", () => {
    const hash = `0x${"cd".repeat(32)}`;
    expect(recordName(`${DESK}/records/${hash}.json`, DESK)).toBe(hash);
    expect(recordName(`${DESK}/records/${hash}.json#evidence=0x${"ab".repeat(32)}`, DESK)).toBe(hash);
    for (const url of [`https://elsewhere.test/records/${hash}.json`, `${DESK}/records/${hash}.json?x=1`, `${DESK}/records/${hash}.json#other`, `${DESK}/records/${hash}.txt`, "not a url"]) {
      expect(recordName(url, DESK)).toBeUndefined();
    }
  });

  it("holds the bytes Wormhole hashed when the grade passed them on unchanged", async () => {
    const checked = await allowed();
    const { file, url } = published(checked.request);
    expect(confirm(checked.receipt, verdict(true, url), recordName(url, DESK)!, file)).toBeUndefined();
  });

  it("does not match when its result differs by one character", async () => {
    const checked = await allowed();
    const { file, url } = published(checked.request, { result: checked.request.result.replace("Berlin", "Berlim") });
    expect(confirm(checked.receipt, verdict(true, url), recordName(url, DESK)!, file)).toContain("SHA-256");
  });

  it("does not match when it is not the file its URL names", async () => {
    const checked = await allowed();
    const { url } = published(checked.request);
    const other = published({ ...checked.request, brief: "something else" }).file;
    expect(confirm(checked.receipt, verdict(true, url), recordName(url, DESK)!, other)).toContain("keccak256");
  });

  it("does not match when it is another grade's", async () => {
    const checked = await allowed();
    const { file, url } = published(checked.request, { grade: `0x${"34".repeat(32)}` });
    expect(confirm(checked.receipt, verdict(true, url), recordName(url, DESK)!, file)).toBe(`the record is not grade ${GRADE}'s`);
  });
});

describe("recorded on mainnet", () => {
  it("the accepted forecast's record holds the bytes Wormhole hashed", async () => {
    const checked = await allowed();
    const recorded = JSON.parse(await readFile(fixture("recorded/asked.json"), "utf8")) as Verdict;
    expect(recorded.accepted).toBe(true);
    const name = recordName(recorded.decision!.record, DESK)!;
    expect(confirm(checked.receipt, recorded, name, new Uint8Array(await readFile(fixture(`records/${recorded.decision!.id}.json`))))).toBeUndefined();
  });

  it("the forecast for another city was rejected", async () => {
    const recorded = JSON.parse(await readFile(fixture("recorded/another-city.json"), "utf8")) as Verdict;
    expect(recorded.accepted).toBe(false);
  });
});

describe("gate", () => {
  it("uses the delivery when both pass and the record holds the same bytes", async () => {
    let record: { file: Uint8Array; url: string } | undefined;
    const outcome = await gate(await allowed(), {
      desk: DESK,
      grade: async (request) => {
        record = published(request);
        return verdict(true, record.url);
      },
      record: async (url) => {
        expect(url).toBe(record!.url);
        return record!.file;
      },
    });
    expect(outcome.use).toBe(true);
  });

  it("does not use a delivery BrainChain rejects, and reads no record", async () => {
    const record = vi.fn();
    const outcome = await gate(await allowed("another-city"), { desk: DESK, grade: async () => verdict(false), record });
    expect(outcome).toMatchObject({ use: false, why: expect.stringContaining("rejected") });
    expect(outcome).not.toHaveProperty("ungraded");
    expect(record).not.toHaveBeenCalled();
  });

  it("never fetches a record from anywhere but the desk", async () => {
    const record = vi.fn();
    const outcome = await gate(await allowed(), { desk: DESK, grade: async () => verdict(true, `https://elsewhere.test/records/0x${"cd".repeat(32)}.json`), record });
    expect(outcome).toMatchObject({ use: false, why: expect.stringContaining("not a decision record") });
    expect(record).not.toHaveBeenCalled();
  });

  it("does not use an accepted delivery whose record holds other bytes", async () => {
    const outcome = await gate(await allowed(), {
      desk: DESK,
      grade: async (request) => verdict(true, published(request).url),
      record: async () => published({ ...order, result: "{}" }).file,
    });
    expect(outcome).toMatchObject({ use: false, why: expect.stringContaining("keccak256") });
  });
});

describe("main", () => {
  const io = (overrides: Partial<Io> = {}) => {
    const lines: string[] = [];
    const errors: string[] = [];
    const value: Io = {
      log: (line) => lines.push(line),
      error: (line) => errors.push(line),
      fetch: vi.fn() as unknown as typeof fetch,
      env: {},
      account: async () => {
        throw new Error("no key in tests");
      },
      now: () => new Date("2026-11-28T12:00:00Z"),
      pollMs: 1,
      ...overrides,
    };
    return { io: value, lines, errors };
  };
  const brief = fixture("brief.txt");

  it("runs the samples free: two stop at Wormhole, and the recorded grades tell the other two apart", async () => {
    const { io: sampleIo, lines } = io();
    expect(await main(["--sample"], sampleIo)).toBe(0);
    const text = lines.join("\n");
    expect(text.match(/goes to BrainChain's grade/g)).toHaveLength(2);
    expect(text.match(/nothing is paid to BrainChain/g)).toHaveLength(2);
    expect(text).toContain("BrainChain accepted it");
    expect(text).toContain("BrainChain rejected it");
    expect(text).toContain("holds the same bytes");
  });

  it("asks BrainChain's price on a dry run without paying", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 402, headers: { "payment-required": Buffer.from(JSON.stringify({ accepts: [{ network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: "250000" }] })).toString("base64") } }));
    const { io: dryIo, lines } = io({ fetch: fetchMock as unknown as typeof fetch });
    expect(await main(["--dry", "--delivery", fixture("deliveries/asked.json"), "--brief", brief], dryIo)).toBe(0);
    expect(lines.join("\n")).toContain("0.25 USDC on Base");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).has("payment-signature")).toBe(false);
  });

  it("exits 2 on a delivery Wormhole refuses, before reading any key or paying", async () => {
    const account = vi.fn();
    const fetchMock = vi.fn();
    const { io: refusedIo, lines } = io({ account, fetch: fetchMock as unknown as typeof fetch });
    expect(await main(["--delivery", fixture("deliveries/charged-again.json"), "--brief", brief], refusedIo)).toBe(2);
    expect(account).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(lines[0]).toMatch(/^Wormhole: refuse, HTTP 402, 44 bytes, SHA-256 [0-9a-f]{64}, X402-402$/);
    expect(lines.slice(1)).toEqual(["Do not use the delivery: Wormhole refused the delivery (X402-402)."]);
  });

  it("refuses --sample with other flags, which it would ignore", async () => {
    const { io: mixedIo, errors } = io();
    expect(await main(["--sample", "--dry"], mixedIo)).toBe(1);
    expect(errors[0]).toBe("--sample takes no other flags.");
  });

  it("prints the usage and exits 1 with no arguments", async () => {
    const { io: bareIo, lines } = io();
    expect(await main([], bareIo)).toBe(1);
    expect(lines[0]).toMatch(/^Usage:/);
  });

  it("refuses a body given twice or base64 that is not base64", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wormhole-delivery-"));
    const twice = join(dir, "twice.json");
    const bad = join(dir, "bad.json");
    await writeFile(twice, JSON.stringify({ quote: {}, response: { status: 200, bodyText: "a", bodyBase64: "YQ==" } }));
    await writeFile(bad, JSON.stringify({ quote: {}, response: { status: 200, bodyBase64: "!!!not base64!!!" } }));
    for (const [file, message] of [[twice, "give the body once"], [bad, "is not base64"]] as const) {
      const { io: badIo, errors } = io();
      expect(await main(["--delivery", file, "--brief", brief], badIo)).toBe(1);
      expect(errors[0]).toContain(message);
    }
  });

  it("says nothing was paid when the desk does not answer a dry run", async () => {
    const { io: downIo, errors } = io({ fetch: vi.fn(async () => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch });
    expect(await main(["--dry", "--delivery", fixture("deliveries/asked.json"), "--brief", brief], downIo)).toBe(1);
    expect(errors).toEqual(["BrainChain did not answer: fetch failed. Nothing was paid to BrainChain."]);
  });

  it("exits 1 on a delivery it cannot grade", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wormhole-delivery-"));
    const file = join(dir, "big.json");
    await writeFile(file, JSON.stringify({ quote: {}, response: { status: 200, contentType: "text/plain", bodyText: "a".repeat(100_001) } }));
    const { io: bigIo, lines } = io();
    expect(await main(["--delivery", file, "--brief", brief], bigIo)).toBe(1);
    expect(lines.at(-1)).toMatch(/^Not graded: /);
  });

  it("refuses a brief that is not UTF-8 before anything else", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wormhole-delivery-"));
    const file = join(dir, "brief.txt");
    await writeFile(file, Buffer.from("\uFEFFBerlin forecast", "utf16le"));
    const { io: badIo, errors } = io();
    expect(await main(["--dry", "--delivery", fixture("deliveries/asked.json"), "--brief", file], badIo)).toBe(1);
    expect(errors).toEqual([`${file} is not UTF-8 text.`]);
  });

  it("says the grade was paid for when the record cannot be read", async () => {
    let gradeId = "";
    const fetchMock = mockDesk(
      DESK,
      (id) => {
        gradeId = id;
        return answer(200, { ...verdict(true, `${DESK}/records/0x${"cd".repeat(32)}.json`), grade: id });
      },
      [],
      async () => {
        throw new TypeError("fetch failed");
      },
    );
    const account = privateKeyToAccount(generatePrivateKey());
    const { io: paidIo, lines, errors } = io({ fetch: fetchMock as unknown as typeof fetch, account: async () => account });
    expect(await main(["--delivery", fixture("deliveries/asked.json"), "--brief", brief], paidIo)).toBe(1);
    expect(gradeId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(lines.slice(0, 2)).toEqual(["Wormhole: allow, HTTP 200, 1274 bytes, SHA-256 6a89ab3304ef393addb9df08f9e7b8264619d8b77c2843d55705c2f9596b21b7", `Paying from ${account.address}.`]);
    expect(errors).toEqual([`BrainChain accepted the work, but its record ${DESK}/records/0x${"cd".repeat(32)}.json could not be read (fetch failed). Reading it again is free; running this again pays for another grade.`]);
  });

  it("reads only a key file its owner alone can read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wormhole-delivery-"));
    const file = join(dir, "payer.key");
    await writeFile(file, generatePrivateKey());
    await chmod(file, 0o644);
    await expect(loadAccount(file)).rejects.toThrow("Run chmod 600 on it first.");
    await chmod(file, 0o600);
    await expect(loadAccount(file)).resolves.toHaveProperty("address");
    await expect(loadAccount(undefined)).rejects.toThrow(/^Set BRAINCHAIN_PAYER_KEY_FILE/);
    await expect(loadAccount(dir)).rejects.toThrow("which is not a file.");
  });
});
