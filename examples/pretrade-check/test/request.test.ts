import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseMandate, readMandate } from "../src/mandate.ts";
import { checksFor, CHECKS_TEMPLATE, deliveryCode, mandateText, MAX_CHECKS, MAX_PROGRAM, pretradeCheck, splitChecks } from "../src/request.ts";
import { programOf, runLocally } from "../src/sandbox.ts";

import { MANDATE, read, recorded } from "./helpers.ts";

const { trade, quote, registry } = recorded("inside");

describe("the grade request", () => {
  const request = pretradeCheck({ quote, registry, mandate: MANDATE, trade });

  it("fits the grade route with room to spare", () => {
    expect(request.checks.code.length).toBeLessThan(MAX_CHECKS * 0.7);
    expect(programOf(request).length).toBeLessThan(MAX_PROGRAM * 0.5);
    expect(request.brief.length).toBeLessThan(32_000);
    expect(request.title).toBe("Pre-trade check: sell 5 USDG for WETH on Robinhood Chain");
  });

  it("states every rule of the mandate in the brief, and the mandate itself in the checks", () => {
    expect(request.brief).toContain("- Most one trade may sell: 25 USDG, 0.01 WETH, 0.01 ETH.");
    expect(request.brief).toContain("- The guaranteed minimum out may be at most 100 basis points under 0x's quoted amount.");
    expect(request.checks.code).toContain(`"validUntil": "2026-12-31T23:59:59Z"`);
    // The brain shows checks as a fenced block, so a fence inside them would end it early.
    expect(CHECKS_TEMPLATE).not.toContain("```");
  });

  it("keeps URLs inside the code block, where BrainChain does not fetch them as citations", () => {
    expect(request.result.split("```")[0]).not.toMatch(/https?:\/\//);
  });

  it("passes the body to the sandbox byte for byte, whatever it holds", { timeout: 60_000 }, async () => {
    const body = '{"a":"quote \\" backslash \\\\ newline \\n","b":"é ü 中   😀","c":"\t"}';
    const odd = { ...quote, response: { ...quote.response, body } };
    const digest = createHash("sha256").update(body, "utf8").digest("hex");
    const run = await runLocally({
      result: `\`\`\`python\n${deliveryCode(odd, registry)}\n\`\`\``,
      checks: { language: "python", code: `import base64, hashlib, json\nbody = json.loads(base64.b64decode(DELIVERY))["response"]["body"]\nif hashlib.sha256(body.encode("utf-8")).hexdigest() != "${digest}":\n    raise AssertionError(body)` },
    });
    expect(run).toMatchObject({ outcome: "passed" });
  });

  it("writes the mandate into the template, and takes it back out the same", () => {
    const checks = checksFor(MANDATE);
    expect(checks).toContain(mandateText(MANDATE));
    expect(splitChecks(checks)).toEqual({ mandate: mandateText(MANDATE), template: CHECKS_TEMPLATE });
    expect(splitChecks("print(1)")).toBeUndefined();
  });
});

describe("a mandate", () => {
  const given = read("../fixtures/mandate.json");

  it("is read with checksummed addresses", () => {
    expect(parseMandate({ ...given, wallet: given.wallet.toLowerCase() }).wallet).toBe("0xd937E50Ee21E66f7640F1a7887399e63055290fe");
  });

  it.each([
    [{ maxSlippage: 1 }, "The mandate has a field the checks do not read: maxSlippage."],
    [{ chain: "4663" }, "The mandate needs chain, a chain id."],
    [{ maxSlippageBps: 10_001 }, "The mandate needs maxSlippageBps, 0 to 10,000."],
    [{ validUntil: "2026-12-31" }, 'The mandate needs validUntil as a real UTC time, "YYYY-MM-DDTHH:MM:SSZ".'],
    [{ validUntil: "2026-02-30T00:00:00Z" }, "The mandate needs validUntil as a real UTC time"],
    [{ validUntil: "2026-12-31T24:00:00Z" }, "The mandate needs validUntil as a real UTC time"],
    [{ recipient: "0x1234" }, "The mandate has no valid recipient address."],
    [{ tokens: [] }, "The mandate lists no tokens."],
    [{ tokens: [null] }, "The mandate token 1 is not an object with symbol, address, decimals and maxSell."],
    [{ tokens: [{ ...given.tokens[0], max: "1" }] }, "The mandate has a field the checks do not read in token 1: max."],
    [{ tokens: [{ symbol: 'US"DG', address: given.tokens[0].address, decimals: 6, maxSell: "1" }] }, "The mandate token 1 needs a symbol of 1 to 16 letters, digits or dots."],
    [{ tokens: [{ ...given.tokens[0], maxSell: "1.0000001" }] }, "The mandate token USDG has more decimals in maxSell than its 6."],
    [{ tokens: [given.tokens[0], { ...given.tokens[0], symbol: "USDG2" }] }, "The mandate lists 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 twice."],
    [{ tokens: [given.tokens[0], { ...given.tokens[1], symbol: "usdg" }] }, "The mandate lists usdg twice."],
  ])("refuses %j", (change, error) => {
    expect(() => parseMandate({ ...given, ...change })).toThrow(error);
  });

  it("names its file in every error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mandate-"));
    await writeFile(join(dir, "broken.json"), "{");
    await writeFile(join(dir, "typo.json"), JSON.stringify({ ...given, chian: 1 }));
    await expect(readMandate(join(dir, "broken.json"))).rejects.toThrow(/^The mandate broken\.json is not JSON: /);
    await expect(readMandate(join(dir, "typo.json"))).rejects.toThrow("The mandate typo.json has a field the checks do not read: chian.");
    await expect(readMandate(join(dir, "absent.json"))).rejects.toThrow(/^Cannot read the mandate .*absent\.json: ENOENT\.$/);
  });
});
