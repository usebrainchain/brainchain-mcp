#!/usr/bin/env node
import { createRequire } from "node:module";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createWalletClient, http, maxUint256, type PrivateKeyAccount } from "viem";

import { DECIMALS, formatUnits, resolveConfig, type Config } from "./config.js";
import { stateDirProblem } from "./daily.js";
import { approvalFailure, approveCommand, chainClients, createServer, erc20, payerAccount, PERMIT2, walletFunds, walletReport } from "./server.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const USAGE = `brainchain-mcp ${version}

MCP server that pays for tasks on BrainChain, reads their graded results, bonds tasks the wallet will deliver as a worker,
and reads what stock tokens cost on Robinhood Chain.

Usage:
  brainchain-mcp                 Start the server on stdio (what MCP clients run).
  brainchain-mcp approve [USDG]  Let Permit2 spend the paying wallet's USDG.
                                 Default 100 USDG; pass a number, "max", or 0 to revoke.
                                 Not needed when paying in USDC on Base.
  brainchain-mcp wallet          Check the key and settings, and print the wallet that pays, what it
                                 holds and, for USDG, what Permit2 may spend.

Environment:
  BRAINCHAIN_PAYER_KEY        Private key of the paying wallet, 64 hex characters with or without 0x.
                              Needed to post tasks, to bond and to approve; reading orders works without it.
  BRAINCHAIN_PAYER_KEY_FILE   A file holding that key instead, readable only by your account. Absolute or starting with ~/.
  BRAINCHAIN_NETWORK          mainnet (default) or testnet.
  BRAINCHAIN_PAY_ON           robinhood (default) pays in USDG on Robinhood Chain;
                              base pays in USDC on Base (Base Sepolia on testnet).
  BRAINCHAIN_MAX_PRICE_UNITS  Maximum paid per task, in base units (default 1000000 = 1 USDG or USDC).
  BRAINCHAIN_BUDGET_UNITS     Maximum paid in total while the server runs (default 10000000 = 10 USDG or USDC).
  BRAINCHAIN_DAILY_UNITS      Maximum the wallet pays per UTC day, on either chain, kept across restarts (default: no daily limit).
  BRAINCHAIN_MAX_BOND_UNITS   Maximum locked in one delivery bond on Shipped (default 10000000 = 10 USDG); bonds also draw on
                              the budget and the daily limit.
  BRAINCHAIN_STATE_DIR        Where the daily limit's record is kept (default ~/.brainchain). Absolute or starting with ~/.
  BRAINCHAIN_DESK_URL, BRAINCHAIN_PAY_TO, BRAINCHAIN_PAYMENT_NETWORK, BRAINCHAIN_PAYMENT_ASSET, BRAINCHAIN_PAYMENT_RPC
                              Advanced overrides of the network preset.
`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const command = process.argv[2];
const HELP = ["--help", "-h", "help"];
if ((command !== undefined && HELP.includes(command)) || (["approve", "wallet"].includes(command ?? "") && HELP.includes(process.argv[3] ?? ""))) {
  console.log(USAGE);
  process.exit(0);
}
if (command === "--version" || command === "-v" || command === "version") {
  console.log(version);
  process.exit(0);
}
if (command !== undefined && command !== "approve" && command !== "wallet") fail(`Unknown command ${command}.\n\n${USAGE}`);
const extra = process.argv[command === "approve" ? 4 : 3];
if (command !== undefined && extra !== undefined) fail(`Unexpected argument ${extra}: ${command === "approve" ? "approve takes one amount" : "wallet takes none"}.\n\n${USAGE}`);

if (command === undefined) {
  await createServer(process.env, version).connect(new StdioServerTransport());
} else if (command === "wallet") {
  const { config, account } = settings();
  const funds = await walletFunds(config, account.address).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
  console.log(walletReport(config, account.address, funds, approveCommand(config, version, process.env)));
} else {
  await approve(process.argv[3] ?? "100");
}

function settings(): { config: Config; account: PrivateKeyAccount } {
  let config: Config;
  let account: PrivateKeyAccount;
  try {
    config = resolveConfig(process.env);
    account = payerAccount(process.env);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const problem = config.daily === undefined ? undefined : stateDirProblem(config.stateDir);
  if (problem) fail(problem);
  return { config, account };
}

async function approve(arg: string): Promise<void> {
  const { config, account } = settings();
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
    fail(approvalFailure(account.address, config.chain, error));
  }
}
