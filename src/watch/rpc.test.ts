import { describe, expect, it } from "vitest";

import { redactor, rpcSetting } from "./rpc.js";

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
