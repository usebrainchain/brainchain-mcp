import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

import { generatePrivateKey } from "viem/accounts";

import { expandHome, resolveConfig, type Config } from "./config.js";
import { cliCommand, payerAccount, paySettings, powershellWord, shellWord, walletExitCode, walletFunds, walletReport, type WalletFunds } from "./server.js";

export const KEY_FILE = "~/.brainchain/payer.key";

/** In a terminal, wallet, approve and solve pay from the wallet init made, unless the shell names another key. */
export function initWallet(env: Record<string, string | undefined>, exists: (path: string) => boolean = existsSync): Record<string, string | undefined> {
  if (env.BRAINCHAIN_PAYER_KEY?.trim() || env.BRAINCHAIN_PAYER_KEY_FILE?.trim() || !exists(expandHome(KEY_FILE))) return env;
  return { ...env, BRAINCHAIN_PAYER_KEY_FILE: KEY_FILE };
}

export interface InitOptions {
  platform?: NodeJS.Platform;
  funds?: (config: Config, address: `0x${string}`) => Promise<WalletFunds>;
}

const failed = (file: string, error: unknown) => new Error(`init could not create ${file} (${(error as NodeJS.ErrnoException).code ?? String(error)}).`);

/** Opened with O_EXCL, so a key already there is never replaced, not even by a second init running at the same moment. */
function createKeyFile(file: string, path: string): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  } catch (error) {
    throw failed(file, error);
  }
  try {
    writeFileSync(path, `${generatePrivateKey()}\n`, { mode: 0o600, flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw failed(file, error);
  }
}

/** The one line per client that adds this server with the key file and payment chain init set up. */
export function installCommands(config: Config, version: string, file: string, platform: NodeJS.Platform = process.platform): [string, string][] {
  const env = Object.fromEntries([...paySettings(config), ["BRAINCHAIN_PAYER_KEY_FILE", file]]);
  const server = { command: "npx", args: ["-y", `brainchain-mcp@${version}`], env };
  const windows = platform === "win32";
  const setting = ([name, value]: [string, string]) => {
    if (!windows) return `${name}=${shellWord(value)}`;
    // PowerShell gets the whole NAME=value word quoted, since how it splits a half-quoted one is not worth relying on.
    return /^[\w./~-]+$/.test(value) ? `${name}=${value}` : powershellWord(`${name}=${value}`);
  };
  const claude = ["claude mcp add brainchain --scope user", ...Object.entries(env).map((pair) => `-e ${setting(pair)}`), "--", "npx", ...server.args].join(" ");
  const open = windows ? "Start-Process" : platform === "darwin" ? "open" : "xdg-open";
  const quote = windows ? powershellWord : shellWord;
  const cursor = `cursor://anysphere.cursor-deeplink/mcp/install?name=brainchain&config=${encodeURIComponent(Buffer.from(JSON.stringify(server)).toString("base64"))}`;
  // `code --add-mcp` takes JSON, and PowerShell strips the quotes inside an argument to a .cmd file, so Windows opens VS Code's install link instead.
  const code = windows
    ? `${open} ${quote(`https://vscode.dev/redirect/mcp/install?name=brainchain&config=${encodeURIComponent(JSON.stringify(server))}`)}`
    : `code --add-mcp ${quote(JSON.stringify({ name: "brainchain", type: "stdio", ...server }))}`;
  return [
    ["Claude Code", claude],
    ["Cursor", `${open} ${quote(cursor)}`],
    ["VS Code", code],
  ];
}

/**
 * Creates a paying wallet in a key file, or checks the one already there: what it holds, what it still needs before
 * it can pay for a task, and how to add the server. The key is never printed.
 */
export async function runInit(env: Record<string, string | undefined>, version: string, options: InitOptions = {}): Promise<{ text: string; code: 0 | 1 | 2 }> {
  const { platform = process.platform, funds = walletFunds } = options;
  // The server refuses both at once, so a key left in the shell would stop the server init sets up.
  if (env.BRAINCHAIN_PAYER_KEY?.trim()) throw new Error("BRAINCHAIN_PAYER_KEY is set in this shell, and init keeps the key in a file instead. Unset it, then run init again.");
  const config = resolveConfig(env);
  const file = env.BRAINCHAIN_PAYER_KEY_FILE?.trim() || KEY_FILE;
  const path = expandHome(file);
  if (!isAbsolute(path)) throw new Error("BRAINCHAIN_PAYER_KEY_FILE must be an absolute path or start with ~/.");

  const created = createKeyFile(file, path);
  const { address } = payerAccount({ BRAINCHAIN_PAYER_KEY_FILE: file });
  const approve = cliCommand("approve", config, version, { BRAINCHAIN_PAYER_KEY_FILE: file }, platform);
  const again = cliCommand("init", config, version, file === KEY_FILE ? {} : { BRAINCHAIN_PAYER_KEY_FILE: file }, platform);
  const install = ["Add the server to your client:", ...installCommands(config, version, file, platform).flatMap(([client, command]) => ["", client, `  ${command}`])];

  if (created) {
    const empty: WalletFunds = { balance: 0n, ...(config.permit2 ? { allowance: 0n } : {}), eth: 0n };
    const text = [
      `Created a wallet to pay for BrainChain tasks. Its key is in ${file}${platform === "win32" ? "" : ", readable only by your account"}, and init never prints it.`,
      "",
      walletReport(config, address, empty, approve),
      ...(config.permit2 ? [] : ["It needs no ETH: each payment is a signature."]),
      "",
      `Once the ${config.token} arrives, run \`${again}\` again to check the balance.`,
      "",
      ...install,
    ];
    return { text: text.join("\n"), code: 0 };
  }

  const held = await funds(config, address).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
  const code = walletExitCode(config, held);
  const text = [
    `${file} already holds a key, and init never replaces one. This is its wallet:`,
    "",
    walletReport(config, address, held, approve),
    code === 0 ? "It can pay for a task now." : `Run \`${again}\` again to check.`,
    "",
    ...install,
  ];
  return { text: text.join("\n"), code };
}
