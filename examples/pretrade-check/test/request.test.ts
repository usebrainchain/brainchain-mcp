import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { parseMandate } from "../src/mandate.ts";
import { CHECKS, checksFor, deliveryCode, MAX_CHECKS, MAX_PROGRAM, pretradeCheck, type Registry } from "../src/request.ts";
import { programOf, runLocally } from "../src/sandbox.ts";
import type { SignedQuote } from "../src/zerox.ts";

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const MANDATE = parseMandate(read("../fixtures/mandate.json"));
const { trade, quote, registry } = read("../fixtures/quotes/inside.json") as { trade: string; quote: SignedQuote; registry: Registry };

describe("the grade request", () => {
  const request = pretradeCheck({ quote, registry, mandate: MANDATE, trade });

  it("fits the grade route with room to spare", () => {
    expect(request.checks.code.length).toBeLessThan(MAX_CHECKS * 0.6);
    expect(programOf(request).length).toBeLessThan(MAX_PROGRAM * 0.4);
    expect(request.brief.length).toBeLessThan(32_000);
    expect(request.title).toBe("Pre-trade check: sell 5 USDG for WETH on Robinhood Chain");
  });

  it("states every rule of the mandate in the brief, and the mandate itself in the checks", () => {
    expect(request.brief).toContain("- Most one trade may sell: 25 USDG, 0.01 WETH, 0.01 ETH.");
    expect(request.brief).toContain("- The guaranteed minimum out may be at most 100 basis points under 0x's quoted amount.");
    expect(request.checks.code).toContain(`"validUntil": "2026-12-31T23:59:59Z"`);
    // The brain shows checks as a fenced block, so a fence inside them would end it early.
    expect(CHECKS).not.toContain("```");
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
      checks: { language: "python", code: `import hashlib as _h\nassert _h.sha256(DELIVERY["response"]["body"].encode("utf-8")).hexdigest() == "${digest}"` },
    });
    expect(run).toMatchObject({ outcome: "passed" });
  });

  it("writes the mandate into the checks as it was given", () => {
    expect(checksFor(MANDATE)).toContain(JSON.stringify(MANDATE, null, 2));
  });
});

describe("a mandate", () => {
  const given = read("../fixtures/mandate.json");

  it("is read with checksummed addresses", () => {
    expect(parseMandate({ ...given, wallet: given.wallet.toLowerCase() }).wallet).toBe("0xd937E50Ee21E66f7640F1a7887399e63055290fe");
  });

  it.each([
    [{ maxSlippage: 1 }, "The mandate has fields the checks do not read: maxSlippage."],
    [{ chain: "4663" }, "The mandate needs chain, a chain id."],
    [{ maxSlippageBps: 10_001 }, "The mandate needs maxSlippageBps, 0 to 10,000."],
    [{ validUntil: "2026-12-31" }, 'The mandate needs validUntil as "YYYY-MM-DDTHH:MM:SSZ".'],
    [{ recipient: "0x1234" }, "The mandate has no valid recipient address."],
    [{ tokens: [] }, "The mandate lists no tokens."],
    [{ tokens: [{ symbol: 'US"DG', address: given.tokens[0].address, decimals: 6, maxSell: "1" }] }, "The mandate token 1 needs a symbol of 1 to 16 letters, digits or dots."],
    [{ tokens: [{ ...given.tokens[0], maxSell: "1.0000001" }] }, "The mandate token USDG has more decimals in maxSell than its 6."],
    [{ tokens: [given.tokens[0], { ...given.tokens[0], symbol: "USDG2" }] }, "The mandate lists 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 twice."],
  ])("refuses %j", (change, error) => {
    expect(() => parseMandate({ ...given, ...change })).toThrow(error);
  });
});
