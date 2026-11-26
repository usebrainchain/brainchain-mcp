import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";

import { HOSTED_TOOLS, hostedMcp } from "./hosted.js";
import { wire } from "./server.js";
import { EventLog } from "./watch/events.js";
import { SERVE_LIMITS, serveEvents, type ServeLimits } from "./watch/serve.js";

const GRADE = `0x${"ab".repeat(32)}`;
const KEYLESS = [
  "brainchain_get_task",
  "brainchain_get_grade",
  "brainchain_stock_premiums",
  "brainchain_custody_additions",
  "brainchain_market_maker_holdings",
  "brainchain_token_readiness",
  "brainchain_token_sightings",
  "brainchain_token_timeline",
  "brainchain_token_market_cap",
  "brainchain_token_builder",
  "brainchain_trace_outcomes",
  "brainchain_calls",
  "brainchain_changes",
  "brainchain_watch",
  "brainchain_unwatch",
  "brainchain_exam_info",
  "brainchain_licences",
  "brainchain_agent_record",
];

let close: (() => void) | undefined;
afterEach(() => close?.());

/**
 * The watcher's --serve with the hosted endpoint on an ephemeral port. Its tools' reads of BrainChain's desk are answered
 * here; their reads of the watcher go to it for real, and each is recorded with its headers.
 */
async function serving(limits: ServeLimits = SERVE_LIMITS, publicUrl?: URL) {
  const toWatcher: Headers[] = [];
  const desk: string[] = [];
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "127.0.0.1") {
      toWatcher.push(new Headers(init?.headers));
      return fetch(input, init);
    }
    desk.push(url.href);
    if (url.href === `https://brain.usebrainchain.com/x402/grades/${GRADE}`) return Response.json({ grade: GRADE, state: "graded", accepted: true, passProbability: 0.91, bar: 0.8 });
    return Response.json({ error: "Not found." }, { status: 404 });
  }) as typeof fetch;
  const served = serveEvents({ log: new EventLog(mkdtempSync(join(tmpdir(), "brainchain-hosted-"))), health: () => ({ ok: true, sources: {} }), mcp: hostedMcp("0.0.0-test", { fetch: stub, ...(publicUrl ? { publicUrl } : {}) }), limits });
  await new Promise<void>((resolve) => served.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(served.server.address() as AddressInfo).port}`;
  const clients: Client[] = [];
  close = () => {
    for (const client of clients) void client.close();
    served.close();
  };
  const connect = async () => {
    const client = new Client({ name: "test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    clients.push(client);
    return client;
  };
  return { base, connect, toWatcher, desk };
}

const text = (result: Awaited<ReturnType<Client["callTool"]>>) => (result.content as { text: string }[])[0]!.text;
const post = (base: string, body: string) => fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body });

describe("the hosted BrainChain MCP at /mcp", () => {
  it("lists exactly the tools that need no wallet, and says how to pay with the local package", async () => {
    const { connect } = await serving();
    const client = await connect();
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(KEYLESS);
    expect([...HOSTED_TOOLS]).toEqual(KEYLESS);
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain("npx -y brainchain-mcp@0.0.0-test init");
    expect(instructions).toContain("npx -y brainchain-mcp@0.0.0-test login");
    // Every hosted tool is one the local server has, under the same name.
    const local = new Set(wire({}, "0.0.0-test", { log: () => {}, login: () => undefined, walletSaved: () => false }, true).tools.map((tool) => tool.name));
    for (const name of KEYLESS) expect(local.has(name)).toBe(true);
  });

  it("answers a read, and reads the watcher as the caller, never repeating the secret", async () => {
    const { connect, toWatcher, desk } = await serving();
    const client = await connect();
    const grade = await client.callTool({ name: "brainchain_get_grade", arguments: { grade: GRADE } });
    expect(grade.isError).toBe(false);
    expect(JSON.parse(text(grade))).toMatchObject({ grade: GRADE, state: "graded", accepted: true, done: true });
    expect(desk).toEqual([`https://brain.usebrainchain.com/x402/grades/${GRADE}`]);
    const changes = await client.callTool({ name: "brainchain_changes", arguments: {} });
    expect(changes.isError).toBe(false);
    expect(toWatcher).toHaveLength(1);
    expect(toWatcher[0]!.get("x-brainchain-hosted-for")).toBe("127.0.0.1");
    const secret = toWatcher[0]!.get("x-brainchain-hosted")!;
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(text(changes)).not.toContain(secret);
  });

  it("gives the watcher's public address in replies, and still reads it over loopback", async () => {
    const { connect, toWatcher } = await serving(SERVE_LIMITS, new URL("https://watch.example"));
    const client = await connect();
    const changes = JSON.parse(text(await client.callTool({ name: "brainchain_changes", arguments: {} }))) as { watcher: string; events: unknown[] };
    expect(changes).toMatchObject({ watcher: "https://watch.example", events: [] });
    expect(toWatcher).toHaveLength(1);
  });

  it("refuses the tools that pay or sign", async () => {
    const { connect, desk } = await serving();
    const client = await connect();
    for (const name of ["brainchain_grade", "brainchain_post_task", "brainchain_call", "brainchain_sit_exam", "brainchain_exam_submit", "brainchain_bond_status"]) {
      const result = await client.callTool({ name, arguments: { brief: "b", result: "r" } });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("need the local package");
    }
    expect(desk).toEqual([]);
  });

  it("answers GET and DELETE with 405, being stateless", async () => {
    const { base } = await serving();
    for (const method of ["GET", "DELETE"]) {
      const response = await fetch(`${base}/mcp`, { method, headers: { accept: "text/event-stream" } });
      expect([response.status, response.headers.get("allow")]).toEqual([405, "POST"]);
    }
  });

  it("holds one address to its own requests a minute, with Retry-After", async () => {
    const { base } = await serving({ ...SERVE_LIMITS, mcpPerMinute: 2 });
    const ping = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
    for (const _ of [1, 2]) expect((await post(base, ping)).status).toBe(200);
    const refused = await post(base, ping);
    expect([refused.status, refused.headers.get("retry-after")]).toEqual([429, "60"]);
    expect(await refused.json()).toEqual({ error: "Too many MCP requests from your network address: the endpoint takes 2 a minute from one address. Wait a minute, then try again." });
  });

  it("takes a body of at most 1 MB", async () => {
    const { base } = await serving();
    const large = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(1_000_000) } });
    const response = await post(base, large);
    expect(response.status).toBe(413);
    expect((await post(base, JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }))).status).toBe(200);
  });

  it("is named on /health and in the watcher's list of routes", async () => {
    const { base } = await serving();
    expect(await (await fetch(`${base}/health`)).json()).toMatchObject({ mcp: "/mcp" });
    expect(((await (await fetch(`${base}/nothing`)).json()) as { error: string }).error).toContain("GET /health, POST /mcp, POST /watches");
  });
});

describe("a watcher without the hosted endpoint", () => {
  it("answers 404 at /mcp and does not list it", async () => {
    const served = serveEvents({ log: new EventLog(mkdtempSync(join(tmpdir(), "brainchain-hosted-"))), health: () => ({ ok: true, sources: {} }) });
    await new Promise<void>((resolve) => served.server.listen(0, "127.0.0.1", resolve));
    close = () => served.close();
    const base = `http://127.0.0.1:${(served.server.address() as AddressInfo).port}`;
    expect((await post(base, "{}")).status).toBe(404);
    expect(((await (await fetch(`${base}/nothing`)).json()) as { error: string }).error).not.toContain("/mcp");
  });
});
