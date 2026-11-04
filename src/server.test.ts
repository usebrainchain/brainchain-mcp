import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { InsufficientFundsError } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { PREMIUMS_NAME } from "./premiums.js";
import { approvalFailure, createServer, INSTRUCTIONS, payerAccount, type ServerOptions } from "./server.js";
import { GET_TASK_NAME, POST_TASK_NAME } from "./tools.js";

// Anvil's second default account: a public test key that holds nothing anywhere.
const KEY = "59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const task = { title: "Explain a Merkle proof", brief: "In two paragraphs.", levels: ["Accurate and complete", "Accurate"] };
const order = `0x${"ab".repeat(32)}`;

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
    expect(tools.map((tool) => tool.name)).toEqual([POST_TASK_NAME, GET_TASK_NAME, PREMIUMS_NAME]);

    const post = await client.callTool({ name: POST_TASK_NAME, arguments: task });
    expect(post.isError).toBe(true);
    expect(text(post)).toMatch(/Set BRAINCHAIN_PAYER_KEY .* with or without 0x/);
    expect(text(post)).toContain("Add BRAINCHAIN_PAYER_KEY to this server's env in your MCP client config");
    expect(reads).toHaveLength(0);

    const get = await client.callTool({ name: GET_TASK_NAME, arguments: { order } });
    expect(get.isError).toBe(false);
    expect(JSON.parse(text(get))).toMatchObject({ order, done: false });
    expect(reads).toEqual([`https://brain.testnet.usebrainchain.com/x402/tasks/${order}`]);
  });

  it("reports a bad setting once at startup, in the post tool's description, and from both tools", async () => {
    for (const [env, problem] of [
      [{ BRAINCHAIN_NETWORK: "devnet" }, "BRAINCHAIN_NETWORK must be mainnet or testnet."],
      [{ BRAINCHAIN_PAY_ON: "bse" }, "BRAINCHAIN_PAY_ON must be robinhood or base."],
      [{ BRAINCHAIN_MAX_PRICE_UNITS: "abc" }, "BRAINCHAIN_MAX_PRICE_UNITS must be a positive whole number of base units."],
      [{ BRAINCHAIN_DESK_URL: "notaurl" }, "BRAINCHAIN_DESK_URL must be an http or https URL."],
      [{ BRAINCHAIN_PAYMENT_RPC: "notaurl" }, "BRAINCHAIN_PAYMENT_RPC must be an http or https URL."],
      [{ BRAINCHAIN_STATE_DIR: "~other" }, "BRAINCHAIN_STATE_DIR must be an absolute path or start with ~/."],
    ] as const) {
      const logged: string[] = [];
      const client = await connect({ ...env, BRAINCHAIN_PAYER_KEY: KEY }, { log: (message) => logged.push(message) });
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain(problem);

      const { tools } = await client.listTools();
      expect(tools).toHaveLength(3);
      const description = tools.find((tool) => tool.name === POST_TASK_NAME)!.description!;
      expect(description.startsWith(`Invalid setting: ${problem}`)).toBe(true);
      expect(description).not.toMatch(/USDG|USDC/);

      for (const call of [
        { name: POST_TASK_NAME, arguments: task },
        { name: GET_TASK_NAME, arguments: { order } },
      ]) {
        const result = await client.callTool(call);
        expect(result.isError).toBe(true);
        expect(text(result)).toContain(problem);
      }
      expect(logged).toHaveLength(1);
    }
  });

  it("names a placeholder the client passed through instead of a key", async () => {
    for (const placeholder of ["${env:BRAINCHAIN_PAYER_KEY}", "$BRAINCHAIN_PAYER_KEY", "${BRAINCHAIN_PAYER_KEY}"]) {
      const client = await connect({ BRAINCHAIN_PAYER_KEY: ` ${placeholder} ` });
      const result = await client.callTool({ name: POST_TASK_NAME, arguments: task });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain(
        `BRAINCHAIN_PAYER_KEY is not set: your MCP client passed the placeholder ${placeholder} through unexpanded, so the variable was not set when the client started. Add BRAINCHAIN_PAYER_KEY`,
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
      expect(tools.find((tool) => tool.name === POST_TASK_NAME)!.description).toMatch(/^Invalid setting: /);
      expect(tools.find((tool) => tool.name === POST_TASK_NAME)!.description).toContain(problem);
      const post = await client.callTool({ name: POST_TASK_NAME, arguments: task });
      expect(post.isError).toBe(true);
      expect(text(post)).toContain(problem);
      expect(text(post)).toContain("stop and tell your operator");
      expect((await client.callTool({ name: GET_TASK_NAME, arguments: { order } })).isError).toBe(false);
    }
  });

  it("names the wallet that pays in the post tool, so an agent never needs the key to find it", async () => {
    const { address } = privateKeyToAccount(`0x${KEY}`);
    for (const env of [{ BRAINCHAIN_PAYER_KEY: KEY }, { BRAINCHAIN_PAYER_KEY_FILE: keyFile(`${KEY}\n`) }]) {
      const { tools } = await (await connect(env)).listTools();
      const description = tools.find((tool) => tool.name === POST_TASK_NAME)!.description!;
      expect(description).toContain(`this server's wallet ${address} on Robinhood Chain`);
      expect(description).not.toContain(KEY);
    }
    const { tools } = await (await connect({})).listTools();
    expect(tools.find((tool) => tool.name === POST_TASK_NAME)!.description).toContain("this server's wallet on Robinhood Chain");
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
    expect(() => payerAccount({ BRAINCHAIN_PAYER_KEY: "  " })).toThrow(/Set BRAINCHAIN_PAYER_KEY/);
    expect(() => payerAccount({ BRAINCHAIN_PAYER_KEY: "0x1234" })).toThrow(/64 hex characters/);
    expect(() => payerAccount({ BRAINCHAIN_PAYER_KEY: "0".repeat(64) })).toThrow(/not a valid private key/);
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
