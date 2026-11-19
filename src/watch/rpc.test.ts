import { describe, expect, it } from "vitest";

import { redactor, rpcSetting, splitting } from "./rpc.js";

describe("the RPC setting", () => {
  it("takes https, or http on this machine, since it can hold a key, and never repeats the value", () => {
    expect(rpcSetting(" https://rh.example.com/key12345 ")!.host).toBe("rh.example.com");
    expect(rpcSetting("http://127.0.0.1:8545")!.port).toBe("8545");
    expect(rpcSetting(undefined)).toBeUndefined();
    for (const value of ["http://rh.example.com/key12345", "ftp://rh.example.com", "rh.example.com/key12345"]) {
      const error = (() => {
        try {
          rpcSetting(value);
        } catch (thrown) {
          return (thrown as Error).message;
        }
      })();
      expect(error, value).toMatch(/^BRAINCHAIN_WATCH_RPC must be an https URL/);
      expect(error).not.toContain("key12345");
    }
  });
});

describe("the redactor", () => {
  it("takes a node's address out of a message in every form, and its key wherever it stands alone", () => {
    const redact = redactor(new URL("https://user:pa55word99@rh.example.com:8443/abcdef123456?apikey=zz99xx88yy"));
    for (const [text, expected] of [
      ["URL: https://rh.example.com:8443/abcdef123456 failed", "URL: the configured RPC failed"],
      ["at https://user:pa55word99@rh.example.com:8443/abcdef123456?apikey=zz99xx88yy.", "at the configured RPC"],
      ["rh.example.com answered 429", "the configured RPC answered 429"],
      ["RH.EXAMPLE.COM/abcdef123456 down", "the configured RPC down"],
      ['{"url":"rh.example.com"}', '{"url":"the configured RPC"}'],
      ["key abcdef123456 or zz99xx88yy or pa55word99 alone", "key [redacted] or [redacted] or [redacted] alone"],
    ])
      expect(redact(text!), text).toBe(expected);
    expect(redactor()("https://rh.example.com/x")).toBe("https://rh.example.com/x");
  });
});

describe("a log search on the private endpoint", () => {
  const RPC = "https://rh.example.com/key";
  const search = (from: number, to: number) => JSON.stringify({ jsonrpc: "2.0", id: 7, method: "eth_getLogs", params: [{ address: "0xabc", fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }] });
  function endpoint(logsPerPiece = 2, refuseAt?: number) {
    const asked: [number, number][] = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const { id, params } = JSON.parse(init!.body as string) as { id: number; params: [{ fromBlock: string; toBlock: string }] };
      const range: [number, number] = [Number(params[0].fromBlock), Number(params[0].toBlock)];
      asked.push(range);
      if (range[1] - range[0] + 1 > 10_000) return Response.json({ jsonrpc: "2.0", id, error: { code: -32602, message: "Block range limit exceeded." } });
      if (refuseAt !== undefined && range[0] === refuseAt) return new Response("busy", { status: 429 });
      return Response.json({ jsonrpc: "2.0", id, result: Array.from({ length: logsPerPiece }, (_, i) => ({ blockNumber: `0x${(range[0] + i).toString(16)}` })) });
    }) as typeof fetch;
    return { asked, fetchImpl };
  }

  it("is sent in pieces of 10,000 blocks and answered as one, up to 200,000 blocks", async () => {
    const { asked, fetchImpl } = endpoint();
    const answer = (await (await splitting(fetchImpl)(RPC, { method: "POST", body: search(100_000, 129_999) })).json()) as { id: number; result: unknown[] };
    expect([answer.id, answer.result.length]).toEqual([7, 6]);
    expect(asked).toEqual([[100_000, 109_999], [110_000, 119_999], [120_000, 129_999]]);
  });

  it("passes a short search, a long one and anything else through as it is, for the fallback to take", async () => {
    const { asked, fetchImpl } = endpoint();
    await splitting(fetchImpl)(RPC, { method: "POST", body: search(0, 9_999) });
    const long = (await (await splitting(fetchImpl)(RPC, { method: "POST", body: search(0, 9_999_999) })).json()) as { error?: unknown };
    expect(long.error).toBeDefined();
    expect(asked).toEqual([[0, 9_999], [0, 9_999_999]]);
  });

  it("answers as the public endpoint does when the pieces hold too many logs, and fails whole when a piece fails", async () => {
    const full = (await (await splitting(endpoint(6_000).fetchImpl)(RPC, { method: "POST", body: search(0, 19_999) })).json()) as { error: { message: string } };
    expect(full.error.message).toBe("logs matched by query exceeds limit of 10000");
    expect((await splitting(endpoint(1, 10_000).fetchImpl)(RPC, { method: "POST", body: search(0, 19_999) })).status).toBe(429);
  });
});
