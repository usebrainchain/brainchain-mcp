import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { keccak256 } from "viem";
import { describe, expect, it, vi } from "vitest";

import type { Verdict } from "../src/desk.ts";
import { check, confirm, gate, sha256, type Delivery, type GradeRequest } from "../src/gate.ts";
import { main, type Io } from "../src/main.ts";

const fixture = (path: string) => fileURLToPath(new URL(`../fixtures/${path}`, import.meta.url));
const delivery = async (name: string): Promise<Delivery> => JSON.parse(await readFile(fixture(`deliveries/${name}.json`), "utf8")) as Delivery;
const order = { brief: "An hourly weather forecast for Berlin on 29 November 2026, as JSON." };
const DESK = "https://brain.usebrainchain.com";

/** A grade record as the desk publishes it, and the URL it is published under. */
function published(request: GradeRequest, result = request.result) {
  const file = new TextEncoder().encode(JSON.stringify({ answer: "accept", kind: "grade", request: { state: JSON.stringify({ result, task: { brief: request.brief } }) } }));
  return { file, url: `${DESK}/records/${keccak256(file)}.json#evidence=0x${"ab".repeat(32)}` };
}

const verdict = (accepted: boolean, record?: string): Verdict => ({
  grade: `0x${"12".repeat(32)}`,
  state: "graded",
  status: `${DESK}/x402/grades/0x${"12".repeat(32)}`,
  accepted,
  passProbability: accepted ? 0.94 : 0.08,
  bar: 0.6,
  ...(record ? { decision: { id: "812", record, page: "https://usebrainchain.com/decision?id=812" } } : {}),
});

describe("check", () => {
  it("passes the asked-for forecast on as the exact bytes Wormhole hashed", async () => {
    const asked = await delivery("asked");
    const checked = check(asked, order);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    const bytes = new TextEncoder().encode(asked.response.bodyText);
    expect(checked.receipt.resource_digest).toBe(sha256(bytes));
    expect(checked.request).toEqual({ ...order, result: asked.response.bodyText });
  });

  it("passes a forecast for another city too: Wormhole checks the quote, not the brief", async () => {
    expect(check(await delivery("another-city"), order).ok).toBe(true);
  });

  it("stops a second 402 and an error page before anything is paid", async () => {
    const again = check(await delivery("charged-again"), order);
    expect(again).toMatchObject({ ok: false, why: expect.stringContaining("X402-402") });
    const page = check(await delivery("error-page"), order);
    expect(page).toMatchObject({ ok: false, why: expect.stringContaining("X402-403") });
  });

  it("stops a body that is not UTF-8 text", () => {
    const binary: Delivery = { quote: { mimeType: "application/octet-stream" }, response: { status: 200, contentType: "application/octet-stream", bodyBase64: Buffer.from([0xff, 0xfe, 0x00, 0x81, 0x9c]).toString("base64") } };
    expect(check(binary, order)).toMatchObject({ ok: false, why: expect.stringContaining("not UTF-8") });
  });

  it("keeps a byte order mark, so the result still hashes to Wormhole's digest", () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("Berlin, 2.1 C at midnight")]);
    const checked = check({ quote: {}, response: { status: 200, contentType: "text/plain", bodyBase64: bytes.toString("base64") } }, order);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(sha256(Buffer.from(checked.request.result, "utf8"))).toBe(checked.receipt.resource_digest);
  });

  it("stops a delivery over BrainChain's 100,000 bytes", () => {
    const big: Delivery = { quote: {}, response: { status: 200, contentType: "text/plain", bodyText: "a".repeat(100_001) } };
    expect(check(big, order)).toMatchObject({ ok: false, why: expect.stringContaining("100,000") });
  });

  it("carries the verify receipt's request_digest into the delivery receipt", async () => {
    const checked = check({ ...(await delivery("asked")), request_digest: "rd-1" }, order);
    expect(checked.receipt?.request_digest).toBe("rd-1");
  });
});

describe("confirm", () => {
  it("finds the record holds the bytes Wormhole hashed", async () => {
    const checked = check(await delivery("asked"), order);
    if (!checked.ok) throw new Error(checked.why);
    const { file, url } = published(checked.request);
    expect(confirm(checked.receipt, url, file)).toBeUndefined();
  });

  it("refuses a record whose result differs by one character", async () => {
    const checked = check(await delivery("asked"), order);
    if (!checked.ok) throw new Error(checked.why);
    const { file, url } = published(checked.request, checked.request.result.replace("Berlin", "Berlim"));
    expect(confirm(checked.receipt, url, file)).toContain("SHA-256");
  });

  it("refuses a record that is not the file its URL names", async () => {
    const checked = check(await delivery("asked"), order);
    if (!checked.ok) throw new Error(checked.why);
    const { url } = published(checked.request);
    const other = published({ ...checked.request, brief: "something else" }).file;
    expect(confirm(checked.receipt, url, other)).toContain("keccak256");
  });

  it("refuses a URL that is not a record", async () => {
    const checked = check(await delivery("asked"), order);
    if (!checked.ok) throw new Error(checked.why);
    expect(confirm(checked.receipt, `${DESK}/x402/grades/0x12`, new Uint8Array())).toContain("not a decision record");
  });
});

describe("gate", () => {
  it("uses the delivery when both pass and the record holds the same bytes", async () => {
    let sent: GradeRequest | undefined;
    let record: { file: Uint8Array; url: string } | undefined;
    const outcome = await gate(await delivery("asked"), order, {
      grade: async (request) => {
        sent = request;
        record = published(request);
        return verdict(true, record.url);
      },
      record: async (url) => {
        expect(url).toBe(record!.url);
        return record!.file;
      },
    });
    expect(outcome.use).toBe(true);
    expect(sha256(Buffer.from(sent!.result, "utf8"))).toBe(outcome.receipt?.resource_digest);
  });

  it("does not use a delivery BrainChain rejects, and reads no record", async () => {
    const record = vi.fn();
    const outcome = await gate(await delivery("another-city"), order, { grade: async () => verdict(false), record });
    expect(outcome).toMatchObject({ use: false, why: expect.stringContaining("rejected") });
    expect(record).not.toHaveBeenCalled();
  });

  it("never pays for a delivery Wormhole refuses", async () => {
    const grade = vi.fn();
    const outcome = await gate(await delivery("charged-again"), order, { grade, record: vi.fn() });
    expect(outcome.use).toBe(false);
    expect(grade).not.toHaveBeenCalled();
  });

  it("does not use an accepted delivery whose record holds other bytes", async () => {
    const outcome = await gate(await delivery("asked"), order, {
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
      ...overrides,
    };
    return { io: value, lines, errors };
  };

  it("runs the samples free: two go to the grade, two stop at Wormhole", async () => {
    const { io: sampleIo, lines } = io();
    expect(await main(["--sample"], sampleIo)).toBe(0);
    const text = lines.join("\n");
    expect(text.match(/goes to BrainChain's grade/g)).toHaveLength(2);
    expect(text.match(/nothing is paid to BrainChain/g)).toHaveLength(2);
  });

  it("asks BrainChain's price on a dry run without paying", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 402, headers: { "payment-required": Buffer.from(JSON.stringify({ accepts: [{ network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: "250000" }] })).toString("base64") } }));
    const { io: dryIo, lines } = io({ fetch: fetchMock as unknown as typeof fetch });
    expect(await main(["--dry", "--delivery", fixture("deliveries/asked.json"), "--brief", fixture("brief.txt")], dryIo)).toBe(0);
    expect(lines.join("\n")).toContain("0.25 USDC on Base");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).has("payment-signature")).toBe(false);
  });

  it("exits 2 on a delivery Wormhole refuses, before reading any key", async () => {
    const account = vi.fn();
    const { io: refusedIo, lines } = io({ account });
    expect(await main(["--delivery", fixture("deliveries/charged-again.json"), "--brief", fixture("brief.txt")], refusedIo)).toBe(2);
    expect(account).not.toHaveBeenCalled();
    expect(lines.at(-1)).toContain("X402-402");
  });
});
