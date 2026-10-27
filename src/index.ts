#!/usr/bin/env node
import { createRequire } from "node:module";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createPublicClient, createWalletClient, defineChain, http, maxUint256, parseAbi, type PrivateKeyAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { DECIMALS, formatUnits, resolveConfig, type Config } from "./config.js";
import { createDesk } from "./payments.js";
import { callTool, GET_TASK_TOOL, postTaskTool } from "./tools.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

/** The canonical Permit2 contract; x402 payments in USDG are signed Permit2 transfers. */
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const erc20 = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

const USAGE = `brainchain-mcp ${version}

MCP server that pays for tasks on BrainChain and reads their graded results.

Usage:
  brainchain-mcp                 Start the server on stdio (what MCP clients run).
  brainchain-mcp approve [USDG]  Let Permit2 spend the paying wallet's USDG, once.
                                 Default 100 USDG; pass a number, "max", or 0 to revoke.
                                 Not needed when paying in USDC on Base.

Environment:
  BRAINCHAIN_PAYER_KEY        Private key of the paying wallet (required).
  BRAINCHAIN_NETWORK          mainnet (default) or testnet.
  BRAINCHAIN_PAY_ON           robinhood (default) pays in USDG on Robinhood Chain;
                              base pays in USDC on Base (Base Sepolia on testnet).
  BRAINCHAIN_MAX_PRICE_UNITS  Most the server pays per task, in base units (default 1000000 = 1 USDG or USDC).
  BRAINCHAIN_BUDGET_UNITS     Most the server pays in total while it runs (default 10000000 = 10 USDG or USDC).
  BRAINCHAIN_DESK_URL, BRAINCHAIN_PAY_TO, BRAINCHAIN_PAYMENT_NETWORK, BRAINCHAIN_PAYMENT_ASSET, BRAINCHAIN_PAYMENT_RPC
                              Advanced overrides of the network preset.
`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const command = process.argv[2];
if (command === "--help" || command === "-h" || command === "help") {
  console.log(USAGE);
  process.exit(0);
}
if (command === "--version" || command === "-v" || command === "version") {
  console.log(version);
  process.exit(0);
}
if (command !== undefined && command !== "approve") fail(`Unknown command ${command}.\n\n${USAGE}`);

let config: Config;
try {
  config = resolveConfig(process.env);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
const key = process.env.BRAINCHAIN_PAYER_KEY;
if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) fail("Set BRAINCHAIN_PAYER_KEY to the private key of the wallet that pays for tasks (0x followed by 64 hex characters).");
let account: PrivateKeyAccount;
try {
  account = privateKeyToAccount(key as `0x${string}`);
} catch {
  fail("BRAINCHAIN_PAYER_KEY is not a valid private key.");
}

const approveCommand = `${config.name === "testnet" ? "BRAINCHAIN_NETWORK=testnet " : ""}npx -y brainchain-mcp@${version} approve`;
if (command === "approve" && !config.permit2) {
  console.log(`Paying in ${config.token} on ${config.chain} is a signature each time, so there is nothing to approve.`);
  process.exit(0);
}
const chain = defineChain({
  id: config.chainId,
  name: config.chain,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [config.rpc] } },
});
const reader = createPublicClient({ chain, transport: http(config.rpc, { retryCount: 2, timeout: 15_000 }) });

if (command === "approve") {
  const arg = process.argv[3] ?? "100";
  if (arg !== "max" && !/^\d+(\.\d{1,6})?$/.test(arg)) fail('Pass an amount of USDG, for example 100, or "max".');
  const [whole, fraction = ""] = arg.split(".");
  const amount = arg === "max" ? maxUint256 : BigInt(whole!) * 10n ** BigInt(DECIMALS) + BigInt(fraction.padEnd(DECIMALS, "0"));
  const wallet = createWalletClient({ account, chain, transport: http(config.rpc, { timeout: 30_000 }) });
  try {
    const hash = await wallet.writeContract({ address: config.asset, abi: erc20, functionName: "approve", args: [PERMIT2, amount] });
    console.log(`Sent ${hash} on ${config.chain}. Waiting for it to confirm…`);
    const receipt = await reader.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (receipt.status !== "success") fail("The approval reverted.");
    console.log(
      amount === 0n
        ? `Permit2 can no longer spend ${config.token} from ${account.address}. Run approve with an amount to pay for tasks again.`
        : `Permit2 can now spend ${arg === "max" ? "any amount of" : formatUnits(amount)} ${config.token} from ${account.address}.`,
    );
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error);
    fail(/insufficient funds/i.test(message) ? `${account.address} needs a little ETH on ${config.chain} to send the approval.` : `The approval failed: ${message}`);
  }
}

const desk = createDesk({
  config,
  signer: account,
  approveCommand,
  funds: async () => {
    const [balance, allowance] = await Promise.all([
      reader.readContract({ address: config.asset, abi: erc20, functionName: "balanceOf", args: [account.address] }),
      config.permit2 ? reader.readContract({ address: config.asset, abi: erc20, functionName: "allowance", args: [account.address, PERMIT2] }) : undefined,
    ]);
    return { balance, allowance };
  },
});

const tools = [postTaskTool(config.terms), GET_TASK_TOOL];
const server = new Server({ name: "brainchain", version }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, (request) => callTool(desk, request.params.name, request.params.arguments));
await server.connect(new StdioServerTransport());
