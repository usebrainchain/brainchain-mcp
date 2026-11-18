import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { InsufficientFundsError, WaitForTransactionReceiptTimeoutError } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { PREMIUMS_NAME } from "./premiums.js";
import { READINESS_NAME } from "./readiness.js";
import { SIGHTINGS_NAME } from "./sightings.js";
import { TIMELINE_NAME } from "./timeline.js";
import { CHANGES_NAME, UNWATCH_NAME, WATCH_NAME } from "./changes.js";
import { resolveConfig } from "./config.js";
import { CUSTODY_NAME } from "./custody.js";
import { MAKERS_NAME } from "./makers.js";
import { MARKET_CAP_NAME } from "./marketcap.js";
import { CALL_NAME, CALLS_NAME } from "./calls.js";
import { TRACE_OUTCOMES_NAME } from "./outcomes.js";
import { gradeGuidance, guidance } from "./payments.js";
import { hasGitHubToken } from "./github.js";
import { approvalFailure, approvalUnconfirmed, approveCommand, cliCommand, createServer, INSTRUCTIONS, pastedKey, payerAccount, terminalHint, walletExitCode, walletReport, type ServerOptions } from "./server.js";
import {
  AGENT_RECORD_NAME,
  BOND_STATUS_NAME,
  BOND_TASK_NAME,
  EXAM_INFO_NAME,
  EXAM_STATUS_NAME,
  EXAM_SUBMIT_NAME,
  GET_GRADE_NAME,
  GET_TASK_NAME,
  GET_TASK_TOOL,
  GRADE_NAME,
  LICENCES_NAME,
  POST_TASK_NAME,
  SIT_EXAM_NAME,
} from "./tools.js";

// Anvil's second default account: a public test key that holds nothing anywhere.
const KEY = "59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const task = { title: "Explain a Merkle proof", brief: "In two paragraphs.", levels: ["Accurate and complete", "Accurate"] };
const order = `0x${"ab".repeat(32)}`;
const grade = { brief: "Sort 3, 1 and 2.", result: "1, 2, 3" };
const sitting = { agentId: "20424" };
const delivery = { sitting: order, item: 0, text: "def f(x):\n    return x" };
const EXAM_TOOLS = [EXAM_INFO_NAME, SIT_EXAM_NAME, EXAM_SUBMIT_NAME, EXAM_STATUS_NAME, LICENCES_NAME, AGENT_RECORD_NAME];

async function connect(env: Record<string, string | undefined>, options: ServerOptions = {}) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(env, "0.0.0-test", { log: () => {}, ...options }).connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  return client;
}

const text = (result: Awaited<ReturnType<Client["callTool"]>>) => (result.content as { text: string }[])[0]!.text;

function keyFile(contents: string, mode = 0o600): string {
  const path = join(mkdtempSync(join(tmpdir(), "brainchain-key-")), "payer.key");
  writeFileSync(path, contents);
  chmodSync(path, mode);
  return path;
}

describe("the server", () => {
  it("starts without a key, lists the tools, and says how to set the key when asked to pay", async () => {
    const reads: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      reads.push(String(input));
      return new Response(JSON.stringify({ order, state: "posted", task: { status: "hired" } }));
    }) as typeof fetch;
    const logged: string[] = [];
    const client = await connect({ BRAINCHAIN_NETWORK: "testnet" }, { fetch: fetchImpl, log: (message) => logged.push(message) });
    expect(logged).toEqual([]);

    expect(client.getServerVersion()).toMatchObject({ name: "brainchain", title: "BrainChain" });
    expect(client.getInstructions()).toBe(INSTRUCTIONS);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([POST_TASK_NAME, GET_TASK_NAME, GRADE_NAME, GET_GRADE_NAME, PREMIUMS_NAME, CUSTODY_NAME, MAKERS_NAME, READINESS_NAME, SIGHTINGS_NAME, TIMELINE_NAME, MARKET_CAP_NAME, TRACE_OUTCOMES_NAME, CALL_NAME, CALLS_NAME, CHANGES_NAME, WATCH_NAME, UNWATCH_NAME, BOND_TASK_NAME, BOND_STATUS_NAME, ...EXAM_TOOLS]);

    const post = await client.callTool({ name: POST_TASK_NAME, arguments: task });
    expect(post.isError).toBe(true);
    expect(text(post)).toContain("No paying key is set: point BRAINCHAIN_PAYER_KEY_FILE at a file holding the private key of the wallet that pays");
    expect(text(post)).toContain("add BRAINCHAIN_PAYER_KEY_FILE with its path to this server's env in your MCP client config (in Claude Code, `claude mcp add brainchain -e BRAINCHAIN_PAYER_KEY_FILE=~/.brainchain/payer.key -- npx -y brainchain-mcp`)");
    expect(text(post)).not.toMatch(/-e BRAINCHAIN_PAYER_KEY=/);
    expect(reads).toHaveLength(0);

    const get = await client.callTool({ name: GET_TASK_NAME, arguments: { order } });
    expect(get.isError).toBe(false);
    expect(JSON.parse(text(get))).toMatchObject({ order, done: false });
    expect(reads).toEqual([`https://brain.testnet.usebrainchain.com/x402/tasks/${order}`]);
  });

  it("reads the licence exam without a key, and asks for the key before it signs for a sitting, a delivery or the briefs", async () => {
    const reads: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      reads.push(String(input));
      return new Response(JSON.stringify({ price: "5.00 USD a sitting", pool: { inUse: [order] } }));
    }) as typeof fetch;
    const client = await connect({ BRAINCHAIN_NETWORK: "testnet" }, { fetch: fetchImpl });
    expect(JSON.parse(text(await client.callTool({ name: EXAM_INFO_NAME, arguments: {} })))).toEqual({ price: "5.00 USD a sitting", pool: { inUse: 1 } });
    expect(reads).toEqual(["https://brain.testnet.usebrainchain.com/exams"]);
    for (const call of [
      { name: SIT_EXAM_NAME, arguments: sitting },
      { name: EXAM_SUBMIT_NAME, arguments: delivery },
      { name: EXAM_STATUS_NAME, arguments: { sitting: order, briefs: true } },
    ]) {
      const result = await client.callTool(call);
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("No paying key is set");
      expect(text(result)).toContain("stop and tell your operator");
    }
    expect(reads).toHaveLength(1);

    const { address } = privateKeyToAccount(`0x${KEY}`);
    const { tools } = await (await connect({ BRAINCHAIN_PAYER_KEY: KEY })).listTools();
    expect(tools.find((tool) => tool.name === SIT_EXAM_NAME)!.description).toContain(`pays exactly that from this server's wallet ${address} on Robinhood Chain.`);
    expect(INSTRUCTIONS).toContain(`call ${SIT_EXAM_NAME} again with the same agentId and class`);
  });

  it("reports a setting it cannot read once at startup, in the post tool's description, and from every tool but the premiums", async () => {
    for (const [env, problem] of [
      [{ BRAINCHAIN_NETWORK: "devnet" }, "BRAINCHAIN_NETWORK must be mainnet or testnet."],
      [{ BRAINCHAIN_PAY_ON: "bse" }, "BRAINCHAIN_PAY_ON must be robinhood or base."],
      [{ BRAINCHAIN_DESK_URL: "notaurl" }, "BRAINCHAIN_DESK_URL must be an http or https URL."],
      [{ BRAINCHAIN_DESK_URL: "notaurl", BRAINCHAIN_BUDGET_UNITS: "-5" }, "BRAINCHAIN_DESK_URL must be an http or https URL."],
    ] as const) {
      const logged: string[] = [];
      const client = await connect({ ...env, BRAINCHAIN_PAYER_KEY: KEY }, { log: (message) => logged.push(message) });
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain(problem);

      const { tools } = await client.listTools();
      expect(tools).toHaveLength(25);
      const description = tools.find((tool) => tool.name === POST_TASK_NAME)!.description!;
      expect(description.startsWith(`Invalid setting: ${problem}`)).toBe(true);
      expect(description).not.toMatch(/USDG|USDC/);
      // No setting was read, so neither bond tool can run, and the cap is named by its variable rather than as 0.
      for (const name of [BOND_TASK_NAME, BOND_STATUS_NAME]) expect(tools.find((tool) => tool.name === name)!.description!.startsWith(`Invalid setting: ${problem}`)).toBe(true);
      expect(tools.find((tool) => tool.name === BOND_TASK_NAME)!.description).toContain("at most BRAINCHAIN_MAX_BOND_UNITS per task");
      expect(tools.map((tool) => tool.description).join(" ")).not.toContain("0 USDG");

      for (const call of [
        { name: POST_TASK_NAME, arguments: task },
        { name: GET_TASK_NAME, arguments: { order } },
        { name: GRADE_NAME, arguments: grade },
        { name: GET_GRADE_NAME, arguments: { grade: order } },
        { name: CALL_NAME, arguments: { token: "0x020bfC650A365f8BB26819deAAbF3E21291018b4" } },
        { name: BOND_TASK_NAME, arguments: { task: "12", amount: "5" } },
        { name: BOND_STATUS_NAME, arguments: { task: "12" } },
        { name: EXAM_INFO_NAME, arguments: {} },
        { name: SIT_EXAM_NAME, arguments: sitting },
        { name: EXAM_SUBMIT_NAME, arguments: delivery },
        { name: EXAM_STATUS_NAME, arguments: { sitting: order } },
        { name: LICENCES_NAME, arguments: sitting },
        { name: AGENT_RECORD_NAME, arguments: sitting },
      ]) {
        const result = await client.callTool(call);
        expect(result.isError).toBe(true);
        expect(text(result)).toContain(problem);
        // The setting comes first: a call that is wrong as well hears of the setting alone.
        expect(JSON.parse(text(await client.callTool({ name: call.name, arguments: {} })))).toEqual(JSON.parse(text(result)));
      }
      // The tools that read BitGo's lists and a market maker's wallet need no setting, so each answers for itself: here, about what it was sent.
      const custody = await client.callTool({ name: CUSTODY_NAME, arguments: { days: 0 } });
      expect(JSON.parse(text(custody))).toEqual({ error: "days must be a whole number from 1 to 90. Leave it out to look back 30 days." });
      for (const name of [MAKERS_NAME, READINESS_NAME, SIGHTINGS_NAME, TIMELINE_NAME, MARKET_CAP_NAME]) {
        const result = await client.callTool({ name, arguments: {} });
        expect(JSON.parse(text(result))).toEqual({ error: "token is required." });
      }
      expect(logged).toHaveLength(1);
    }
  });

  it("names the wallets BRAINCHAIN_MAKER_WALLETS adds in the market maker tool, and says nothing at startup", async () => {
    const logged: string[] = [];
    const client = await connect({ BRAINCHAIN_MAKER_WALLETS: "Acme=0xb97e4298c7f5f55360d207a6196125376675b3ea" }, { log: (message) => logged.push(message) });
    expect(logged).toEqual([]);
    const { tools } = await client.listTools();
    expect(tools.find((tool) => tool.name === MAKERS_NAME)!.description).toContain("This server also follows one more wallet that its operator added with BRAINCHAIN_MAKER_WALLETS: Acme at 0xB97e4298c7F5f55360d207a6196125376675B3eA.");
  });

  it("takes GITHUB_TOKEN silently, and reports one that is not a token without repeating it", async () => {
    const logged: string[] = [];
    await connect({ GITHUB_TOKEN: `github_pat_${"A1_".repeat(25)}` }, { log: (message) => logged.push(message) });
    expect(logged).toEqual([]);
    const pasted = "ghp_secret value\nX-Injected: yes";
    await connect({ GITHUB_TOKEN: pasted }, { log: (message) => logged.push(message) });
    expect(logged).toEqual([
      "brainchain-mcp has an invalid setting: GITHUB_TOKEN is not a GitHub token, which is letters, digits and underscores, so GitHub is read without one. Fix it in this server's environment and restart the server.",
    ]);
    expect(logged.join("")).not.toContain("secret");
    expect(hasGitHubToken()).toBe(false);
    await connect({});
  });

  it("reports a BRAINCHAIN_MAKER_WALLETS it cannot read once at startup, and stops only the tools that read the wallets", async () => {
    const problem = "The address of wallet 1 in BRAINCHAIN_MAKER_WALLETS must be 0x followed by 40 hex characters. Fix it in this server's environment and restart the server.";
    for (const env of [{}, { BRAINCHAIN_PAYER_KEY: KEY }, { BRAINCHAIN_NETWORK: "devnet" }]) {
      const logged: string[] = [];
      const client = await connect({ ...env, BRAINCHAIN_MAKER_WALLETS: "Acme=0x12" }, { log: (message) => logged.push(message) });
      expect(logged.filter((line) => line.includes("BRAINCHAIN_MAKER_WALLETS"))).toEqual([`brainchain-mcp has an invalid setting: ${problem}`]);
      const { tools } = await client.listTools();
      for (const [name, opening] of [[MAKERS_NAME, "How much of a Robinhood Chain token"], [TIMELINE_NAME, "Every dated public step"]] as const) {
        expect(tools.find((tool) => tool.name === name)!.description).toMatch(new RegExp(`^Invalid setting: ${problem.replace(/[.]/g, "\\.")} Until the operator fixes it, this tool only returns that error\\. ${opening}`));
        for (const sent of [{ token: "0x020bfC650A365f8BB26819deAAbF3E21291018b4" }, {}]) expect(JSON.parse(text(await client.callTool({ name, arguments: sent })))).toEqual({ error: problem });
      }
      for (const name of [POST_TASK_NAME, CUSTODY_NAME, READINESS_NAME, SIGHTINGS_NAME, MARKET_CAP_NAME]) expect(tools.find((tool) => tool.name === name)!.description).not.toContain("BRAINCHAIN_MAKER_WALLETS");
      expect(JSON.parse(text(await client.callTool({ name: CUSTODY_NAME, arguments: { days: 0 } })))).toEqual({ error: "days must be a whole number from 1 to 90. Leave it out to look back 30 days." });
      for (const name of [READINESS_NAME, SIGHTINGS_NAME, MARKET_CAP_NAME]) expect(JSON.parse(text(await client.callTool({ name, arguments: {} })))).toEqual({ error: "token is required." });
    }
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toContain("A `BRAINCHAIN_MAKER_WALLETS` it cannot read stops `brainchain_market_maker_holdings` and `brainchain_token_timeline`, which read the wallets it adds, and no other tool.");
  });

  it("stops only the tools that pay for a setting only payments read, and keeps reading orders, grades and bonds", async () => {
    for (const [env, problem] of [
      [{ BRAINCHAIN_BUDGET_UNITS: "-5" }, "BRAINCHAIN_BUDGET_UNITS must be a positive whole number of base units."],
      [{ BRAINCHAIN_MAX_PRICE_UNITS: "abc" }, "BRAINCHAIN_MAX_PRICE_UNITS must be a positive whole number of base units."],
      [{ BRAINCHAIN_DAILY_UNITS: "1.5" }, "BRAINCHAIN_DAILY_UNITS must be a positive whole number of base units."],
      [{ BRAINCHAIN_MAX_BOND_UNITS: "1" }, "BRAINCHAIN_MAX_BOND_UNITS must be at least 2000000"],
      [{ BRAINCHAIN_STATE_DIR: "~other" }, "BRAINCHAIN_STATE_DIR must be an absolute path or start with ~/."],
      [{ BRAINCHAIN_PAYMENT_RPC: "notaurl" }, "BRAINCHAIN_PAYMENT_RPC must be an http or https URL."],
      [{ BRAINCHAIN_PAYMENT_NETWORK: "base" }, "BRAINCHAIN_PAYMENT_NETWORK must look like eip155:<chain id>."],
      [{ BRAINCHAIN_PAYMENT_ASSET: "usdg" }, "BRAINCHAIN_PAYMENT_ASSET must be a 0x-prefixed, 40-character hex address."],
      [{ BRAINCHAIN_PAY_TO: "0x12" }, "BRAINCHAIN_PAY_TO must be a 0x-prefixed, 40-character hex address."],
      [{ BRAINCHAIN_DESK_URL: "http://127.0.0.1:4000" }, "BRAINCHAIN_DESK_URL names a desk other than the network's own, so set BRAINCHAIN_PAY_TO"],
    ] as const) {
      const asked: string[] = [];
      const fetchImpl = (async (input: RequestInfo | URL) => {
        asked.push(String(input));
        return new Response(JSON.stringify({ order, state: "posted", task: { status: "hired" } }));
      }) as typeof fetch;
      const logged: string[] = [];
      const client = await connect({ ...env, BRAINCHAIN_PAYER_KEY: KEY }, { fetch: fetchImpl, log: (message) => logged.push(message) });
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain(problem);

      const { tools } = await client.listTools();
      for (const name of [POST_TASK_NAME, GRADE_NAME, BOND_TASK_NAME, SIT_EXAM_NAME]) {
        expect(tools.find((tool) => tool.name === name)!.description).toMatch(/^Invalid setting: /);
        expect(tools.find((tool) => tool.name === name)!.description).toContain(problem);
      }
      // Delivering an exam item signs and pays nothing, so a setting only payments read leaves it alone.
      for (const name of [GET_TASK_NAME, GET_GRADE_NAME, BOND_STATUS_NAME, PREMIUMS_NAME, EXAM_INFO_NAME, EXAM_SUBMIT_NAME, EXAM_STATUS_NAME, LICENCES_NAME, AGENT_RECORD_NAME]) {
        expect(tools.find((tool) => tool.name === name)!.description).not.toContain("Invalid setting");
      }

      for (const call of [
        { name: POST_TASK_NAME, arguments: task },
        { name: GRADE_NAME, arguments: grade },
        { name: BOND_TASK_NAME, arguments: { task: "12", amount: "5" } },
        { name: SIT_EXAM_NAME, arguments: sitting },
      ]) {
        const result = await client.callTool(call);
        expect(result.isError).toBe(true);
        expect(text(result)).toContain(problem);
      }
      expect(asked).toEqual([]);
      for (const call of [{ name: GET_TASK_NAME, arguments: { order } }, { name: GET_GRADE_NAME, arguments: { grade: order } }]) expect((await client.callTool(call)).isError).toBe(false);
      // The reads go to the desk the settings name, a desk of one's own included.
      const desk = "BRAINCHAIN_DESK_URL" in env ? env.BRAINCHAIN_DESK_URL : "https://brain.usebrainchain.com";
      expect(asked).toEqual([`${desk}/x402/tasks/${order}`, `${desk}/x402/grades/${order}`]);
    }
  });

  it("names a placeholder the client passed through instead of a key", async () => {
    for (const placeholder of ["${env:BRAINCHAIN_PAYER_KEY}", "$BRAINCHAIN_PAYER_KEY", "${BRAINCHAIN_PAYER_KEY}"]) {
      const client = await connect({ BRAINCHAIN_PAYER_KEY: ` ${placeholder} ` });
      const result = await client.callTool({ name: POST_TASK_NAME, arguments: task });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain(
        `BRAINCHAIN_PAYER_KEY is not set: your MCP client passed the placeholder ${placeholder} through unexpanded, so the variable was not set when the client started. Keep the key in a file only your account can read`,
      );
    }
  });

  it("reports a key it cannot use once at startup, leads the post tool with it, and still reads orders", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ order, state: "posted", task: { status: "hired" } }))) as typeof fetch;
    for (const [env, problem] of [
      [{ BRAINCHAIN_PAYER_KEY: "abc" }, "BRAINCHAIN_PAYER_KEY must be 64 hex characters"],
      [{ BRAINCHAIN_PAYER_KEY: "${BRAINCHAIN_PAYER_KEY}" }, "your MCP client passed the placeholder ${BRAINCHAIN_PAYER_KEY} through unexpanded"],
      [{ BRAINCHAIN_PAYER_KEY_FILE: "/nonexistent/payer.key" }, "BRAINCHAIN_PAYER_KEY_FILE could not be read: /nonexistent/payer.key (ENOENT)."],
    ] as const) {
      const logged: string[] = [];
      const client = await connect(env, { fetch: fetchImpl, log: (message) => logged.push(message) });
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain(problem);
      const { tools } = await client.listTools();
      // Reading a bond and delivering an exam item need the key too, so all six tools lead with the problem.
      for (const name of [POST_TASK_NAME, GRADE_NAME, BOND_TASK_NAME, BOND_STATUS_NAME, SIT_EXAM_NAME, EXAM_SUBMIT_NAME]) {
        expect(tools.find((tool) => tool.name === name)!.description).toMatch(/^Invalid setting: /);
        expect(tools.find((tool) => tool.name === name)!.description).toContain(problem);
      }
      // The tools that need the key answer with the problem, on a network where bonds are closed too.
      for (const call of [
        { name: POST_TASK_NAME, arguments: task },
        { name: GRADE_NAME, arguments: grade },
        { name: BOND_TASK_NAME, arguments: { task: "12", amount: "5" } },
        { name: BOND_STATUS_NAME, arguments: { task: "12" } },
        { name: SIT_EXAM_NAME, arguments: sitting },
        { name: EXAM_SUBMIT_NAME, arguments: delivery },
      ]) {
        for (const network of ["mainnet", "testnet"]) {
          const result = await (await connect({ ...env, BRAINCHAIN_NETWORK: network }, { fetch: fetchImpl })).callTool(call);
          expect(result.isError).toBe(true);
          expect(text(result)).toContain(problem);
          expect(text(result)).toContain("stop and tell your operator");
        }
      }
      expect((await client.callTool({ name: GET_TASK_NAME, arguments: { order } })).isError).toBe(false);
      expect((await client.callTool({ name: GET_GRADE_NAME, arguments: { grade: order } })).isError).toBe(false);
    }
  });

  it("reports at startup a state folder that cannot hold the daily limit's record, only when a daily limit is set", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "brainchain-state-")), "not-a-folder");
    writeFileSync(file, "");
    const env = { BRAINCHAIN_NETWORK: "testnet", BRAINCHAIN_PAYER_KEY: KEY, BRAINCHAIN_STATE_DIR: file };
    const logged: string[] = [];
    const client = await connect({ ...env, BRAINCHAIN_DAILY_UNITS: "2000000" }, { log: (message) => logged.push(message) });
    expect(logged).toEqual([`brainchain-mcp has an invalid setting: BRAINCHAIN_STATE_DIR is ${file}, which is not a folder, so the daily limit's record cannot be kept there. Set it to a folder this account can write, then restart the server.`]);
    const { tools } = await client.listTools();
    expect(tools.find((tool) => tool.name === POST_TASK_NAME)!.description).toMatch(/^Invalid setting: BRAINCHAIN_STATE_DIR is /);
    await connect(env, { log: (message) => logged.push(message) });
    expect(logged).toHaveLength(1);
  });

  it("only returns the setting error from the tools that pay when the state folder was refused at start, and asks the desk for nothing", async () => {
    for (const stateDir of ["/proc/brainchain", "/dev/shm/brainchain", "/sys/brainchain"]) {
      const problem = `BRAINCHAIN_STATE_DIR is ${stateDir}, which is a system folder, so the daily limit's record cannot be kept there. Set it to a folder this account can write, then restart the server.`;
      for (const network of ["mainnet", "testnet"]) {
        const asked: string[] = [];
        const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init);
          asked.push(`${request.method} ${request.url}`);
          return new Response(JSON.stringify({ order, state: "posted", task: { status: "hired" } }));
        }) as typeof fetch;
        const logged: string[] = [];
        const client = await connect(
          { BRAINCHAIN_NETWORK: network, BRAINCHAIN_PAYER_KEY: KEY, BRAINCHAIN_DAILY_UNITS: "1000000", BRAINCHAIN_STATE_DIR: stateDir },
          { fetch: fetchImpl, log: (message) => logged.push(message) },
        );
        expect(logged).toEqual([`brainchain-mcp has an invalid setting: ${problem}`]);

        const { tools } = await client.listTools();
        for (const [name, valid] of [[POST_TASK_NAME, task], [GRADE_NAME, grade], [BOND_TASK_NAME, { task: "12", amount: "5" }], [SIT_EXAM_NAME, sitting]] as const) {
          expect(tools.find((tool) => tool.name === name)!.description).toMatch(new RegExp(`^Invalid setting: ${problem.replace(/[.]/g, "\\.")} Until .* this tool only returns that error\\. `));
          // A call that is wrong in itself gets the same answer: the tool returns that error and nothing else.
          for (const sent of [valid, {}, { task: "0", extra: true }]) {
            const result = await client.callTool({ name, arguments: sent });
            expect(result.isError).toBe(true);
            expect(JSON.parse(text(result))).toEqual({ error: problem });
          }
        }
        expect(asked).toEqual([]);

        // Reading an order or a grade pays nothing and needs no record.
        expect((await client.callTool({ name: GET_TASK_NAME, arguments: { order } })).isError).toBe(false);
        expect((await client.callTool({ name: GET_GRADE_NAME, arguments: { grade: order } })).isError).toBe(false);
        expect(asked).toHaveLength(2);

        // The premiums, BitGo's additions, a market maker's holdings and a token's readiness and sightings read public data and no setting, so each answers for itself.
        for (const name of [PREMIUMS_NAME, CUSTODY_NAME, MAKERS_NAME, READINESS_NAME, SIGHTINGS_NAME, TIMELINE_NAME, MARKET_CAP_NAME]) expect(tools.find((tool) => tool.name === name)!.description).not.toContain("Invalid setting");
        expect(JSON.parse(text(await client.callTool({ name: CUSTODY_NAME, arguments: { days: 0 } })))).toEqual({ error: "days must be a whole number from 1 to 90. Leave it out to look back 30 days." });
        for (const name of [MAKERS_NAME, READINESS_NAME, SIGHTINGS_NAME, TIMELINE_NAME, MARKET_CAP_NAME]) expect(JSON.parse(text(await client.callTool({ name, arguments: {} })))).toEqual({ error: "token is required." });

        // Nor does reading a bond: its description names no problem, and on testnet it answers as it always does there.
        const status = tools.find((tool) => tool.name === BOND_STATUS_NAME)!.description!;
        expect(status).not.toContain("Invalid setting");
        expect(status).toMatch(network === "mainnet" ? /^Where this server's wallet 0x[0-9a-fA-F]{40}'s bonds on a task stand: / : /^Delivery bonds run on Robinhood Chain /);
        if (network === "testnet") {
          const read = await client.callTool({ name: BOND_STATUS_NAME, arguments: { task: "12" } });
          expect(JSON.parse(text(read))).toEqual({ error: expect.stringMatching(/^Delivery bonds run on Robinhood Chain /) });
        }
      }
    }
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toContain(
      "A key it cannot use stops `brainchain_post_task`, `brainchain_grade`, `brainchain_call`, `brainchain_bond_task`, `brainchain_sit_exam`, `brainchain_exam_submit`, which signs each delivery, and `brainchain_bond_status`, which reads this wallet's bonds; `brainchain_get_task` and `brainchain_get_grade` need no key and keep working, as do the tools that read the exam, a sitting, an agent's licences and its record.",
    );
    expect(readme).toContain("A setting only payments read stops just the five tools that pay, `brainchain_post_task`, `brainchain_grade`, `brainchain_call`, `brainchain_bond_task` and `brainchain_sit_exam`; the other twenty keep working.");
    expect(readme).toContain("`brainchain_post_task`, `brainchain_grade`, `brainchain_call`, `brainchain_bond_task` and `brainchain_sit_exam` spend from the wallet");
    expect(readme).toContain("stops every tool but `brainchain_stock_premiums`, `brainchain_custody_additions`, `brainchain_market_maker_holdings`, `brainchain_token_readiness`, `brainchain_token_sightings`, `brainchain_token_timeline`, `brainchain_token_market_cap`, `brainchain_trace_outcomes`, `brainchain_calls`, `brainchain_changes`, `brainchain_watch` and `brainchain_unwatch`.");
    expect(readme).toContain("`BRAINCHAIN_STATE_DIR` (including a folder that cannot hold the daily limit's record when `BRAINCHAIN_DAILY_UNITS` is set)");
    expect(readme).not.toContain("the task and bond tools return the error");
  });

  it("stops the bond status for a key it cannot use, and names that problem alone", async () => {
    const stateDir = "/proc/brainchain";
    const logged: string[] = [];
    const client = await connect({ BRAINCHAIN_PAYER_KEY: "abc", BRAINCHAIN_DAILY_UNITS: "1000000", BRAINCHAIN_STATE_DIR: stateDir }, { log: (message) => logged.push(message) });
    expect(logged[0]).toContain("BRAINCHAIN_PAYER_KEY must be 64 hex characters");
    expect(logged[0]).toContain("BRAINCHAIN_STATE_DIR is /proc/brainchain, which is a system folder");
    const { tools } = await client.listTools();
    const status = tools.find((tool) => tool.name === BOND_STATUS_NAME)!.description!;
    expect(status).toMatch(/^Invalid setting: BRAINCHAIN_PAYER_KEY must be 64 hex characters, with or without 0x\. Until the operator fixes it, this tool only returns that error\. Where /);
    expect(status).not.toContain("BRAINCHAIN_STATE_DIR");
    const read = text(await client.callTool({ name: BOND_STATUS_NAME, arguments: { task: "12" } }));
    expect(read).toContain("BRAINCHAIN_PAYER_KEY must be 64 hex characters");
    expect(read).not.toContain("BRAINCHAIN_STATE_DIR");
    // The tools that pay name both.
    for (const call of [{ name: GRADE_NAME, arguments: grade }, { name: BOND_TASK_NAME, arguments: { task: "12", amount: "5" } }]) {
      expect(text(await client.callTool(call))).toContain("BRAINCHAIN_STATE_DIR is /proc/brainchain");
    }
  });

  it("answers an order or grade id the desk does not know as an error", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: "No order with that id." }), { status: 404 })) as typeof fetch;
    const client = await connect({}, { fetch: fetchImpl });
    for (const [name, args, said] of [
      [GET_TASK_NAME, { order }, "The desk has no order with this id. Check the id: it must be one that brainchain_post_task returned."],
      [GET_GRADE_NAME, { grade: order }, "The desk has no grade with this id. Check the id: it must be one that brainchain_grade returned."],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
      expect(JSON.parse(text(result))).toEqual({ error: said });
      expect(text(result)).not.toContain("never charged");
    }
  });

  it("names the wallet that pays in the post tool, so an agent never needs the key to find it", async () => {
    const { address } = privateKeyToAccount(`0x${KEY}`);
    for (const env of [{ BRAINCHAIN_PAYER_KEY: KEY }, { BRAINCHAIN_PAYER_KEY_FILE: keyFile(`${KEY}\n`) }]) {
      const { tools } = await (await connect(env)).listTools();
      const description = tools.find((tool) => tool.name === POST_TASK_NAME)!.description!;
      expect(description).toContain(`this server's wallet ${address} on Base`);
      expect(description).not.toContain(KEY);
    }
    const { tools } = await (await connect({})).listTools();
    expect(tools.find((tool) => tool.name === POST_TASK_NAME)!.description).toContain("this server's wallet on Base");
  });

  it("says how a rejected task ends without a refund wherever it says the task stays not done", () => {
    const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    const row = read("README.md").split("\n").find((line) => line.startsWith(`| \`${GET_TASK_NAME}\` |`))!;
    for (const text of [INSTRUCTIONS, GET_TASK_TOOL.description!, row, read("examples/openclaw/brainchain/SKILL.md")]) {
      expect(text).toContain("Two things end it without a refund transaction: a ruling that pays");
      expect(text).toContain("refund-failed");
    }
    // What those sentences describe: the order is done, with no refund transaction, in both cases.
    const config = resolveConfig({});
    const rejected = { network: config.network, task: { status: "refunded", accepted: false } };
    expect(guidance({ ...rejected, state: "refund-failed" }, config)).toEqual({ done: true, next: "The refund could not be sent automatically. Write to hello@usebrainchain.com with this order id." });
    expect(guidance({ network: config.network, state: "paid-out", task: { status: "paid", accepted: false } }, config)).toEqual({ done: true, next: "The model was paid." });
    expect(guidance({ network: config.network, state: "posted", task: { status: "paid", accepted: false } }, config)).toEqual({ done: true, next: "The model was paid." });
    expect(guidance({ network: config.network, state: "posted", task: { status: "graded", accepted: false } }, config).done).toBe(false);
  });

  it("shows sample replies in the README that match what the server says for them", () => {
    const section = readFileSync(new URL("../README.md", import.meta.url), "utf8").split("\n### Sample replies\n")[1]!.split("\n## ")[0]!;
    const [order, decided] = [...section.matchAll(/```json\n([\s\S]*?)\n```/g)].map(([, json]) => JSON.parse(json!) as Record<string, unknown>);
    const { done, next, ...view } = order!;
    expect(guidance({ ...view, resultText: "The result." }, resolveConfig({}))).toEqual({ done, next });
    const { done: gradeDone, next: gradeNext, ...verdict } = decided!;
    expect(gradeGuidance(verdict)).toEqual({ done: gradeDone, next: gradeNext });
    expect(section).toContain("are examples");
  });

  it("tells an agent to leave the key alone", () => {
    expect(INSTRUCTIONS).toContain("Never read it, print it, write it down or pass it to a command.");
  });

  it("explains a malformed key without echoing it", async () => {
    const client = await connect({ BRAINCHAIN_PAYER_KEY: "0x1234" });
    const result = await client.callTool({ name: POST_TASK_NAME, arguments: task });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/BRAINCHAIN_PAYER_KEY must be 64 hex characters/);
    expect(text(result)).not.toContain("1234");
  });
});

describe("payerAccount", () => {
  it("takes the key trimmed, with or without 0x", () => {
    const { address } = privateKeyToAccount(`0x${KEY}`);
    for (const key of [KEY, `0x${KEY}`, `  0X${KEY.toUpperCase()}\n`]) expect(payerAccount({ BRAINCHAIN_PAYER_KEY: key }).address).toBe(address);
  });

  it("never echoes key material that starts with $", () => {
    expect(() => payerAccount({ BRAINCHAIN_PAYER_KEY: `$${KEY}` })).toThrow(/^BRAINCHAIN_PAYER_KEY is not set: your MCP client passed the placeholder through unexpanded,/);
  });

  it("reads the key from a file, trimmed, with or without 0x", () => {
    const { address } = privateKeyToAccount(`0x${KEY}`);
    for (const contents of [KEY, `0x${KEY}\n`]) expect(payerAccount({ BRAINCHAIN_PAYER_KEY_FILE: keyFile(contents) }).address).toBe(address);
  });

  it("refuses a key file that others can read, a file that holds no key, or both ways of giving a key, and never echoes the contents", () => {
    if (process.platform !== "win32") expect(() => payerAccount({ BRAINCHAIN_PAYER_KEY_FILE: keyFile(KEY, 0o644) })).toThrow(/can be read by other accounts.*chmod 600/);
    for (const contents of ["", "not-a-key", `${KEY}${KEY}`]) {
      let message = "";
      try {
        payerAccount({ BRAINCHAIN_PAYER_KEY_FILE: keyFile(contents) });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toBe("The key in BRAINCHAIN_PAYER_KEY_FILE must be 64 hex characters, with or without 0x.");
    }
    expect(() => payerAccount({ BRAINCHAIN_PAYER_KEY_FILE: keyFile("x".repeat(300)) })).toThrow(/holding only the key/);
    expect(() => payerAccount({ BRAINCHAIN_PAYER_KEY_FILE: tmpdir() })).toThrow(/holding only the key/);
    expect(() => payerAccount({ BRAINCHAIN_PAYER_KEY_FILE: KEY })).toThrow("BRAINCHAIN_PAYER_KEY_FILE must be an absolute path or start with ~/.");
    expect(() => payerAccount({ BRAINCHAIN_PAYER_KEY: KEY, BRAINCHAIN_PAYER_KEY_FILE: keyFile(KEY) })).toThrow("not both");
  });

  it("refuses a missing, short or out-of-range key", () => {
    expect(() => payerAccount({ BRAINCHAIN_PAYER_KEY: "  " })).toThrow(/^No paying key is set: point BRAINCHAIN_PAYER_KEY_FILE at a file/);
    expect(() => payerAccount({ BRAINCHAIN_PAYER_KEY: "0x1234" })).toThrow(/64 hex characters/);
    expect(() => payerAccount({ BRAINCHAIN_PAYER_KEY: "0".repeat(64) })).toThrow(/not a valid private key/);
  });
});

describe("terminalHint", () => {
  it("says on one line, only in a terminal, that the server waits for an MCP client and how to add it to one", () => {
    const hint = terminalHint({ isTTY: true }, "0.0.0-test")!;
    expect(hint).toContain("brainchain-mcp 0.0.0-test speaks MCP on stdio and is waiting for a client");
    expect(hint).toContain("claude mcp add brainchain -e BRAINCHAIN_PAYER_KEY_FILE=~/.brainchain/payer.key -- npx -y brainchain-mcp@0.0.0-test");
    expect(hint).toContain("Run `npx -y brainchain-mcp@0.0.0-test init` to set up a paying wallet");
    expect(hint).not.toContain("\n");
    for (const stdin of [{ isTTY: false }, {}]) expect(terminalHint(stdin, "0.0.0-test")).toBeUndefined();
  });
});

describe("pastedKey", () => {
  it("never repeats an argument that looks like a private key, and says the key is exposed", () => {
    for (const args of [[KEY], ["wallet", `0x${KEY}`], ["approve", ` 0X${KEY.toUpperCase()} `], ["approve", "5", KEY], [`BRAINCHAIN_PAYER_KEY=0x${KEY}`], ["wallet 0x" + KEY]]) {
      const said = pastedKey(args)!;
      expect(said).toContain("looks like a private key");
      expect(said).toContain("shell history");
      expect(said).toContain("move the wallet's funds to a new key");
      expect(said.toLowerCase()).not.toContain(KEY);
    }
  });

  it("leaves other arguments alone", () => {
    for (const args of [[], ["wallet"], ["approve", "max"], ["approve", "100.5"], [KEY.slice(1)], [`${KEY}0`], [`0x${"g".repeat(64)}`]]) expect(pastedKey(args)).toBeUndefined();
  });
});

describe("approvalFailure", () => {
  const address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

  it("says the wallet needs ETH whichever way the chain words it", () => {
    const expected = `${address} needs a little ETH on Robinhood Chain testnet to send the approval.`;
    expect(approvalFailure(address, "Robinhood Chain testnet", new InsufficientFundsError({}))).toBe(expected);
    expect(approvalFailure(address, "Robinhood Chain testnet", new Error("insufficient funds for gas * price + value"))).toBe(expected);
  });

  it("passes on anything else, one line of it", () => {
    expect(approvalFailure(address, "Base", new Error("nonce too low\nmore detail"))).toBe("The approval failed: nonce too low");
  });
});

describe("approvalUnconfirmed", () => {
  const hash = `0x${"ab".repeat(32)}`;

  it("names a sent approval that has not confirmed as one that may still go through, never as failed", () => {
    expect(approvalUnconfirmed(hash, "Robinhood Chain", new WaitForTransactionReceiptTimeoutError({ hash: hash as `0x${string}` }))).toBe(
      `The approval ${hash} was sent on Robinhood Chain and has not confirmed yet. It may still go through: look it up in a Robinhood Chain block explorer before you run approve again.`,
    );
    expect(approvalUnconfirmed(hash, "Base", new Error("HTTP request failed.\n\nStatus: 503"))).toBe(
      `The approval ${hash} was sent on Base, and whether it confirmed could not be read (HTTP request failed). It may still go through: look it up in a Base block explorer before you run approve again.`,
    );
  });
});

describe("approveCommand", () => {
  // Only USDG pays through Permit2, and USDC on Base is the default, so every approve command names the chain.
  const mainnet = resolveConfig({ BRAINCHAIN_PAY_ON: "robinhood" });
  const testnet = resolveConfig({ BRAINCHAIN_NETWORK: "testnet", BRAINCHAIN_PAY_ON: "robinhood" });
  const command = "npx -y brainchain-mcp@0.0.0-test approve";
  const onRobinhood = `BRAINCHAIN_PAY_ON=robinhood ${command}`;

  it("adds only the payment chain for a key in BRAINCHAIN_PAYER_KEY, and never prints the key", () => {
    expect(approveCommand(mainnet, "0.0.0-test", { BRAINCHAIN_PAYER_KEY: KEY })).toBe(onRobinhood);
    expect(approveCommand(testnet, "0.0.0-test", { BRAINCHAIN_PAYER_KEY: KEY })).toBe(`BRAINCHAIN_NETWORK=testnet ${onRobinhood}`);
  });

  it("names the key file as it was given, so the command finds the key on its own", () => {
    expect(approveCommand(mainnet, "0.0.0-test", { BRAINCHAIN_PAYER_KEY_FILE: " ~/.brainchain/payer.key\n" })).toBe(`BRAINCHAIN_PAY_ON=robinhood BRAINCHAIN_PAYER_KEY_FILE=~/.brainchain/payer.key ${command}`);
    expect(approveCommand(testnet, "0.0.0-test", { BRAINCHAIN_PAYER_KEY_FILE: "/keys/payer.key" })).toBe(`BRAINCHAIN_NETWORK=testnet BRAINCHAIN_PAY_ON=robinhood BRAINCHAIN_PAYER_KEY_FILE=/keys/payer.key ${command}`);
  });

  it("names nothing for the default chain, since a new process pays there already", () => {
    expect(cliCommand("wallet", resolveConfig({}), "0.0.0-test", { BRAINCHAIN_PAYER_KEY: KEY })).toBe("npx -y brainchain-mcp@0.0.0-test wallet");
    expect(cliCommand("init", resolveConfig({ BRAINCHAIN_NETWORK: "testnet" }), "0.0.0-test", {})).toBe("BRAINCHAIN_NETWORK=testnet npx -y brainchain-mcp@0.0.0-test init");
  });

  it("quotes a path so a shell reads it back unchanged", () => {
    if (process.platform === "win32") return;
    for (const path of ["/my keys/payer.key", "/keys/it's/$HOME/`id`.key"]) {
      const [assignment] = approveCommand(mainnet, "0.0.0-test", { BRAINCHAIN_PAYER_KEY_FILE: path }).split(" npx ");
      expect(assignment!.startsWith("BRAINCHAIN_PAY_ON=robinhood ")).toBe(true);
      expect(execFileSync("sh", ["-c", `${assignment} printenv BRAINCHAIN_PAYER_KEY_FILE`], { encoding: "utf8" })).toBe(`${path}\n`);
    }
  });

  it("gives the PowerShell form on Windows, where an inline assignment is no command", () => {
    expect(approveCommand(mainnet, "0.0.0-test", { BRAINCHAIN_PAYER_KEY: KEY }, "win32")).toBe(`$env:BRAINCHAIN_PAY_ON='robinhood'; ${command}`);
    expect(approveCommand(testnet, "0.0.0-test", { BRAINCHAIN_PAYER_KEY_FILE: "~/.brainchain/payer.key" }, "win32")).toBe(
      `$env:BRAINCHAIN_NETWORK='testnet'; $env:BRAINCHAIN_PAY_ON='robinhood'; $env:BRAINCHAIN_PAYER_KEY_FILE='~/.brainchain/payer.key'; ${command}`,
    );
    expect(approveCommand(mainnet, "0.0.0-test", { BRAINCHAIN_PAYER_KEY_FILE: "~/it's/payer.key" }, "win32")).toBe(`$env:BRAINCHAIN_PAY_ON='robinhood'; $env:BRAINCHAIN_PAYER_KEY_FILE='~/it''s/payer.key'; ${command}`);
  });

  it("leaves out a value that is no path, which may be a key in the wrong variable", () => {
    for (const value of [KEY, `0x${KEY}`, "payer.key", "~other/payer.key"]) expect(approveCommand(mainnet, "0.0.0-test", { BRAINCHAIN_PAYER_KEY_FILE: value })).toBe(onRobinhood);
  });
});

describe("wallet", () => {
  const address = privateKeyToAccount(`0x${KEY}`).address;
  const testnet = resolveConfig({ BRAINCHAIN_NETWORK: "testnet", BRAINCHAIN_PAY_ON: "robinhood" });
  const approve = "BRAINCHAIN_NETWORK=testnet BRAINCHAIN_PAY_ON=robinhood npx -y brainchain-mcp@0.0.0-test approve";
  // Bonds are closed on testnet, so their cap is left out.
  const limits = "Limits: 1 test USDG per task or grade (BRAINCHAIN_MAX_PRICE_UNITS), 10 test USDG per server run (BRAINCHAIN_BUDGET_UNITS), no daily limit (BRAINCHAIN_DAILY_UNITS).";

  it("says what the wallet holds and what it still needs before a post can be paid", () => {
    expect(walletReport(testnet, address, { balance: 0n, allowance: 0n, eth: 0n }, approve)).toBe(
      [
        `${address} pays for tasks in test USDG on Robinhood Chain testnet.`,
        limits,
        "It holds 0 test USDG. A task costs 1 test USDG, so send at least 1 test USDG to it on Robinhood Chain testnet before posting.",
        `Permit2 is not approved to spend enough of its test USDG for a task. Run \`${approve}\` once; it needs a little ETH on Robinhood Chain testnet, and the wallet holds 0 ETH there.`,
      ].join("\n"),
    );
    expect(walletReport(testnet, address, { balance: 2_500_000n, allowance: 500_000n, eth: 10n ** 15n }, approve)).toContain(
      "It holds 2.5 test USDG.\nPermit2 is not approved to spend enough of its test USDG for a task (only 0.5). Run",
    );
    expect(walletReport(testnet, address, { balance: 1_000_000n, allowance: 100_000_000n, eth: 0n }, approve)).toContain("It holds 1 test USDG.\nPermit2 may spend up to 100 of its test USDG.");
    expect(walletReport(testnet, address, { balance: 1_000_000n, allowance: 2n ** 256n - 1n, eth: 0n }, approve)).toContain("Permit2 may spend any amount of its test USDG.");
  });

  it("treats a raised price limit as a ceiling: the wallet may hold enough to post while it holds less than that", () => {
    const raised = resolveConfig({ BRAINCHAIN_NETWORK: "testnet", BRAINCHAIN_PAY_ON: "robinhood", BRAINCHAIN_MAX_PRICE_UNITS: "5000000" });
    expect(walletReport(raised, address, { balance: 2_000_000n, allowance: 2_000_000n, eth: 0n }, approve)).toBe(
      [
        `${address} pays for tasks in test USDG on Robinhood Chain testnet.`,
        limits.replace("1 test USDG per task", "5 test USDG per task"),
        "It holds 2 test USDG. A task costs at most 5 test USDG; send at least 3 test USDG to it on Robinhood Chain testnet to cover that.",
        `Permit2 is not approved to spend enough of its test USDG for a task that costs 5 (only 2). Run \`${approve}\` once; it needs a little ETH on Robinhood Chain testnet, and the wallet holds 0 ETH there.`,
      ].join("\n"),
    );
    expect(walletReport(raised, address, { balance: 5_000_000n, allowance: 5_000_000n, eth: 0n }, approve)).toBe(
      `${address} pays for tasks in test USDG on Robinhood Chain testnet.\n${limits.replace("1 test USDG per task", "5 test USDG per task")}\nIt holds 5 test USDG.\nPermit2 may spend up to 5 of its test USDG.`,
    );
  });

  it("names the desk's price under a lower price limit, and says posts will be refused", () => {
    const capped = resolveConfig({ BRAINCHAIN_NETWORK: "testnet", BRAINCHAIN_PAY_ON: "robinhood", BRAINCHAIN_MAX_PRICE_UNITS: "500000" });
    expect(walletReport(capped, address, { balance: 0n, allowance: 0n, eth: 0n }, approve)).toBe(
      [
        `${address} pays for tasks in test USDG on Robinhood Chain testnet.`,
        limits.replace("1 test USDG per task", "0.5 test USDG per task"),
        "BRAINCHAIN_MAX_PRICE_UNITS lets this server pay at most 0.5 test USDG at a time, under the 1 test USDG a task costs, so posts will be refused until it is raised.",
        "It holds 0 test USDG. A task costs 1 test USDG, so send at least 1 test USDG to it on Robinhood Chain testnet before posting.",
        `Permit2 is not approved to spend enough of its test USDG for a task. Run \`${approve}\` once; it needs a little ETH on Robinhood Chain testnet, and the wallet holds 0 ETH there.`,
      ].join("\n"),
    );
    expect(walletReport(capped, address, new Error("HTTP request failed."), approve)).toContain("could not be read from Robinhood Chain testnet (HTTP request failed.). The key is fine.");
  });

  it("prints an approve command that finds a key kept in a file", () => {
    const fromFile = approveCommand(testnet, "0.0.0-test", { BRAINCHAIN_PAYER_KEY_FILE: "~/.brainchain/payer.key" });
    expect(walletReport(testnet, address, { balance: 1_000_000n, allowance: 0n, eth: 0n }, fromFile)).toContain(
      "Run `BRAINCHAIN_NETWORK=testnet BRAINCHAIN_PAY_ON=robinhood BRAINCHAIN_PAYER_KEY_FILE=~/.brainchain/payer.key npx -y brainchain-mcp@0.0.0-test approve` once;",
    );
  });

  it("names no approval for USDC, which pays by signature, and says when the chain could not be read", () => {
    const base = resolveConfig({ BRAINCHAIN_NETWORK: "testnet", BRAINCHAIN_PAY_ON: "base" });
    expect(walletReport(base, address, { balance: 3_000_000n, eth: 0n }, approve)).toBe(`${address} pays for tasks in test USDC on Base Sepolia.\n${limits.replaceAll("USDG", "USDC")}\nIt holds 3 test USDC.`);
    expect(walletReport(testnet, address, new Error("HTTP request failed.\n\nURL: http://127.0.0.1:1"), approve)).toBe(
      `${address} pays for tasks in test USDG on Robinhood Chain testnet.\n${limits}\nIts balance could not be read from Robinhood Chain testnet (HTTP request failed.). The key and settings are fine.`,
    );
  });

  it("lists every limit, the daily limit and the bond cap among them on mainnet", () => {
    const mainnet = resolveConfig({ BRAINCHAIN_PAY_ON: "robinhood", BRAINCHAIN_DAILY_UNITS: "5000000", BRAINCHAIN_MAX_BOND_UNITS: "3000000" });
    expect(walletReport(mainnet, address, new Error("down"), approve).split("\n")[1]).toBe(
      "Limits: 1 USDG per task or grade (BRAINCHAIN_MAX_PRICE_UNITS), 10 USDG per server run (BRAINCHAIN_BUDGET_UNITS), 5 per UTC day, USDG and USDC together (BRAINCHAIN_DAILY_UNITS), 3 USDG per bond (BRAINCHAIN_MAX_BOND_UNITS).",
    );
  });

  it("exits 0 only when the wallet can pay for a task, 1 when it cannot, and 2 when its balance could not be read", () => {
    const base = resolveConfig({ BRAINCHAIN_NETWORK: "testnet", BRAINCHAIN_PAY_ON: "base" });
    const raised = resolveConfig({ BRAINCHAIN_NETWORK: "testnet", BRAINCHAIN_PAY_ON: "robinhood", BRAINCHAIN_MAX_PRICE_UNITS: "5000000" });
    const capped = resolveConfig({ BRAINCHAIN_NETWORK: "testnet", BRAINCHAIN_PAY_ON: "robinhood", BRAINCHAIN_MAX_PRICE_UNITS: "500000" });
    for (const [config, funds, code] of [
      [testnet, { balance: 1_000_000n, allowance: 1_000_000n, eth: 0n }, 0],
      [testnet, { balance: 999_999n, allowance: 10_000_000n, eth: 0n }, 1],
      [testnet, { balance: 10_000_000n, allowance: 0n, eth: 0n }, 1],
      [base, { balance: 1_000_000n, eth: 0n }, 0],
      [base, { balance: 0n, eth: 0n }, 1],
      [raised, { balance: 2_000_000n, allowance: 2_000_000n, eth: 0n }, 1],
      [raised, { balance: 5_000_000n, allowance: 5_000_000n, eth: 0n }, 0],
      [capped, { balance: 10_000_000n, allowance: 10_000_000n, eth: 0n }, 1],
      [testnet, new Error("down"), 2],
      [capped, new Error("down"), 1],
    ] as const) {
      expect(walletExitCode(config, funds)).toBe(code);
    }
  });
});
