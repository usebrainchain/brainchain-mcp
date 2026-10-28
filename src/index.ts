#!/usr/bin/env node
import { createRequire } from "node:module";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createWalletClient, http, maxUint256, type PrivateKeyAccount } from "viem";

import { DECIMALS, formatUnits, resolveConfig, type Config } from "./config.js";
import { chainClients, createServer, erc20, payerAccount, PERMIT2 } from "./server.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const USAGE = `brainchain-mcp ${version}

MCP server that pays for tasks on BrainChain and reads their graded results.

Usage:
  brainchain-mcp                 Start the server on stdio (what MCP clients run).
  brainchain-mcp approve [USDG]  Let Permit2 spend the paying wallet's USDG.
                                 Default 100 USDG; pass a number, "max", or 0 to revoke.
                                 Not needed when paying in USDC on Base.

Environment:
  BRAINCHAIN_PAYER_KEY        Private key of the paying wallet, 64 hex characters with or without 0x.
                              Needed to post tasks and to approve; reading orders works without it.
  BRAINCHAIN_NETWORK          mainnet (default) or testnet.
  BRAINCHAIN_PAY_ON           robinhood (default) pays in USDG on Robinhood Chain;
                              base pays in USDC on Base (Base Sepolia on testnet).
  BRAINCHAIN_MAX_PRICE_UNITS  Maximum paid per task, in base units (default 1000000 = 1 USDG or USDC).
  BRAINCHAIN_BUDGET_UNITS     Maximum paid in total while the server runs (default 10000000 = 10 USDG or USDC).
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

if (command === undefined) {
  await createServer(process.env, version).connect(new StdioServerTransport());
} else {
  await approve(process.argv[3] ?? "100");
}

async function approve(arg: string): Promise<void> {
  let config: Config;
  try {
    config = resolveConfig(process.env);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  let account: PrivateKeyAccount;
  try {
    account = payerAccount(process.env);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (!config.permit2) {
    console.log(`${config.token} on ${config.chain} pays by signature alone, so there is nothing to approve.`);
    process.exit(0);
  }
  const max = arg.toLowerCase() === "max";
  if (!max && !/^\d+(\.\d{1,6})?$/.test(arg)) fail(`"${arg}" is not an amount. Pass USDG with up to 6 decimals (for example 100), "max", or 0 to revoke.`);
  const [whole, fraction = ""] = arg.split(".");
  const amount = max ? maxUint256 : BigInt(whole!) * 10n ** BigInt(DECIMALS) + BigInt(fraction.padEnd(DECIMALS, "0"));
  const { chain, reader } = chainClients(config);
  const wallet = createWalletClient({ account, chain, transport: http(config.rpc, { timeout: 30_000 }) });
  try {
    const hash = await wallet.writeContract({ address: config.asset, abi: erc20, functionName: "approve", args: [PERMIT2, amount] });
    console.log(`Sent ${hash} on ${config.chain}. Waiting for it to confirm…`);
    const receipt = await reader.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (receipt.status !== "success") fail(`The approval ${hash} reverted on ${config.chain}. Nothing changed; run approve again.`);
    console.log(
      amount === 0n
        ? `Permit2 can no longer spend ${config.token} from ${account.address}. Run approve with an amount to pay for tasks again.`
        : `Permit2 can now spend ${max ? "any amount of" : formatUnits(amount)} ${config.token} from ${account.address}.`,
    );
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error);
    fail(/insufficient funds/i.test(message) ? `${account.address} needs a little ETH on ${config.chain} to send the approval.` : `The approval failed: ${message}`);
  }
}
