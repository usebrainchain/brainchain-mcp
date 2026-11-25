import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { CALL_NAME } from "./calls.js";
import { resolveConfig } from "./config.js";
import { FREE_URL, freeGrader, freeUrl, readLogin, saveLogin, walletNext, type Login } from "./free.js";
import { createServer, type ServerOptions } from "./server.js";
import { GET_GRADE_NAME, GRADE_NAME } from "./tools.js";

// Anvil's second default account: a public test key that holds nothing anywhere.
const KEY = "59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const TOKEN = "gho_16C7e42F292c6912E7710c838347Ae178B4a";
const GRADE = `0x${"cd".repeat(32)}`;
const request = { brief: "Sort 3, 1 and 2.", result: "1, 2, 3" };
const mainnet = resolveConfig({});
const SIGNED_IN: Login = { token: TOKEN, url: `${FREE_URL}/`, network: "mainnet" };
const INIT = "npx -y brainchain-mcp@0.0.0-test init";
const SET_UP = `set up a wallet: run \`${INIT}\` in a terminal. It creates a wallet, says how much USDC to send it on Base (a grade costs 0.25 USDC) and prints the line that adds it to this server.`;
const NEXT = `To keep grading, ${SET_UP}`;

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
  await createServer(env, "0.0.0-test", { log: () => {}, walletSaved: () => false, ...options }).connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  return client;
}

const text = (result: Awaited<ReturnType<Client["callTool"]>>) => (result.content as { text: string }[])[0]!.text;

describe("the GitHub sign-in", () => {
  it("is kept readable only by this account with the checks it was made for, and read back whole or not at all", () => {
    const file = join(mkdtempSync(join(tmpdir(), "brainchain-login-")), "nested", "github.token");
    expect(readLogin(file)).toBeUndefined();
    const testnet: Login = { token: TOKEN, url: "http://127.0.0.1:8787/", network: "testnet" };
    saveLogin(testnet, file);
    expect(readLogin(file)).toEqual(testnet);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    for (const kept of ["not a token at all\n", `${TOKEN}\n`, JSON.stringify({ ...testnet, network: "devnet" }), JSON.stringify({ token: TOKEN }), "null"]) {
      writeFileSync(file, kept);
      expect(readLogin(file)).toBeUndefined();
    }
    expect(() => saveLogin({ ...testnet, token: "bad token" }, file)).toThrow("nothing was saved");
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
  const commands = { init: INIT, login: "npx -y brainchain-mcp@0.0.0-test login" };
  const grade = (fetchImpl: typeof fetch, login: () => Login | undefined = () => SIGNED_IN, saved = false) => freeGrader({ config: mainnet, url: new URL(FREE_URL), commands, login, fetch: fetchImpl, walletSaved: () => saved });

  it("sends the request with the sign-in and the network, and says how many checks are left", async () => {
    const { fetchImpl, sent } = checks();
    expect(await grade(fetchImpl)(request)).toMatchObject({ grade: GRADE, state: "graded", free: { used: 1, left: 1, note: "1 free check left on this GitHub account." } });
    expect(sent).toEqual([{ url: `${FREE_URL}/free/grade?network=mainnet`, authorization: `Bearer ${TOKEN}`, body: request }]);
  });

  it("says how to set up a wallet after the last free check", async () => {
    const { fetchImpl } = checks(() => Response.json({ grade: GRADE, state: "graded", free: { used: 2, left: 0 } }));
    expect(((await grade(fetchImpl)(request)) as { free: { note: string } }).free.note).toBe(`That was the last free check on this GitHub account. ${NEXT}`);
    expect(NEXT).toBe(walletNext(mainnet, INIT, "used"));
  });

  it("tells a repeat it used no check, whatever is left", async () => {
    const repeat = (left: number) => checks(() => Response.json({ grade: GRADE, state: "graded", duplicate: true, free: { used: 2 - left, left } })).fetchImpl;
    const note = async (left: number) => ((await grade(repeat(left))(request)) as { free: { note: string } }).free.note;
    expect(await note(0)).toBe(`You sent this grade before, so this is the same grade again and no free check was used. No free checks are left on this GitHub account. ${NEXT}`);
    expect(await note(1)).toBe("You sent this grade before, so this is the same grade again and no free check was used. 1 free check left on this GitHub account.");
    const earlier = checks(() => Response.json({ grade: GRADE, state: "graded", duplicate: true, free: { used: 2, left: 0, alreadyGraded: true } })).fetchImpl;
    expect(((await grade(earlier)(request)) as { free: { note: string } }).free.note).toBe(
      `This exact work was already graded; here is that grade. No free check was used. No free checks are left on this GitHub account. ${NEXT}`,
    );
  });

  it("names a wallet init already saved, which this server pays from only once its settings name it", async () => {
    const saved = (lead: string) => `A wallet is already set up at ~/.brainchain/payer.key. ${lead}, add the server again with the line \`${INIT}\` prints, which sets BRAINCHAIN_PAYER_KEY_FILE.`;
    const last = checks(() => Response.json({ grade: GRADE, state: "graded", free: { used: 2, left: 0 } })).fetchImpl;
    expect(((await grade(last, () => SIGNED_IN, true)(request)) as { free: { note: string } }).free.note).toBe(`That was the last free check on this GitHub account. ${saved("To keep grading")}`);
    const used = checks(() => Response.json({ reason: "used", error: "@octocat has used its 2 free checks." }, { status: 403 })).fetchImpl;
    await expect(grade(used, () => SIGNED_IN, true)(request)).rejects.toThrow(`@octocat has used its 2 free checks. ${saved("To keep grading")}`);
    await expect(grade(checks().fetchImpl, () => undefined, true)(request)).rejects.toThrow(saved("To pay as you go"));
  });

  it("says how to set up a wallet when a limit stops it, and how to sign in again when the sign-in lapsed", async () => {
    for (const [status, reason, error, lead] of [
      [403, "used", "@octocat has used its 2 free checks.", "To keep grading"],
      [403, "young", "Free checks are for GitHub accounts older than 30 days. @fresh was created on 2026-11-10, so it qualifies on 2026-12-10.", "To grade today"],
      [429, "daily", "Today's free checks are all taken. More open at 00:00 UTC.", "To grade now"],
      [403, "total", "All of BrainChain's free checks have been given out.", "To grade now"],
      [503, "paused", "BrainChain's free checks are paused. Try again later.", "To grade now"],
    ] as const) {
      await expect(grade(checks(() => Response.json({ reason, error }, { status })).fetchImpl)(request)).rejects.toThrow(`${error} ${lead}, ${SET_UP}`);
    }
    const lapsed = "Your GitHub sign-in has expired or was revoked. Run `npx -y brainchain-mcp login` again.";
    await expect(grade(checks(() => Response.json({ reason: "login", error: lapsed }, { status: 401 })).fetchImpl)(request)).rejects.toThrow(new RegExp(`^${lapsed.replace(/[.*+?^${}()|[\]\\`]/g, "\\$&")}$`));
  });

  it("asks for a sign-in or a wallet when there is no sign-in, and sends nothing", async () => {
    const { fetchImpl, sent } = checks();
    await expect(grade(fetchImpl, () => undefined)(request)).rejects.toThrow(
      `This server has no wallet to pay for grades. For 2 free checks, sign in with GitHub: run \`npx -y brainchain-mcp@0.0.0-test login\` in a terminal. To pay as you go, run \`${INIT}\` in a terminal.`,
    );
    expect(sent).toEqual([]);
  });

  it("names a sign-in made for other free checks, and sends it nowhere", async () => {
    const { fetchImpl, sent } = checks();
    const elsewhere: Login = { token: TOKEN, url: "http://127.0.0.1:8787/", network: "testnet" };
    await expect(grade(fetchImpl, () => elsewhere)(request)).rejects.toThrow(
      "This server has no wallet, and the GitHub sign-in on this machine is for the free checks at http://127.0.0.1:8787 on testnet, but this server uses BrainChain's free checks on mainnet. To use your free checks, add the server again with the line `login` printed",
    );
    expect(sent).toEqual([]);
  });

  it("says when the free checks are not open, and when they did not answer", async () => {
    await expect(grade(checks(() => Response.json({ error: "Not found." }, { status: 404 })).fetchImpl)(request)).rejects.toThrow(`BrainChain's free checks are not open right now. To grade now, ${SET_UP}`);
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await expect(grade(down)(request)).rejects.toThrow(
      /^BrainChain's free-check service could not be reached\. Send the same grade again in a few minutes: if it went through, you get that grade back without using another free check\. If it keeps failing, check your internet connection\.$/,
    );
  });
});

describe("a server with no wallet", () => {
  it("grades through the free checks with a sign-in, and says so in the grade tool", async () => {
    const { fetchImpl, sent } = checks();
    const client = await connect({}, { fetch: fetchImpl, login: () => SIGNED_IN });
    const tool = (await client.listTools()).tools.find((t) => t.name === GRADE_NAME)!;
    expect(tool.description).toContain(
      "This server has no wallet. BrainChain pays for 2 free checks per GitHub account older than 30 days: your operator signs in by running `npx -y brainchain-mcp@0.0.0-test login` in a terminal. After those, each grade costs 0.25 USDC whatever the verdict, paid from a wallet set up with `npx -y brainchain-mcp@0.0.0-test init`.",
    );
    expect(tool.description).not.toContain("paid from this server's wallet");
    const result = await client.callTool({ name: GRADE_NAME, arguments: request });
    expect(result.isError).toBe(false);
    expect(JSON.parse(text(result))).toMatchObject({ grade: GRADE, free: { left: 1 } });
    expect(sent.map(({ url }) => url)).toEqual([`${FREE_URL}/free/grade?network=mainnet`]);
  });

  it("checks a grade's fields before it asks, and reads the verdict from the desk as any grade", async () => {
    const { fetchImpl, sent } = checks();
    const client = await connect({}, { fetch: fetchImpl, login: () => SIGNED_IN });
    const bad = await client.callTool({ name: GRADE_NAME, arguments: { ...request, extra: 1 } });
    expect(bad.isError).toBe(true);
    const secret = await client.callTool({ name: GRADE_NAME, arguments: { ...request, brief: `Use ${["AKIA", "IOSFODNN7EXAMPLE"].join("")}.` } });
    expect(text(secret)).toContain("brief contains an AWS access key id");
    expect(sent).toEqual([]);
    await client.callTool({ name: GET_GRADE_NAME, arguments: { grade: GRADE } });
    expect(sent.map(({ url }) => url)).toEqual([`https://brain.usebrainchain.com/x402/grades/${GRADE}`]);
  });

  it("reads back a free grade the desk has not settled as settling, not as an id it never sent", async () => {
    const statusUrl = `https://brain.usebrainchain.com/x402/grades/${GRADE}`;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      if (req.url.startsWith(`${FREE_URL}/free/grade`)) {
        return Response.json({ grade: GRADE, price: "0.25 USDC", statusUrl, possiblyCharged: true, error: "The desk answered 502. The payment may have gone through.", free: { used: 1, left: 1 } });
      }
      return Response.json({ error: "Not found." }, { status: 404 });
    }) as typeof fetch;
    const fresh = await connect({}, { fetch: fetchImpl, login: () => SIGNED_IN });
    const unknown = await fresh.callTool({ name: GET_GRADE_NAME, arguments: { grade: GRADE } });
    expect(text(unknown)).toContain("Check the id");

    const client = await connect({}, { fetch: fetchImpl, login: () => SIGNED_IN });
    await client.callTool({ name: GRADE_NAME, arguments: request });
    const read = await client.callTool({ name: GET_GRADE_NAME, arguments: { grade: GRADE } });
    expect(read.isError).toBe(false);
    expect(JSON.parse(text(read))).toMatchObject({ grade: GRADE, done: false, next: expect.stringContaining("the payment is still settling or never reached the desk") });
  });

  it("asks for a sign-in or a wallet without one, and pays calls from a wallet only", async () => {
    const { fetchImpl, sent } = checks();
    const client = await connect({}, { fetch: fetchImpl, login: () => undefined });
    const result = await client.callTool({ name: GRADE_NAME, arguments: request });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("run `npx -y brainchain-mcp@0.0.0-test login` in a terminal");
    expect(sent).toEqual([]);
    const signedIn = await connect({}, { fetch: fetchImpl, login: () => SIGNED_IN });
    const call = await signedIn.callTool({ name: CALL_NAME, arguments: { token: "0x020bfC650A365f8BB26819deAAbF3E21291018b4", venue: "Coinbase", by: "2026-12-31" } });
    expect(call.isError).toBe(true);
    expect(sent.filter(({ url }) => url.includes("/free/"))).toEqual([]);
  });
});

describe("a server with a wallet, or on testnet", () => {
  it("never asks the free checks, whatever sign-in is kept", async () => {
    const { fetchImpl, sent } = checks();
    for (const env of [{ BRAINCHAIN_PAYER_KEY: KEY }, { BRAINCHAIN_NETWORK: "testnet" }]) {
      const client = await connect(env, { fetch: fetchImpl, login: () => SIGNED_IN });
      const tool = (await client.listTools()).tools.find((t) => t.name === GRADE_NAME)!;
      expect(tool.description).not.toContain("brainchain-mcp login");
      await client.callTool({ name: GRADE_NAME, arguments: request });
    }
    expect(sent.filter(({ url }) => url.includes("/free/"))).toEqual([]);
  });

  it("on testnet, quotes the commands with the network and the free checks' address", async () => {
    const env = { BRAINCHAIN_NETWORK: "testnet", BRAINCHAIN_FREE_URL: "http://127.0.0.1:8787" };
    const client = await connect(env, { login: () => undefined });
    const tool = (await client.listTools()).tools.find((t) => t.name === GRADE_NAME)!;
    expect(tool.description).toContain("`BRAINCHAIN_NETWORK=testnet BRAINCHAIN_FREE_URL='http://127.0.0.1:8787' npx -y brainchain-mcp@0.0.0-test login`");
    expect(tool.description).toContain("paid from a wallet set up with `BRAINCHAIN_NETWORK=testnet npx -y brainchain-mcp@0.0.0-test init`.");
    expect(text(await client.callTool({ name: GRADE_NAME, arguments: request }))).toContain("To pay as you go, run `BRAINCHAIN_NETWORK=testnet npx -y brainchain-mcp@0.0.0-test init` in a terminal.");
  });

  it("names a sign-in made for other free checks when this server has none to ask", async () => {
    const { fetchImpl, sent } = checks();
    const client = await connect({ BRAINCHAIN_NETWORK: "testnet" }, { fetch: fetchImpl, login: () => ({ token: TOKEN, url: "http://127.0.0.1:8787/", network: "testnet" }) });
    const result = await client.callTool({ name: GRADE_NAME, arguments: request });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(
      "This server has no wallet, and the GitHub sign-in on this machine is for the free checks at http://127.0.0.1:8787 on testnet, but this server uses none: BRAINCHAIN_FREE_URL is not set, and testnet has no free checks of its own. To use your free checks, add the server again with the line `login` printed, or run `login` with this server's BRAINCHAIN_NETWORK and BRAINCHAIN_FREE_URL.",
    );
    expect(text(result)).not.toContain("No paying key is set");
    expect(sent).toEqual([]);
    const none = await connect({ BRAINCHAIN_NETWORK: "testnet" }, { fetch: fetchImpl, login: () => undefined });
    expect(text(await none.callTool({ name: GRADE_NAME, arguments: request }))).toContain("No paying key is set");
  });

  it("stops only the grade tool for a BRAINCHAIN_FREE_URL it cannot use", async () => {
    const client = await connect({ BRAINCHAIN_FREE_URL: "http://example.com" }, { login: () => SIGNED_IN });
    const result = await client.callTool({ name: GRADE_NAME, arguments: request });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("BRAINCHAIN_FREE_URL must be an https URL, or http on localhost or 127.0.0.1. Fix it in this server's environment and restart the server.");
  });
});
