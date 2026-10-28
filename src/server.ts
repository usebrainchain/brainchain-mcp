import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createPublicClient, defineChain, http, parseAbi, type PrivateKeyAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { resolveConfig, type Config } from "./config.js";
import { createDesk } from "./payments.js";
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
  `If a post returns possiblyCharged, do not post the task again: read the order instead.`;

const KEY_HELP =
  `Add BRAINCHAIN_PAYER_KEY to this server's env in your MCP client config (in Claude Code, \`claude mcp add … -e BRAINCHAIN_PAYER_KEY=…\`), then restart the server. ` +
  `${GET_TASK_NAME} works without a key.`;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function payerAccount(env: Record<string, string | undefined>): PrivateKeyAccount {
  const raw = env.BRAINCHAIN_PAYER_KEY?.trim();
  // A client that cannot expand ${VAR} passes it through as written. Anything
  // that could be key material is never echoed.
  if (raw?.startsWith("$")) {
    const shown = /[0-9a-f]{16,}/i.test(raw) ? "" : ` ${raw}`;
    throw new Error(`BRAINCHAIN_PAYER_KEY is not set: your MCP client passed the placeholder${shown} through unexpanded, so the variable was not set when the client started.`);
  }
  const key = raw?.replace(/^0x/i, "");
  if (!key) throw new Error("Set BRAINCHAIN_PAYER_KEY to the private key of the wallet that pays for tasks: 64 hex characters, with or without 0x.");
  if (!/^[0-9a-f]{64}$/i.test(key)) throw new Error("BRAINCHAIN_PAYER_KEY must be 64 hex characters, with or without 0x.");
  try {
    return privateKeyToAccount(`0x${key}`);
  } catch {
    throw new Error("BRAINCHAIN_PAYER_KEY is not a valid private key.");
  }
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
  return { desk, terms: config.terms };
}

export interface ServerOptions {
  fetch?: typeof fetch;
  /** Where a configuration error is reported once at startup; stderr by default, since stdout carries the protocol. */
  log?: (message: string) => void;
}

export function createServer(env: Record<string, string | undefined>, version: string, options: ServerOptions = {}): Server {
  const { desk, terms } = deskFor(env, version, options.fetch);
  if (typeof terms === "string") (options.log ?? console.error)(`brainchain-mcp has an invalid setting: ${terms}`);
  const tools = [postTaskTool(terms), GET_TASK_TOOL];
  const server = new Server({ name: "brainchain", title: "BrainChain", version }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, (request) => callTool(desk, request.params.name, request.params.arguments));
  return server;
}
