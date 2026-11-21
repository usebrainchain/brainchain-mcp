import { describe, expect, it } from "vitest";

import { checkFunds, checkHolding, checkTokens, USDC_BASE } from "../src/preflight.ts";

import { MANDATE, node } from "./helpers.ts";

const [USDG, WETH, ETH] = MANDATE.tokens as [(typeof MANDATE.tokens)[0], (typeof MANDATE.tokens)[0], (typeof MANDATE.tokens)[0]];
const onChain = { [USDG.address]: { decimals: 6, symbol: "USDG", balanceOf: 21_639_954n }, [WETH.address]: { decimals: 18, symbol: "WETH" } };

describe("the mandate's tokens, read on chain before anything is paid", () => {
  it("pass when the chain agrees with the mandate", async () => {
    await expect(checkTokens(MANDATE, node(onChain), "fixtures/mandate.json")).resolves.toEqual(["USDG, 6 decimals", "WETH, 18 decimals", "ETH, the native token, 18 decimals"]);
  });

  it.each([
    [{ [WETH.address]: { decimals: 6, symbol: "WETH" } }, "The mandate mine.json gives WETH 18 decimals; the token at 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73 on chain 4663 has 6."],
    [{ [WETH.address]: { decimals: 18, symbol: "WETH9" } }, "The mandate mine.json calls the token at 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73 WETH; on chain 4663 it is WETH9."],
    [{ [WETH.address]: {} }, "The mandate mine.json lists WETH at 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73, which answers no decimals() on chain 4663"],
  ])("refuse a mandate the chain contradicts, naming its file", async (change, message) => {
    await expect(checkTokens(MANDATE, node({ ...onChain, ...change }), "/somewhere/mine.json")).rejects.toThrow(message);
  });

  it("hold the native token to 18 decimals", async () => {
    const odd = { ...MANDATE, tokens: [USDG, { ...ETH, decimals: 6 }] };
    await expect(checkTokens(odd, node(onChain), "mine.json")).rejects.toThrow("The mandate mine.json gives ETH, the chain's native token, 6 decimals; it has 18.");
  });
});

describe("what the wallet holds", () => {
  it("covers a check in USDC on Base, or says what is missing", async () => {
    await expect(checkFunds(MANDATE.wallet, node({ [USDC_BASE]: { balanceOf: 600_000n } }))).resolves.toBe("0.6 USDC on Base, enough for 2 checks");
    await expect(checkFunds(MANDATE.wallet, node({ [USDC_BASE]: { balanceOf: 100_000n } }))).rejects.toThrow(
      "The wallet 0xd937E50Ee21E66f7640F1a7887399e63055290fe holds 0.1 USDC on Base, and a check takes 0.26: 0.01 to 0x and 0.25 to BrainChain. Add 0.16 USDC on Base. Nothing was paid.",
    );
  });

  it("covers the amount sold, in the token or in native ETH", async () => {
    await expect(checkHolding(MANDATE, USDG, 5_000_000n, MANDATE.wallet, node(onChain))).resolves.toBe("21.639954 USDG on chain 4663, enough to sell 5 USDG");
    await expect(checkHolding(MANDATE, USDG, 22_000_000n, MANDATE.wallet, node(onChain))).rejects.toThrow("holds 21.639954 USDG on chain 4663, and the trade sells 22 USDG. Nothing was paid.");
    await expect(checkHolding(MANDATE, ETH, 10n ** 15n, MANDATE.wallet, node({}, { balance: 298_803_918_768_000n }))).rejects.toThrow("holds 0.000298803918768 ETH on chain 4663, and the trade sells 0.001 ETH.");
  });
});
