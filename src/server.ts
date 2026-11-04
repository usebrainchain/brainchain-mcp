import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createPublicClient, defineChain, http, parseAbi, type PrivateKeyAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { expandHome, resolveConfig, type Config } from "./config.js";
import { createDesk } from "./payments.js";
import { PREMIUMS_NAME, PREMIUMS_TOOL } from "./premiums.js";
import { callTool, GET_TASK_NAME, GET_TASK_TOOL, POST_TASK_NAME, postTaskTool, type Desk, type Terms } from "./tools.js";

/** The canonical Permit2 contract; x402 payments in USDG are signed Permit2 transfers. */
export const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
export const erc20 = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

export const INSTRUCTIONS =
  `Post a task with ${POST_TASK_NAME}, then read it with ${GET_TASK_NAME} and the order id it returns, waiting retryAfterSeconds between reads until done is true. ` +
  `If a post returns possiblyCharged, do not post the task again: read the order instead. ` +
  `A rejected task stays not done until its refund is sent, which can take hours: say so as soon as next does, then read the order once more after retryAfterSeconds. ` +
  `The paying wallet's key is for this server alone. Never read it, print it, write it down or pass it to a command. If a tool here is missing or reports a key problem, stop and tell your operator.`;

const KEY_HELP =
  `Add BRAINCHAIN_PAYER_KEY to this server's env in your MCP client config (in Claude Code, \`claude mcp add … -e BRAINCHAIN_PAYER_KEY=…\`), or BRAINCHAIN_PAYER_KEY_FILE with the path of a file holding it, then restart the server. ` +
  `${GET_TASK_NAME} and ${PREMIUMS_NAME} work without a key. An agent reading this: stop and tell your operator. Do not look for the key.`;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Read here and never echoed. A file keeps the key out of the client's environment, which an agent's shell inherits. */
function readKeyFile(given: string): string {
  const path = expandHome(given);
  if (!isAbsolute(path)) throw new Error("BRAINCHAIN_PAYER_KEY_FILE must be an absolute path or start with ~/.");
  try {
    const stats = statSync(path);
    if (!stats.isFile() || stats.size > 256) throw new Error(`BRAINCHAIN_PAYER_KEY_FILE must name a file holding only the key; ${path} does not.`);
    if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) throw new Error(`${path} can be read by other accounts on this machine. Run chmod 600 on it, then restart the server.`);
    return readFileSync(path, "utf8");
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code) throw new Error(`BRAINCHAIN_PAYER_KEY_FILE could not be read: ${path} (${code}).`);
    throw error;
  }
}

export function payerAccount(env: Record<string, string | undefined>): PrivateKeyAccount {
  const file = env.BRAINCHAIN_PAYER_KEY_FILE?.trim();
  const given = env.BRAINCHAIN_PAYER_KEY?.trim();
  if (file && given) throw new Error("Set BRAINCHAIN_PAYER_KEY or BRAINCHAIN_PAYER_KEY_FILE, not both.");
  // A client that cannot expand ${VAR} passes it through as written. Anything
  // that could be key material is never echoed.
  if (given?.startsWith("$")) {
    const shown = /[0-9a-f]{16,}/i.test(given) ? "" : ` ${given}`;
    throw new Error(`BRAINCHAIN_PAYER_KEY is not set: your MCP client passed the placeholder${shown} through unexpanded, so the variable was not set when the client started.`);
  }
  const key = (file ? readKeyFile(file) : given)?.trim().replace(/^0x/i, "");
  if (!file && !key) throw new Error("Set BRAINCHAIN_PAYER_KEY to the private key of the wallet that pays for tasks: 64 hex characters, with or without 0x.");
  const name = file ? "The key in BRAINCHAIN_PAYER_KEY_FILE" : "BRAINCHAIN_PAYER_KEY";
  if (!/^[0-9a-f]{64}$/i.test(key ?? "")) throw new Error(`${name} must be 64 hex characters, with or without 0x.`);
  try {
    return privateKeyToAccount(`0x${key}`);
  } catch {
    throw new Error(`${name} is not a valid private key.`);
  }
}

/** What a failed `approve` should tell a person. viem says the cost "exceeds the balance"; nodes say "insufficient funds". */
export function approvalFailure(address: string, chain: string, error: unknown): string {
  const message = error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error);
  return /insufficient funds|exceeds the balance/i.test(message) ? `${address} needs a little ETH on ${chain} to send the approval.` : `The approval failed: ${message}`;
}

export function chainClients(config: Config) {
  const chain = defineChain({
    id: config.chainId,
    name: config.chain,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [config.rpc] } },
  });
  return { chain, reader: createPublicClient({ chain, transport: http(config.rpc, { retryCount: 2, timeout: 15_000 }) }) };
}

export function approveCommand(config: Config, version: string): string {
  return `${config.name === "testnet" ? "BRAINCHAIN_NETWORK=testnet " : ""}npx -y brainchain-mcp@${version} approve`;
}

/** A missing key or a bad setting is reported when a tool needs it, so the server always starts and lists its tools. */
function deskFor(env: Record<string, string | undefined>, version: string, fetchImpl?: typeof fetch): { desk: Desk; terms: Terms | string } {
  let config: Config;
  try {
    config = resolveConfig(env);
  } catch (error) {
    const problem = `${messageOf(error)} Fix it in this server's environment and restart the server.`;
    const refuse = async (): Promise<never> => {
      throw new Error(problem);
    };
    return { desk: { post: refuse, get: refuse }, terms: problem };
  }

  let account: PrivateKeyAccount | undefined;
  let keyProblem: string | undefined;
  try {
    account = payerAccount(env);
  } catch (error) {
    // No key at all is a read-only server, which is allowed. A key that is there and unusable is a mistake to report.
    if (env.BRAINCHAIN_PAYER_KEY?.trim() || env.BRAINCHAIN_PAYER_KEY_FILE?.trim()) keyProblem = messageOf(error);
  }
  const payer = () => {
    try {
      return (account ??= payerAccount(env));
    } catch (error) {
      throw new Error(`${messageOf(error)} ${KEY_HELP}`);
    }
  };
  const { reader } = chainClients(config);
  const desk = createDesk({
    config,
    signer: payer,
    approveCommand: approveCommand(config, version),
    fetch: fetchImpl,
    funds: async () => {
      const { address } = payer();
      const [balance, allowance] = await Promise.all([
        reader.readContract({ address: config.asset, abi: erc20, functionName: "balanceOf", args: [address] }),
        config.permit2 ? reader.readContract({ address: config.asset, abi: erc20, functionName: "allowance", args: [address, PERMIT2] }) : undefined,
      ]);
      return { balance, allowance };
    },
  });
  return { desk, terms: { ...config.terms, ...(account ? { wallet: account.address } : {}), ...(keyProblem ? { keyProblem } : {}) } };
}

export interface ServerOptions {
  fetch?: typeof fetch;
  /** Where a configuration error is reported once at startup; stderr by default, since stdout carries the protocol. */
  log?: (message: string) => void;
}

export function createServer(env: Record<string, string | undefined>, version: string, options: ServerOptions = {}): Server {
  const { desk, terms } = deskFor(env, version, options.fetch);
  const problem = typeof terms === "string" ? terms : terms.keyProblem;
  if (problem) (options.log ?? console.error)(`brainchain-mcp has an invalid setting: ${problem}`);
  const tools = [postTaskTool(terms), GET_TASK_TOOL, PREMIUMS_TOOL];
  const server = new Server({ name: "brainchain", title: "BrainChain", version }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, (request) => callTool(desk, request.params.name, request.params.arguments));
  return server;
}
