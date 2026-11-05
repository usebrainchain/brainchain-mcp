import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createKeyPairSignerFromBytes, getBase58Decoder } from "@solana/kit";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { InsufficientFundsError } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { PREMIUMS_NAME } from "./premiums.js";
import { resolveConfig } from "./config.js";
import { solanaSigner } from "./payments.js";
import { approvalFailure, createServer, INSTRUCTIONS, payerAccount, solanaPayer, walletReport, type ServerOptions } from "./server.js";
import { BOND_STATUS_NAME, BOND_TASK_NAME, GET_TASK_NAME, POST_TASK_NAME } from "./tools.js";

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

/** A fresh Solana key as wallets export it: the 32-byte seed, then the public key. */
async function solanaKey() {
  const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const secret = new Uint8Array(64);
  secret.set(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).slice(-32), 0);
  secret.set(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)), 32);
  return { secret, base58: getBase58Decoder().decode(secret), address: (await createKeyPairSignerFromBytes(secret)).address as string };
}

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
    expect(tools.map((tool) => tool.name)).toEqual([POST_TASK_NAME, GET_TASK_NAME, PREMIUMS_NAME, BOND_TASK_NAME, BOND_STATUS_NAME]);

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
      [{ BRAINCHAIN_PAY_ON: "bse" }, "BRAINCHAIN_PAY_ON must be robinhood, base or solana."],
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
      expect(tools).toHaveLength(5);
      const description = tools.find((tool) => tool.name === POST_TASK_NAME)!.description!;
      expect(description.startsWith(`Invalid setting: ${problem}`)).toBe(true);
      expect(description).not.toMatch(/USDG|USDC/);
      expect(tools.find((tool) => tool.name === BOND_TASK_NAME)!.description!.startsWith(`Invalid setting: ${problem}`)).toBe(true);

      for (const call of [
        { name: POST_TASK_NAME, arguments: task },
        { name: GET_TASK_NAME, arguments: { order } },
        { name: BOND_TASK_NAME, arguments: { task: "12", amount: "5" } },
        { name: BOND_STATUS_NAME, arguments: { task: "12" } },
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

describe("paying on Solana", () => {
  it("reads the wallet's key as base58 or a JSON array, from the environment or a file, and derives its address", async () => {
    const key = await solanaKey();
    const array = JSON.stringify([...key.secret]);
    for (const env of [{ BRAINCHAIN_SOLANA_KEY: key.base58 }, { BRAINCHAIN_SOLANA_KEY: ` ${array}\n` }, { BRAINCHAIN_SOLANA_KEY_FILE: keyFile(`${key.base58}\n`) }, { BRAINCHAIN_SOLANA_KEY_FILE: keyFile(array) }]) {
      const payer = solanaPayer(env);
      expect(payer.address).toBe(key.address);
      expect(payer.secret).toEqual(key.secret);
    }
  });

  it("refuses both ways at once, a placeholder, a file others can read, or anything but 64 bytes, and never echoes the key", async () => {
    const key = await solanaKey();
    expect(() => solanaPayer({ BRAINCHAIN_SOLANA_KEY: key.base58, BRAINCHAIN_SOLANA_KEY_FILE: keyFile(key.base58) })).toThrow("not both");
    expect(() => solanaPayer({ BRAINCHAIN_SOLANA_KEY: `$${key.base58}` })).toThrow(/^BRAINCHAIN_SOLANA_KEY is not set: your MCP client passed the placeholder through unexpanded,/);
    expect(() => solanaPayer({ BRAINCHAIN_SOLANA_KEY: "${BRAINCHAIN_SOLANA_KEY}" })).toThrow("placeholder ${BRAINCHAIN_SOLANA_KEY} through");
    if (process.platform !== "win32") expect(() => solanaPayer({ BRAINCHAIN_SOLANA_KEY_FILE: keyFile(key.base58, 0o644) })).toThrow(/chmod 600/);
    expect(() => solanaPayer({ BRAINCHAIN_SOLANA_KEY: " " })).toThrow(/Set BRAINCHAIN_SOLANA_KEY/);
    for (const bad of [getBase58Decoder().decode(key.secret.subarray(0, 32)), "0OIl", JSON.stringify([...key.secret.subarray(0, 63)]), JSON.stringify([...key.secret.subarray(0, 63), 256])]) {
      let message = "";
      try {
        solanaPayer({ BRAINCHAIN_SOLANA_KEY: bad });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toBe("BRAINCHAIN_SOLANA_KEY must be a 64-byte Solana secret key: base58, or a JSON array of 64 numbers.");
    }
  });

  it("refuses to sign with a key whose public half belongs to another key", async () => {
    const [one, two] = [await solanaKey(), await solanaKey()];
    const mixed = new Uint8Array([...one.secret.subarray(0, 32), ...two.secret.subarray(32)]);
    await expect(solanaSigner({ address: two.address, secret: mixed })).rejects.toThrow("not a valid key pair");
    expect((await solanaSigner(solanaPayer({ BRAINCHAIN_SOLANA_KEY: one.base58 }))).address).toBe(one.address);
  });

  it("names the Solana wallet in the post tool, asks for the Solana key, and keeps bonds on a Robinhood Chain key", async () => {
    const key = await solanaKey();
    const { tools } = await (await connect({ BRAINCHAIN_PAY_ON: "solana", BRAINCHAIN_SOLANA_KEY: key.base58 })).listTools();
    expect(tools.find((tool) => tool.name === POST_TASK_NAME)!.description).toContain(`Each task costs 1 USDC, paid from this server's wallet ${key.address} on Solana.`);
    expect(tools.find((tool) => tool.name === BOND_TASK_NAME)!.description).toContain("Delivery bonds lock USDG on Robinhood Chain, so they need a Robinhood Chain key beside the Solana one");

    const both = await connect({ BRAINCHAIN_PAY_ON: "solana", BRAINCHAIN_SOLANA_KEY: key.base58, BRAINCHAIN_PAYER_KEY: KEY });
    const bond = (await both.listTools()).tools.find((tool) => tool.name === BOND_TASK_NAME)!.description!;
    expect(bond).not.toContain("need a Robinhood Chain key");
    expect(bond).toContain(privateKeyToAccount(`0x${KEY}`).address);

    const keyless = await connect({ BRAINCHAIN_PAY_ON: "solana" });
    const post = await keyless.callTool({ name: POST_TASK_NAME, arguments: task });
    expect(post.isError).toBe(true);
    expect(text(post)).toContain("Set BRAINCHAIN_SOLANA_KEY to the secret key of the Solana wallet that pays for tasks");
    expect(text(post)).toContain("Add BRAINCHAIN_SOLANA_KEY to this server's env in your MCP client config");
    const bonded = await keyless.callTool({ name: BOND_TASK_NAME, arguments: { task: "1", amount: "5" } });
    expect(text(bonded)).toContain("need a Robinhood Chain key");
  });

  it("reports a Solana key it cannot use once at startup, without echoing it", async () => {
    const logged: string[] = [];
    await connect({ BRAINCHAIN_PAY_ON: "solana", BRAINCHAIN_SOLANA_KEY: "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T" }, { log: (message) => logged.push(message) });
    expect(logged).toEqual(["brainchain-mcp has an invalid setting: BRAINCHAIN_SOLANA_KEY must be a 64-byte Solana secret key: base58, or a JSON array of 64 numbers."]);
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

describe("wallet", () => {
  const address = privateKeyToAccount(`0x${KEY}`).address;
  const testnet = resolveConfig({ BRAINCHAIN_NETWORK: "testnet" });
  const approve = "BRAINCHAIN_NETWORK=testnet npx -y brainchain-mcp@0.0.0-test approve";

  it("says what the wallet holds and what it still needs before a post can be paid", () => {
    expect(walletReport(testnet, address, { balance: 0n, allowance: 0n, eth: 0n }, approve)).toBe(
      [
        `${address} pays for tasks in test USDG on Robinhood Chain testnet.`,
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

  it("says on Solana that the wallet needs USDC only", () => {
    const solana = resolveConfig({ BRAINCHAIN_NETWORK: "testnet", BRAINCHAIN_PAY_ON: "solana" });
    const owner = "9Qet6akwwgw1EMKbEY8H8QmE1VYtjHWXuAfq9mGiMheK";
    expect(walletReport(solana, owner, { balance: 3_000_000n }, approve)).toBe(
      `${owner} pays for tasks in test USDC on Solana devnet.\nIt holds 3 test USDC.\nThe payment facilitator pays the Solana network fee, so the wallet needs no SOL.`,
    );
    expect(walletReport(solana, owner, { balance: 0n }, approve)).toContain("send at least 1 test USDC to it on Solana devnet before posting.");
  });

  it("names no approval for USDC, which pays by signature, and says when the chain could not be read", () => {
    const base = resolveConfig({ BRAINCHAIN_NETWORK: "testnet", BRAINCHAIN_PAY_ON: "base" });
    expect(walletReport(base, address, { balance: 3_000_000n, eth: 0n }, approve)).toBe(`${address} pays for tasks in test USDC on Base Sepolia.\nIt holds 3 test USDC.`);
    expect(walletReport(testnet, address, new Error("HTTP request failed.\n\nURL: http://127.0.0.1:1"), approve)).toBe(
      `${address} pays for tasks in test USDG on Robinhood Chain testnet.\nIts balance could not be read from Robinhood Chain testnet (HTTP request failed.). The key and settings are fine.`,
    );
  });
});
