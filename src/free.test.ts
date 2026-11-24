import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { CALL_NAME } from "./calls.js";
import { resolveConfig } from "./config.js";
import { FREE_URL, freeGrader, freeUrl, readLogin, saveLogin, walletNext } from "./free.js";
import { createServer, type ServerOptions } from "./server.js";
import { GET_GRADE_NAME, GRADE_NAME } from "./tools.js";

// Anvil's second default account: a public test key that holds nothing anywhere.
const KEY = "59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const TOKEN = "gho_16C7e42F292c6912E7710c838347Ae178B4a";
const GRADE = `0x${"cd".repeat(32)}`;
const request = { brief: "Sort 3, 1 and 2.", result: "1, 2, 3" };
const mainnet = resolveConfig({});
const NEXT = "To keep grading, set up a wallet: run `npx -y brainchain-mcp init` in a terminal. It creates a wallet, says how much USDC to send it on Base (a grade costs 0.25 USDC) and prints the line that adds it to this server.";

/** BrainChain's free checks answering each grade with `answer`, recording what each request carried. */
function checks(answer: () => Response = () => Response.json({ grade: GRADE, state: "graded", accepted: true, done: true, free: { used: 1, left: 1 } })) {
  const sent: { url: string; authorization: string | null; body: unknown }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    sent.push({ url: req.url, authorization: req.headers.get("authorization"), body: req.method === "POST" ? await req.json() : undefined });
    if (req.url.startsWith(`${FREE_URL}/free/grade`)) return answer();
    return new Response("{}", { status: 402 });
  }) as typeof fetch;
  return { fetchImpl, sent };
}

async function connect(env: Record<string, string | undefined>, options: ServerOptions = {}) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(env, "0.0.0-test", { log: () => {}, ...options }).connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  return client;
}

const text = (result: Awaited<ReturnType<Client["callTool"]>>) => (result.content as { text: string }[])[0]!.text;

describe("the GitHub sign-in", () => {
  it("is kept readable only by this account, and read back as a token or not at all", () => {
    const file = join(mkdtempSync(join(tmpdir(), "brainchain-login-")), "nested", "github.token");
    expect(readLogin(file)).toBeUndefined();
    saveLogin(TOKEN, file);
    expect(readLogin(file)).toBe(TOKEN);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    writeFileSync(file, "not a token at all\n");
    expect(readLogin(file)).toBeUndefined();
    expect(() => saveLogin("bad token", file)).toThrow("nothing was saved");
  });
});

describe("where free checks are asked for", () => {
  it("is BrainChain's own on mainnet, none on testnet, or BRAINCHAIN_FREE_URL over https or on this machine", () => {
    expect(freeUrl({}, "mainnet")?.href).toBe(`${FREE_URL}/`);
    expect(freeUrl({}, "testnet")).toBeUndefined();
    expect(freeUrl({ BRAINCHAIN_FREE_URL: "http://127.0.0.1:8787" }, "testnet")?.href).toBe("http://127.0.0.1:8787/");
    expect(freeUrl({ BRAINCHAIN_FREE_URL: " " }, "mainnet")?.href).toBe(`${FREE_URL}/`);
    for (const bad of ["http://example.com", "ftp://127.0.0.1", "not a url"]) expect(() => freeUrl({ BRAINCHAIN_FREE_URL: bad }, "mainnet")).toThrow("BRAINCHAIN_FREE_URL must be an https URL");
  });
});

describe("a free grade", () => {
  const grade = (fetchImpl: typeof fetch, login: () => string | undefined = () => TOKEN) => freeGrader({ config: mainnet, url: new URL(FREE_URL), login, fetch: fetchImpl });

  it("sends the request with the sign-in and the network, and says how many checks are left", async () => {
    const { fetchImpl, sent } = checks();
    expect(await grade(fetchImpl)(request)).toMatchObject({ grade: GRADE, state: "graded", free: { used: 1, left: 1, note: "1 free check left on this GitHub account." } });
    expect(sent).toEqual([{ url: `${FREE_URL}/free/grade?network=mainnet`, authorization: `Bearer ${TOKEN}`, body: request }]);
  });

  it("says how to set up a wallet after the last free check", async () => {
    const { fetchImpl } = checks(() => Response.json({ grade: GRADE, state: "graded", free: { used: 2, left: 0 } }));
    expect(((await grade(fetchImpl)(request)) as { free: { note: string } }).free.note).toBe(`That was the last free check on this GitHub account. ${NEXT}`);
    expect(NEXT).toBe(walletNext(mainnet));
  });

  it("says how to set up a wallet when a limit stops it, and how to sign in again when the sign-in lapsed", async () => {
    for (const [status, reason, error] of [
      [403, "used", "@octocat has used its 2 free checks."],
      [403, "young", "Free checks are for GitHub accounts older than 30 days, and @fresh was created on 2026-11-10."],
      [429, "daily", "Today's free checks are all taken. More open at 00:00 UTC."],
      [403, "total", "All of BrainChain's free checks have been given out."],
    ] as const) {
      await expect(grade(checks(() => Response.json({ reason, error }, { status })).fetchImpl)(request)).rejects.toThrow(`${error} ${NEXT}`);
    }
    const lapsed = "Your GitHub sign-in has expired or was revoked. Run `npx -y brainchain-mcp login` again.";
    await expect(grade(checks(() => Response.json({ reason: "login", error: lapsed }, { status: 401 })).fetchImpl)(request)).rejects.toThrow(new RegExp(`^${lapsed.replace(/[.*+?^${}()|[\]\\`]/g, "\\$&")}$`));
  });

  it("asks for a sign-in or a wallet when there is no sign-in, and sends nothing", async () => {
    const { fetchImpl, sent } = checks();
    await expect(grade(fetchImpl, () => undefined)(request)).rejects.toThrow(
      "This server has no wallet to pay for grades. To grade 2 times free, sign in with GitHub: run `npx -y brainchain-mcp login` in a terminal. To pay as you go, run `npx -y brainchain-mcp init` in a terminal.",
    );
    expect(sent).toEqual([]);
  });

  it("says when the free checks are not open, and when they did not answer", async () => {
    await expect(grade(checks(() => Response.json({ error: "Not found." }, { status: 404 })).fetchImpl)(request)).rejects.toThrow(`BrainChain's free checks are not open right now. ${NEXT}`);
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await expect(grade(down)(request)).rejects.toThrow("BrainChain's free checks did not answer (fetch failed). Send the same grade again in a minute: if it went through, you get that grade back without using another free check.");
  });
});

describe("a server with no wallet", () => {
  it("grades through the free checks with a sign-in, and says so in the grade tool", async () => {
    const { fetchImpl, sent } = checks();
    const client = await connect({}, { fetch: fetchImpl, login: () => TOKEN });
    const tool = (await client.listTools()).tools.find((t) => t.name === GRADE_NAME)!;
    expect(tool.description).toContain("With no wallet set, BrainChain pays for the first 2 grades of a GitHub account older than 30 days once your operator signs in with `npx -y brainchain-mcp login` in a terminal.");
    const result = await client.callTool({ name: GRADE_NAME, arguments: request });
    expect(result.isError).toBe(false);
    expect(JSON.parse(text(result))).toMatchObject({ grade: GRADE, free: { left: 1 } });
    expect(sent.map(({ url }) => url)).toEqual([`${FREE_URL}/free/grade?network=mainnet`]);
  });

  it("checks a grade's fields before it asks, and reads the verdict from the desk as any grade", async () => {
    const { fetchImpl, sent } = checks();
    const client = await connect({}, { fetch: fetchImpl, login: () => TOKEN });
    const bad = await client.callTool({ name: GRADE_NAME, arguments: { ...request, extra: 1 } });
    expect(bad.isError).toBe(true);
    expect(sent).toEqual([]);
    await client.callTool({ name: GET_GRADE_NAME, arguments: { grade: GRADE } });
    expect(sent.map(({ url }) => url)).toEqual([`https://brain.usebrainchain.com/x402/grades/${GRADE}`]);
  });

  it("asks for a sign-in or a wallet without one, and pays calls from a wallet only", async () => {
    const { fetchImpl, sent } = checks();
    const client = await connect({}, { fetch: fetchImpl, login: () => undefined });
    const result = await client.callTool({ name: GRADE_NAME, arguments: request });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("run `npx -y brainchain-mcp login` in a terminal");
    expect(sent).toEqual([]);
    const signedIn = await connect({}, { fetch: fetchImpl, login: () => TOKEN });
    const call = await signedIn.callTool({ name: CALL_NAME, arguments: { token: "0x020bfC650A365f8BB26819deAAbF3E21291018b4", venue: "Coinbase", by: "2026-12-31" } });
    expect(call.isError).toBe(true);
    expect(sent.filter(({ url }) => url.includes("/free/"))).toEqual([]);
  });
});

describe("a server with a wallet, or on testnet", () => {
  it("never asks the free checks, whatever sign-in is kept", async () => {
    const { fetchImpl, sent } = checks();
    for (const env of [{ BRAINCHAIN_PAYER_KEY: KEY }, { BRAINCHAIN_NETWORK: "testnet" }]) {
      const client = await connect(env, { fetch: fetchImpl, login: () => TOKEN });
      const tool = (await client.listTools()).tools.find((t) => t.name === GRADE_NAME)!;
      expect(tool.description).not.toContain("brainchain-mcp login");
      await client.callTool({ name: GRADE_NAME, arguments: request });
    }
    expect(sent.filter(({ url }) => url.includes("/free/"))).toEqual([]);
  });

  it("stops only the grade tool for a BRAINCHAIN_FREE_URL it cannot use", async () => {
    const client = await connect({ BRAINCHAIN_FREE_URL: "http://example.com" }, { login: () => TOKEN });
    const result = await client.callTool({ name: GRADE_NAME, arguments: request });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("BRAINCHAIN_FREE_URL must be an https URL, or http on localhost or 127.0.0.1. Fix it in this server's environment and restart the server.");
  });
});
