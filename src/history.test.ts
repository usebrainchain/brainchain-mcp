import { describe, expect, it, vi } from "vitest";

/** An endpoint that takes ten seconds over every request and always answers block 41. */
function slowEndpoint() {
  const sent: number[] = [];
  const fetchImpl = async (_url: unknown, init?: RequestInit) => {
    sent.push(Date.now());
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    return Response.json({ jsonrpc: "2.0", id: (JSON.parse(String(init?.body)) as { id: number }).id, result: "0x29" });
  };
  return { sent, fetchImpl };
}

describe("inTurn", () => {
  it("starts the next answer when the caller has heard, not when a request that ran out of time comes back", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const start = Date.now();
    // Block numbers take ten seconds each, and from the fortieth second on the endpoint refuses them. Code is read at once.
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      const { id, method } = JSON.parse(String(init?.body)) as { id: number; method: string };
      if (method === "eth_getCode") return Response.json({ jsonrpc: "2.0", id, result: "0x60" });
      const refused = Date.now() - start >= 40_000;
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      return refused ? new Response("{}", { status: 429 }) : Response.json({ jsonrpc: "2.0", id, result: "0x29" });
    });
    try {
      const history = await import("./history.js");
      const slow = history.inTurn(async (reader) => {
        for (let i = 0; i < 10; i++) await reader.getBlockNumber({ cacheTime: 0 });
      });
      const late = expect(slow).rejects.toStrictEqual(new history.ChainError(history.STILL_READING));
      await vi.advanceTimersByTimeAsync(44_000);
      let code: string | undefined;
      const next = history.inTurn((reader) => reader.getCode({ address: "0x020bfC650A365f8BB26819deAAbF3E21291018b4" })).then((read) => (code = read));
      await vi.advanceTimersByTimeAsync(1_000);
      await late;

      // The refused request is sent again for a minute more. The next answer waits for the one in flight, not for those.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(code).toBe("0x60");
      await next;
      await vi.advanceTimersByTimeAsync(60_000);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("says so when the endpoint turns every request away, and how long to wait", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    let sent = 0;
    vi.stubGlobal("fetch", async () => (sent++, new Response("{}", { status: 429 })));
    try {
      const history = await import("./history.js");
      const refused = expect(history.inTurn((reader) => reader.getBlockNumber({ cacheTime: 0 }))).rejects.toStrictEqual(new history.ChainError(history.TURNED_AWAY));
      await vi.advanceTimersByTimeAsync(10_000);
      await refused;
      expect(sent).toBe(5);
      expect(history.TURNED_AWAY).toContain("ask again in five minutes");
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("tells the caller after 45 seconds that it is still reading, and stops the answer at its next request", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const { sent, fetchImpl } = slowEndpoint();
    vi.stubGlobal("fetch", fetchImpl);
    try {
      const history = await import("./history.js");
      const start = Date.now();
      const tenReads = async (reader: { getBlockNumber(options: { cacheTime: number }): Promise<bigint> }) => {
        for (let i = 0; i < 10; i++) await reader.getBlockNumber({ cacheTime: 0 });
        return "read";
      };
      const first = history.inTurn(tenReads);
      // Asked at the same moment, so its 45 seconds run out while the first answer is still being read.
      const queued = history.inTurn(tenReads);
      const said = Promise.all([expect(first).rejects.toStrictEqual(new history.ChainError(history.STILL_READING)), expect(queued).rejects.toStrictEqual(new history.ChainError(history.STILL_READING))]);
      await vi.advanceTimersByTimeAsync(44_999);
      expect(sent).toHaveLength(5);
      await vi.advanceTimersByTimeAsync(1);
      await said;

      // The first answer makes no sixth request, and the queued one none at all: nobody is waiting for either.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sent).toHaveLength(5);
      expect(sent.every((at) => at - start < 45_000)).toBe(true);

      // The queue is free again for an answer asked now.
      const later = history.inTurn((reader) => reader.getBlockNumber({ cacheTime: 0 }));
      await vi.advanceTimersByTimeAsync(11_000);
      expect(await later).toBe(41n);
      expect(sent).toHaveLength(6);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
