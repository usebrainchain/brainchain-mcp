import { decodeFunctionData, encodeFunctionResult, parseAbi, RpcRequestError, type Address } from "viem";
import { describe, expect, it } from "vitest";

import type { ChainHistory } from "../history.js";
import { again, inOrder, namesOf } from "./chain.js";

const fast = { gap: 0, sleep: async () => {} };

describe("the scans of the chain", () => {
  it("read pieces side by side and hand them on in block order, retrying one that fails", async () => {
    const written: [number, number][] = [];
    let failed = false;
    const through = await inOrder(
      1,
      45,
      { span: 10, atOnce: 3, ...fast },
      async (from, to) => {
        if (from === 11 && !failed) {
          failed = true;
          throw new Error("busy");
        }
        await new Promise((resolve) => setTimeout(resolve, from === 1 ? 15 : 1));
        return [from, to] as [number, number];
      },
      (from, to, found) => void written.push(found),
    );
    expect(through).toBe(45);
    expect(written).toEqual([[1, 10], [11, 20], [21, 30], [31, 40], [41, 45]]);
  });

  it("stop when asked and keep what was written, and fail only when nothing could be", async () => {
    let pieces = 0;
    const through = await inOrder(1, 100, { span: 10, atOnce: 1, ...fast, stop: () => pieces >= 2 }, async () => ++pieces, () => {});
    expect(through).toBe(20);
    await expect(inOrder(1, 10, { span: 10, atOnce: 1, ...fast }, async () => Promise.reject(new Error("down")), () => {})).rejects.toThrow("down");
    let tries = 0;
    expect(await again(async () => (++tries < 3 ? Promise.reject(new Error("rate")) : "ok"), 6, async () => {})).toBe("ok");
  });

  it("read many tokens' names in one call, and halve a call a token's code takes down until that token alone gets none", async () => {
    const abi = parseAbi(["function symbol() view returns (string)", "function name() view returns (string)"]);
    const BAD = "0x00000000000000000000000000000000000000bb" as Address;
    let calls = 0;
    const reader = {
      async readContract({ args }: { args: [{ target: Address; callData: `0x${string}` }[]] }) {
        calls++;
        if (args[0].some(({ target }) => target === BAD)) throw new RpcRequestError({ body: {}, error: { code: -32000, message: "out of gas" }, url: "https://rpc.test" });
        return args[0].map(({ callData, target }) => {
          const { functionName } = decodeFunctionData({ abi, data: callData });
          return { success: true, returnData: encodeFunctionResult({ abi, functionName, result: functionName === "symbol" ? `S${target.slice(-1)}` : "Name\u202e<b>" }) };
        });
      },
    } as unknown as ChainHistory;
    const tokens = ["0x0000000000000000000000000000000000000001", BAD, "0x0000000000000000000000000000000000000003"] as Address[];
    expect(await namesOf(reader, tokens)).toEqual([
      { symbol: "S1", name: "Name b" },
      { symbol: "", name: "" },
      { symbol: "S3", name: "Name b" },
    ]);
    expect(calls).toBe(5);
  });
});
