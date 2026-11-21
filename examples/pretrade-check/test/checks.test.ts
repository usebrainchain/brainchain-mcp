import { describe, expect, it } from "vitest";

import { parseMandate, type Mandate } from "../src/mandate.ts";
import { checksFor, DELIVERY_FORM, deliveryCode, deliveryJson, pretradeCheck, type Registry } from "../src/request.ts";
import { pythonBlocks, ruleLines, runLocally } from "../src/sandbox.ts";
import { parseQuery, type SignedQuote } from "../src/zerox.ts";

import { forgedSignature, MANDATE, recorded, sha512Bypass, tamperRoute } from "./helpers.ts";

async function check(name: string, change: { mandate?: Partial<Mandate>; quote?: Partial<SignedQuote>; registry?: Partial<Registry>; result?: (r: string) => string } = {}) {
  const { trade, quote, registry } = recorded(name);
  const request = pretradeCheck({ quote: { ...quote, ...change.quote }, registry: { ...registry, ...change.registry }, mandate: parseMandate({ ...MANDATE, ...change.mandate }), trade });
  const run = await runLocally({ ...request, result: change.result ? change.result(request.result) : request.result });
  const lines = ruleLines(run.output);
  return { run, failed: lines.filter((l) => l.startsWith("FAIL")).map((l) => /^FAIL {2}([^:]+):/.exec(l)![1]), passed: lines.filter((l) => l.startsWith("pass")).length, output: run.output };
}

const block = (code: string) => (result: string) => result.replace(/```python\n[\s\S]*?\n```/, `\`\`\`python\n${code}\n\`\`\``);
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

// Each recorded quote is 0x's response as bought on 2026-11-21, so these runs check real signatures and real calldata.
describe("the checks, on 0x's recorded quotes, as BrainChain's sandbox runs them", { timeout: 60_000 }, () => {
  it.each(["inside", "native"])("pass every rule for the %s trade", async (name) => {
    const { run, failed, passed } = await check(name);
    expect(failed).toEqual([]);
    expect(passed).toBe(13);
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

  it("read a zero previous Settler as none, and never count the zero address as a Settler", async () => {
    const { registry } = recorded("inside");
    expect(await check("inside", { registry: { previous: "0x0000000000000000000000000000000000000000" } }).then((c) => c.failed)).toEqual([]);
    expect(await check("inside", { registry: { settler: "0x0000000000000000000000000000000000000000", previous: registry.previous } }).then((c) => c.failed)).toEqual(["contract"]);
  });

  it("fail a fee added to the request by its name, which also breaks 0x's signature over it", async () => {
    const { quote } = recorded("inside");
    const query = `${quote.request.query}&swapFeeRecipient=0x000000000000000000000000000000000000dEaD&swapFeeBps=25`;
    const { failed, output } = await check("inside", { quote: { request: { ...quote.request, query } } });
    expect(failed).toEqual(["signature", "query", "fees"]);
    expect(output).toContain("FAIL  query: it asks for swapFeeRecipient, which the checks do not allow; it asks for swapFeeBps, which the checks do not allow");
  });
});

describe("the request's query, read strictly by both sides", { timeout: 60_000 }, () => {
  const queries = [
    recorded("inside").quote.request.query,
    "?chainId=4663&chainId=8453&sellToken=0x1&buyToken=0x2&sellAmount=1&taker=0x3",
    "?chainId=4663&sellToken=0x1&buyToken=0x2&sellAmount=1&taker=0x%33",
    "?chainId=4663&sellToken=0x1&buyToken=0x2&sellAmount=1&taker=0x3&recipient=0x4",
    "?chainId=4663&sellToken=0x1&buyToken=0x2&sellAmount=1",
    "chainId=4663",
    "?chainId=4663&&sellToken=0x1&buyToken=0x2&sellAmount=1&taker=0x3",
  ];

  it("gives the same values and problems in the client and in the checks", async () => {
    const definitions = checksFor(MANDATE).split("\n_run(")[0];
    const code = `${definitions}\nimport json as __j\nfor __q in ${JSON.stringify(queries)}:\n    __v, __n, __p = _query(__q)\n    print(__j.dumps({"values": __v, "problems": __p}))`;
    const run = await runLocally({ result: "```python\nDELIVERY = \"\"\n```", checks: { language: "python", code } });
    expect(run.outcome).toBe("passed");
    const python = run.output.trim().split("\n").map((line) => JSON.parse(line));
    expect(python).toEqual(queries.map((q) => ({ values: parseQuery(q).values, problems: parseQuery(q).problems })));
    expect(python[1].problems).toEqual(["it names chainId twice"]);
    expect(python[2].problems).toEqual(["'taker=0x%33' is not a name=value pair of letters and digits", "it has no taker"]);
  });
});

describe("the delivery, which is data and nothing else", { timeout: 60_000 }, () => {
  it("is one line assigning one base64 string to DELIVERY, holding the quote byte for byte", () => {
    for (const name of ["inside", "native", "outside", "minimum", "size", "tampered"]) {
      const { trade, quote, registry } = recorded(name);
      const blocks = pythonBlocks(pretradeCheck({ quote, registry, mandate: MANDATE, trade }).result);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toMatch(DELIVERY_FORM);
      const json = Buffer.from(/"(.*)"/.exec(blocks[0]!)![1]!, "base64").toString("utf8");
      expect(JSON.parse(json).response.body).toBe(quote.response.body);
    }
  });

  it.each([
    ["a dict", 'DELIVERY = {"request": {}}', "DELIVERY is a dict, not a string"],
    ["missing", "OTHER = 1", "DELIVERY is missing, not a string"],
    ["not base64", 'DELIVERY = "not base64!"', "DELIVERY is not base64 of JSON"],
    ["not JSON", `DELIVERY = "${b64("{")}"`, "DELIVERY is not base64 of JSON"],
    ["a key twice", `DELIVERY = "${b64('{"request": 1, "request": 2}')}"`, "DELIVERY is not base64 of JSON: 'request' appears twice"],
    ["NaN", `DELIVERY = "${b64('{"receivedAt": NaN}')}"`, "DELIVERY is not base64 of JSON: NaN is not JSON"],
  ])("fails a DELIVERY that is %s", async (_case, code, why) => {
    const { run, output } = await check("inside", { result: block(code) });
    expect(run.outcome).toBe("failed");
    expect(output).toContain(`FAIL  delivery: ${why}`);
  });

  it("fails a delivery with a field missing or one the checks do not read, naming it", async () => {
    const { quote, registry } = recorded("inside");
    const delivery = JSON.parse(deliveryJson(quote, registry));
    const without = structuredClone(delivery);
    delete without.response.signature;
    expect((await check("inside", { result: block(`DELIVERY = "${b64(JSON.stringify(without))}"`) })).output).toContain("FAIL  delivery: DELIVERY['response'] has no 'signature'");
    const extra = { ...delivery, note: "x" };
    expect((await check("inside", { result: block(`DELIVERY = "${b64(JSON.stringify(extra))}"`) })).output).toContain("FAIL  delivery: DELIVERY has 'note', which the checks do not read");
  });

  // A dict subclass can serve the signature check the genuine body and the rules a forged one. The checks read only a
  // string, so no object the delivery made is ever indexed.
  it("fails a delivery that is a dict subclass, before any of its reads", async () => {
    const { quote, registry } = recorded("inside");
    const code = [
      "class Served(dict):",
      "    def __getitem__(self, key):",
      "        return dict.__getitem__(self, key)",
      `DELIVERY = Served(__import__("json").loads(__import__("base64").b64decode("${b64(deliveryJson(quote, registry))}")))`,
    ].join("\n");
    const { run, output } = await check("inside", { result: block(code) });
    expect(run.outcome).toBe("failed");
    expect(output).toContain("FAIL  delivery: DELIVERY is a Served, not a string");
  });

  // Code that runs before the checks can patch any module they import, so this run passes. Only verify, which reads
  // the block from the record, refuses it for not being data.
  it("passes a block that patches sha512 first, which only verify refuses", async () => {
    const { quote, registry } = recorded("inside");
    const forged = forgedSignature(tamperRoute(quote));
    const { run, failed } = await check("inside", { result: block(sha512Bypass(deliveryCode(forged, registry))) });
    expect(failed).toEqual([]);
    expect(run.outcome).toBe("passed");
    const honest = await check("inside", { quote: forged });
    expect(honest.failed).toEqual(["signature"]);
  });
});
