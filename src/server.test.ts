import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { createServer, INSTRUCTIONS, payerAccount, type ServerOptions } from "./server.js";
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

describe("the server", () => {
  it("starts without a key, lists both tools, and says how to set the key when asked to pay", async () => {
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
    expect(tools.map((tool) => tool.name)).toEqual([POST_TASK_NAME, GET_TASK_NAME]);

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
    ] as const) {
      const logged: string[] = [];
      const client = await connect({ ...env, BRAINCHAIN_PAYER_KEY: KEY }, { log: (message) => logged.push(message) });
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain(problem);

      const { tools } = await client.listTools();
      expect(tools).toHaveLength(2);
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

  it("refuses a missing, short or out-of-range key", () => {
    expect(() => payerAccount({ BRAINCHAIN_PAYER_KEY: "  " })).toThrow(/Set BRAINCHAIN_PAYER_KEY/);
    expect(() => payerAccount({ BRAINCHAIN_PAYER_KEY: "0x1234" })).toThrow(/64 hex characters/);
    expect(() => payerAccount({ BRAINCHAIN_PAYER_KEY: "0".repeat(64) })).toThrow(/not a valid private key/);
  });
});
