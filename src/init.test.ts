import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolveConfig, type Config } from "./config.js";
import { initWallet, installCommands, runInit } from "./init.js";
import type { WalletFunds } from "./server.js";

// init writes under the home folder by default, so each test gets its own.
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (importOriginal) => {
  const os = await importOriginal<typeof import("node:os")>();
  return { ...os, homedir: () => home.dir };
});

// Anvil's second default account: a public test key that holds nothing anywhere.
const KEY = "59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const ADDRESS = privateKeyToAccount(`0x${KEY}`).address;
const posix = process.platform !== "win32";

/** Balance reads in place of the chain, which these tests never touch. */
const holding = (funds: WalletFunds | Error) => vi.fn(async (_config: Config, _address: `0x${string}`) => (funds instanceof Error ? Promise.reject(funds) : funds));

function savedKey(contents = `${KEY}\n`): string {
  const path = join(mkdtempSync(join(tmpdir(), "brainchain-init-")), "payer.key");
  writeFileSync(path, contents, { mode: 0o600 });
  return path;
}

/** Runs a printed command through sh with its program swapped for one that prints the arguments it gets. */
function argumentsOf(command: string, program: string): string[] {
  const printed = execFileSync("sh", ["-c", `printf '%s\\n' ${command.slice(program.length + 1)}`], { encoding: "utf8" });
  return printed.slice(0, -1).split("\n");
}

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), "brainchain-home-"));
});

describe("init", () => {
  it("creates a key in ~/.brainchain/payer.key that only this account can read, says what to send it on Base, and never prints the key", async () => {
    const funds = holding(new Error("no chain in tests"));
    const { text, code } = await runInit({}, "0.0.0-test", { funds, platform: "darwin" });
    const path = join(home.dir, ".brainchain", "payer.key");
    const key = readFileSync(path, "utf8").trim();
    const { address } = privateKeyToAccount(key as `0x${string}`);

    expect(code).toBe(0);
    expect(key).toMatch(/^0x[0-9a-f]{64}$/);
    expect(text).not.toContain(key.slice(2));
    if (posix) {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(join(home.dir, ".brainchain")).mode & 0o777).toBe(0o700);
    }
    expect(text.split("\n").slice(0, 7)).toEqual([
      "Created a wallet to pay for BrainChain tasks. Its key is in ~/.brainchain/payer.key, readable only by your account, and init never prints it.",
      "",
      `${address} pays for tasks in USDC on Base.`,
      "Limits: 1 USDC per task or grade (BRAINCHAIN_MAX_PRICE_UNITS), 10 USDC per server run (BRAINCHAIN_BUDGET_UNITS), no daily limit (BRAINCHAIN_DAILY_UNITS), 10 USDG per bond (BRAINCHAIN_MAX_BOND_UNITS).",
      "It holds 0 USDC. A task costs 1 USDC, so send at least 1 USDC to it on Base before posting.",
      "It needs no ETH: each payment is a signature.",
      "",
    ]);
    expect(text).toContain("Once the USDC arrives, run `npx -y brainchain-mcp@0.0.0-test init` again to check the balance.");
    expect(text).toContain("claude mcp add brainchain --scope user -e BRAINCHAIN_PAYER_KEY_FILE=~/.brainchain/payer.key -- npx -y brainchain-mcp@0.0.0-test");
    expect(text).not.toMatch(/Permit2|approve/);
    // A wallet made a moment ago holds nothing, so the first run reads no chain.
    expect(funds).not.toHaveBeenCalled();
  });

  it("never replaces a key that is there, and reads that wallet's balance instead", async () => {
    const path = savedKey();
    const env = { BRAINCHAIN_PAYER_KEY_FILE: path };
    const empty = holding({ balance: 0n, eth: 0n });
    const first = await runInit(env, "0.0.0-test", { funds: empty, platform: "linux" });

    expect(readFileSync(path, "utf8")).toBe(`${KEY}\n`);
    expect(empty).toHaveBeenCalledWith(expect.objectContaining({ payOn: "base", network: "eip155:8453" }), ADDRESS);
    expect(first.code).toBe(1);
    expect(first.text).toContain(`${path} already holds a key, and init never replaces one. This is its wallet:\n\n${ADDRESS} pays for tasks in USDC on Base.`);
    expect(first.text).toContain(`It holds 0 USDC. A task costs 1 USDC, so send at least 1 USDC to it on Base before posting.\nRun \`BRAINCHAIN_PAYER_KEY_FILE=${path} npx -y brainchain-mcp@0.0.0-test init\` again to check.`);
    expect(first.text).not.toContain(KEY);

    const funded = await runInit(env, "0.0.0-test", { funds: holding({ balance: 1_000_000n, eth: 0n }), platform: "linux" });
    expect(funded.code).toBe(0);
    expect(funded.text).toContain("It holds 1 USDC.\nIt can pay for a task now.");

    const offline = await runInit(env, "0.0.0-test", { funds: holding(new Error("HTTP request failed.")), platform: "linux" });
    expect(offline.code).toBe(2);
    expect(offline.text).toContain("Its balance could not be read from Base (HTTP request failed.). The key and settings are fine.");
  });

  it("names USDG, the ETH for the approval and the approve command with BRAINCHAIN_PAY_ON=robinhood, and keeps those settings in every command", async () => {
    const env = { BRAINCHAIN_NETWORK: "testnet", BRAINCHAIN_PAY_ON: "robinhood" };
    const { text, code } = await runInit(env, "0.0.0-test", { funds: holding(new Error("unused")), platform: "darwin" });
    expect(code).toBe(0);
    expect(text).toContain("It holds 0 test USDG. A task costs 1 test USDG, so send at least 1 test USDG to it on Robinhood Chain testnet before posting.");
    expect(text).toContain(
      "Run `BRAINCHAIN_NETWORK=testnet BRAINCHAIN_PAY_ON=robinhood BRAINCHAIN_PAYER_KEY_FILE=~/.brainchain/payer.key npx -y brainchain-mcp@0.0.0-test approve` once; it needs a little ETH on Robinhood Chain testnet",
    );
    expect(text).toContain("run `BRAINCHAIN_NETWORK=testnet BRAINCHAIN_PAY_ON=robinhood npx -y brainchain-mcp@0.0.0-test init` again");
    expect(text).toContain("claude mcp add brainchain --scope user -e BRAINCHAIN_NETWORK=testnet -e BRAINCHAIN_PAY_ON=robinhood -e BRAINCHAIN_PAYER_KEY_FILE=~/.brainchain/payer.key -- npx -y brainchain-mcp@0.0.0-test");
    expect(text).not.toContain("It needs no ETH");
  });

  it("refuses a key in the shell, a relative path and a settings mistake before it writes anything", async () => {
    const run = (env: Record<string, string>) => runInit(env, "0.0.0-test", { funds: holding(new Error("unused")) });
    await expect(run({ BRAINCHAIN_PAYER_KEY: KEY })).rejects.toThrow("BRAINCHAIN_PAYER_KEY is set in this shell, and init keeps the key in a file instead. Unset it, then run init again.");
    await expect(run({ BRAINCHAIN_PAYER_KEY_FILE: "keys/payer.key" })).rejects.toThrow("BRAINCHAIN_PAYER_KEY_FILE must be an absolute path or start with ~/.");
    await expect(run({ BRAINCHAIN_PAY_ON: "solana" })).rejects.toThrow("BRAINCHAIN_PAY_ON must be robinhood or base.");
    expect(() => statSync(join(home.dir, ".brainchain"))).toThrow(/ENOENT/);
  });

  it("reports a file that is there and cannot hold a key, and leaves it alone", async () => {
    if (posix) {
      const loose = savedKey();
      chmodSync(loose, 0o644);
      await expect(runInit({ BRAINCHAIN_PAYER_KEY_FILE: loose }, "0.0.0-test", { funds: holding(new Error("unused")) })).rejects.toThrow(/can be read by other accounts.*chmod 600/);
    }
    const folder = join(home.dir, "folder");
    mkdirSync(folder);
    await expect(runInit({ BRAINCHAIN_PAYER_KEY_FILE: folder }, "0.0.0-test", { funds: holding(new Error("unused")) })).rejects.toThrow(/holding only the key/);
  });
});

describe("installCommands", () => {
  const base = resolveConfig({});
  const path = "/Users/me/my keys/it's.key";

  it("adds the server to Claude Code, Cursor and VS Code with the key file, each command one line that a shell reads back unchanged", () => {
    if (!posix) return;
    const [[claude, toClaude], [cursor, toCursor], [code, toCode]] = installCommands(base, "1.2.3", { BRAINCHAIN_PAYER_KEY_FILE: path }, "darwin") as [[string, string], [string, string], [string, string]];
    expect([claude, cursor, code]).toEqual(["Claude Code", "Cursor", "VS Code"]);
    for (const command of [toClaude, toCursor, toCode]) expect(command).not.toContain("\n");

    expect(argumentsOf(toClaude, "claude")).toEqual(["mcp", "add", "brainchain", "--scope", "user", "-e", `BRAINCHAIN_PAYER_KEY_FILE=${path}`, "--", "npx", "-y", "brainchain-mcp@1.2.3"]);

    const server = { command: "npx", args: ["-y", "brainchain-mcp@1.2.3"], env: { BRAINCHAIN_PAYER_KEY_FILE: path } };
    const [link] = argumentsOf(toCursor, "open");
    const url = new URL(link!);
    expect(`${url.protocol}//${url.host}${url.pathname}`).toBe("cursor://anysphere.cursor-deeplink/mcp/install");
    expect(url.searchParams.get("name")).toBe("brainchain");
    expect(JSON.parse(Buffer.from(url.searchParams.get("config")!, "base64").toString("utf8"))).toEqual(server);

    expect(toCode.startsWith("code --add-mcp ")).toBe(true);
    const [json] = argumentsOf(toCode, "code --add-mcp");
    expect(JSON.parse(json!)).toEqual({ name: "brainchain", type: "stdio", ...server });
  });

  it("opens links with the platform's own opener, and VS Code's install link on Windows, where a .cmd loses the quotes in JSON", () => {
    expect(installCommands(base, "1.2.3", { BRAINCHAIN_PAYER_KEY_FILE: "~/.brainchain/payer.key" }, "linux")[1]![1]).toMatch(/^xdg-open 'cursor:\/\//);
    const [[, claude], [, cursor], [, code]] = installCommands(base, "1.2.3", { BRAINCHAIN_PAYER_KEY_FILE: "~/.brainchain/payer.key" }, "win32") as [string, string][];
    expect(claude).toBe("claude mcp add brainchain --scope user -e BRAINCHAIN_PAYER_KEY_FILE=~/.brainchain/payer.key -- npx -y brainchain-mcp@1.2.3");
    expect(cursor).toMatch(/^Start-Process 'cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install\?name=brainchain&config=[\w%]+'$/);
    expect(code).toMatch(/^Start-Process 'https:\/\/vscode\.dev\/redirect\/mcp\/install\?name=brainchain&config=/);
    const config = new URL(code.slice("Start-Process '".length, -1)).searchParams.get("config")!;
    expect(JSON.parse(config)).toEqual({ command: "npx", args: ["-y", "brainchain-mcp@1.2.3"], env: { BRAINCHAIN_PAYER_KEY_FILE: "~/.brainchain/payer.key" } });
    // PowerShell takes a quoted word as written, with '' for a quote.
    expect(installCommands(base, "1.2.3", { BRAINCHAIN_PAYER_KEY_FILE: "C:\\Users\\me\\it's.key" }, "win32")[0]![1]).toContain(" -e 'BRAINCHAIN_PAYER_KEY_FILE=C:\\Users\\me\\it''s.key' -- ");
  });
});

describe("initWallet", () => {
  it("pays from the wallet init made when the shell names no key", () => {
    expect(initWallet({ BRAINCHAIN_NETWORK: "testnet" }, () => true)).toEqual({ BRAINCHAIN_NETWORK: "testnet", BRAINCHAIN_PAYER_KEY_FILE: "~/.brainchain/payer.key" });
  });

  it("leaves a key the shell names, and a machine without that wallet, as they are", () => {
    for (const env of [{ BRAINCHAIN_PAYER_KEY: "0x01" }, { BRAINCHAIN_PAYER_KEY_FILE: "/tmp/other.key" }]) expect(initWallet(env, () => true)).toBe(env);
    const env = {};
    expect(initWallet(env, () => false)).toBe(env);
  });
});
