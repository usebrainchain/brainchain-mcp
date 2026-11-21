import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { parseMandate, type Mandate } from "../src/mandate.ts";
import { pretradeCheck, type Registry } from "../src/request.ts";
import { runLocally } from "../src/sandbox.ts";
import type { SignedQuote } from "../src/zerox.ts";

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const MANDATE = parseMandate(read("../fixtures/mandate.json"));
const recorded = (name: string): { trade: string; quote: SignedQuote; registry: Registry } => read(`../fixtures/quotes/${name}.json`);

async function check(name: string, change: { mandate?: Partial<Mandate>; quote?: Partial<SignedQuote>; registry?: Partial<Registry>; result?: (r: string) => string } = {}) {
  const { trade, quote, registry } = recorded(name);
  const request = pretradeCheck({ quote: { ...quote, ...change.quote }, registry: { ...registry, ...change.registry }, mandate: parseMandate({ ...MANDATE, ...change.mandate }), trade });
  const run = await runLocally({ ...request, result: change.result ? change.result(request.result) : request.result });
  const lines = run.output.split("\n");
  return { run, failed: lines.filter((l) => l.startsWith("FAIL")).map((l) => /^FAIL {2}([^:]+):/.exec(l)![1]), passed: lines.filter((l) => l.startsWith("pass")).length, output: run.output };
}

// Each recorded quote is 0x's response as bought on 2026-11-21, so these runs check real signatures and real calldata.
describe("the checks, on 0x's recorded quotes, as BrainChain's sandbox runs them", { timeout: 60_000 }, () => {
  it.each(["inside", "native"])("pass every rule for the %s trade", async (name) => {
    const { run, failed, passed } = await check(name);
    expect(failed).toEqual([]);
    expect(passed).toBe(12);
    expect(run.outcome).toBe("passed");
  });

  it.each([
    ["outside", "tokens"],
    ["minimum", "minimum out"],
    ["size", "size"],
    ["tampered", "signature"],
  ])("fail the %s trade on %s alone", async (name, rule) => {
    const { run, failed } = await check(name);
    expect(failed).toEqual([rule]);
    expect(run.outcome).toBe("failed");
    expect(run.error).toBe(`AssertionError: the trade breaks the mandate: ${rule}`);
  });

  it("read the trade back in the mandate's units", async () => {
    const { output } = await check("inside");
    expect(output).toContain("Trade: sell 5 USDG for at least 0.003072049707352334 WETH (0x quoted 0.003087487143067672 WETH)");
    expect(output).toContain("pass  minimum out: the trade reverts unless it pays at least 0.003072049707352334 WETH, 50.0 bps under 0x's quote, within the mandate's 100");
  });

  it("fail a delivery that runs code of its own", async () => {
    const { failed, output } = await check("inside", { result: (r) => r.replace("DELIVERY = {", "import hashlib\nDELIVERY = {") });
    expect(failed).toEqual(["delivery"]);
    expect(output).toContain("defines DELIVERY, hashlib, where only DELIVERY is allowed");
  });

  it("fail a quote received more than a minute after it was signed", async () => {
    const { quote } = recorded("inside");
    expect(await check("inside", { quote: { receivedAt: quote.receivedAt + 61 } }).then((c) => c.failed)).toEqual(["fresh"]);
  });

  it("fail a quote signed after the mandate ran out", async () => {
    expect(await check("inside", { mandate: { validUntil: "2026-11-01T00:00:00Z" } }).then((c) => c.failed)).toEqual(["deadline"]);
  });

  it("fail a trade that pays out to anyone but the mandate's recipient", async () => {
    expect(await check("inside", { mandate: { recipient: "0x000000000000000000000000000000000000dEaD" } }).then((c) => c.failed)).toEqual(["recipient"]);
  });

  it("fail a trade for another wallet or chain", async () => {
    expect(await check("inside", { mandate: { wallet: "0x000000000000000000000000000000000000dEaD", chain: 8453 } }).then((c) => c.failed)).toEqual(["chain", "wallet"]);
  });

  it("fail a Settler the registry did not name, and a registry read at another block", async () => {
    const { failed, output } = await check("inside", { registry: { block: 119510000, settler: "0x000000000000000000000000000000000000dEaD", previous: "0x000000000000000000000000000000000000dEaD" } });
    expect(failed).toEqual(["contract"]);
    expect(output).toContain("which is not the Settler 0x's registry named; the registry was read at block 119510000, not at the quote's block 119510614");
  });

  it("fail a fee added to the request, which also breaks 0x's signature over it", async () => {
    const { quote } = recorded("inside");
    const query = `${quote.request.query}&swapFeeRecipient=0x000000000000000000000000000000000000dEaD&swapFeeBps=25`;
    expect(await check("inside", { quote: { request: { ...quote.request, query } } }).then((c) => c.failed)).toEqual(["signature", "fees"]);
  });

  it("refuse a delivery that is missing a field, with the field named", async () => {
    const { output, run } = await check("inside", { result: (r) => r.replace(/ {8}"signature": "sig=:[^"]+",\n/, "") });
    expect(run.outcome).toBe("failed");
    expect(output).toContain("FAIL  delivery: DELIVERY['response'] has no 'signature'");
  });
});
