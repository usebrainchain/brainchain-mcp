#!/usr/bin/env node
import { createRequire } from "node:module";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createWalletClient, http, maxUint256, type Hex, type PrivateKeyAccount } from "viem";

import { DECIMALS, formatUnits, resolveConfig, type Config } from "./config.js";
import { stateDirProblem } from "./daily.js";
import { initWallet, runInit } from "./init.js";
import { erc20 } from "./payments.js";
import { approvalFailure, approvalUnconfirmed, approveCommand, chainClients, createServer, deskFor, pastedKey, payerAccount, PERMIT2, terminalHint, walletExitCode, walletFunds, walletReport } from "./server.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const USAGE = `brainchain-mcp ${version}

MCP server that pays for tasks on BrainChain, reads their graded results and bonds tasks the wallet will deliver as a worker.
It sits BrainChain's licence exam for an ERC-8004 agent whose id the wallet holds, and reads any agent's licences and record.
It also reads what stock tokens cost on Robinhood Chain, lists the Robinhood Chain tokens that BitGo, a custodian for
exchanges and funds, has recently started to support, reads how much of a token on that chain a market maker's
trading wallets hold, now or at a past block, reads how far along a token is (deployed, first minted, first pool
created), reads which lists and exchanges already carry it, puts every dated public step of a token in one timeline,
reads a token's price, supply and market cap at a past block or now, reads whether a team is building behind it, as
HEY Research Lab reports it, and watches public sources for new changes about Robinhood Chain tokens.

Usage:
  brainchain-mcp                 Start the server on stdio (what MCP clients run).
  brainchain-mcp init            Create a paying wallet: a new key in ~/.brainchain/payer.key, or the file
                                 BRAINCHAIN_PAYER_KEY_FILE names, readable only by your account and never printed.
                                 Prints the wallet's address, what to send it, and the command that adds the server
                                 to Claude Code, Cursor or VS Code. Run it again to check the balance: an existing
                                 key is never replaced, and the exit code is then the same as wallet's.
  brainchain-mcp approve [USDG]  Let Permit2 spend the paying wallet's USDG. Run it with BRAINCHAIN_PAY_ON=robinhood.
                                 Default 100 USDG; pass a number, "max", or 0 to revoke.
                                 Not needed when paying in USDC on Base.
  brainchain-mcp wallet          Check the key and settings, and print the wallet that pays, the limits,
                                 what it holds and, for USDG, what Permit2 may spend. Exits 0 when the
                                 wallet can pay for a task, 1 when it cannot or a setting is wrong, and 2
                                 when its balance could not be read.
  brainchain-mcp watch           Watch public sources for changes about Robinhood Chain tokens, keep them in a log
                                 and serve them to brainchain_changes. See brainchain-mcp watch --help.
  brainchain-mcp solve [<problem> <file>]
                                 Answer an open problem on BrainChain's problem board: the answer in <file> is run through
                                 the problem's checker and the decision is recorded. Without arguments it lists the
                                 problems. See brainchain-mcp solve --help.
  brainchain-mcp dataset --out <dir>
                                 Build the dataset brainchain_trace_outcomes reads: every token's dated public steps,
                                 the venues that listed it and the base rates. See brainchain-mcp dataset --help.

Environment:
  BRAINCHAIN_PAYER_KEY        Private key of the paying wallet, 64 hex characters with or without 0x.
                              Needed to post tasks, grade work, bond, sit the exam and approve; reading orders works without it.
  BRAINCHAIN_PAYER_KEY_FILE   A file holding that key instead. Absolute or starting with ~/. On macOS and Linux it must be
                              readable only by your account (chmod 600); Windows is not checked, so keep it in your own user folder.
                              With neither set, wallet, approve and solve pay from the wallet init made.
  BRAINCHAIN_NETWORK          mainnet (default) or testnet.
  BRAINCHAIN_PAY_ON           base (default) pays in USDC on Base (Base Sepolia on testnet);
                              robinhood pays in USDG on Robinhood Chain.
  BRAINCHAIN_MAX_PRICE_UNITS  Maximum paid per task or grade, in base units (default 1000000 = 1 USDC or USDG). Left unset,
                              it gives way to the price of an exam sitting for that one payment; set, it holds for one too.
  BRAINCHAIN_BUDGET_UNITS     Maximum paid in total while the server runs (default 10000000 = 10 USDC or USDG).
  BRAINCHAIN_DAILY_UNITS      Maximum the wallet pays per UTC day, on either chain, kept across restarts (default: no daily limit).
  BRAINCHAIN_MAX_BOND_UNITS   Maximum locked in one delivery bond on Shipped (default 10000000 = 10 USDG); bonds also draw on
                              the budget and the daily limit.
  BRAINCHAIN_STATE_DIR        Where the daily limit's record is kept (default ~/.brainchain). Absolute or starting with ~/.
  BRAINCHAIN_MAKER_WALLETS    More wallets for brainchain_market_maker_holdings and brainchain_token_timeline to follow, as
                              Name=0xAddress separated by commas (at most 20). Nobody checks whose wallets they are; their
                              entries say source configured.
  BRAINCHAIN_WATCH_URL        The watcher brainchain_changes, brainchain_watch and brainchain_unwatch use, such as your own
                              \`brainchain-mcp watch --serve\` at http://127.0.0.1:8787 (default https://watch.usebrainchain.com).
  BRAINCHAIN_DATASET          Where brainchain_trace_outcomes, brainchain_token_timeline and the symbol lookup read the dataset:
                              a directory, absolute or starting with ~/, or an https address (default BrainChain's published copy).
  GITHUB_TOKEN                A GitHub token with no scopes, to read GitHub's API with its allowance in place of the 60
                              requests an hour GitHub allows one IP address. Sent to api.github.com only.
  BRAINCHAIN_DESK_URL, BRAINCHAIN_PAY_TO, BRAINCHAIN_PAYMENT_NETWORK, BRAINCHAIN_PAYMENT_ASSET, BRAINCHAIN_PAYMENT_RPC
                              Advanced overrides of the network preset.
`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const pasted = pastedKey(process.argv.slice(2));
if (pasted) fail(pasted);
const command = process.argv[2];
const HELP = ["--help", "-h", "help"];
if ((command !== undefined && HELP.includes(command)) || (["approve", "wallet", "init"].includes(command ?? "") && HELP.includes(process.argv[3] ?? ""))) {
  console.log(USAGE);
  process.exit(0);
}
// The watcher is loaded only for its own command, so the server starts as it always has.
const watch = command === "watch" ? await import("./watch/cli.js") : undefined;
if (watch && process.argv.slice(3).some((arg) => HELP.includes(arg))) {
  console.log(watch.WATCH_USAGE);
  process.exit(0);
}
const dataset = command === "dataset" ? await import("./dataset/cli.js") : undefined;
if (dataset && process.argv.slice(3).some((arg) => HELP.includes(arg))) {
  console.log(dataset.DATASET_USAGE);
  process.exit(0);
}
const solve = command === "solve" ? await import("./solve.js") : undefined;
if (solve && process.argv.slice(3).some((arg) => HELP.includes(arg))) {
  console.log(solve.SOLVE_USAGE);
  process.exit(0);
}
if (command === "--version" || command === "-v" || command === "version") {
  console.log(version);
  process.exit(0);
}
if (command !== undefined && !["approve", "wallet", "init", "watch", "dataset", "solve"].includes(command)) fail(`Unknown command ${command}.\n\n${USAGE}`);
const extra = process.argv[command === "approve" ? 4 : 3];
if (command !== undefined && command !== "watch" && command !== "dataset" && command !== "solve" && extra !== undefined) fail(`Unexpected argument ${extra}: ${command === "approve" ? "approve takes one amount" : `${command} takes none`}.\n\n${USAGE}`);

if (command === undefined) {
  const hint = terminalHint(process.stdin, version);
  if (hint) console.error(hint);
  await createServer(process.env, version).connect(new StdioServerTransport());
} else if (watch) {
  await watch.runWatch(process.argv.slice(3), process.env, version).catch((error: unknown) => fail(error instanceof watch.UsageError ? `${error.message}\n\n${watch.WATCH_USAGE}` : error instanceof Error ? error.message : String(error)));
} else if (dataset) {
  await dataset.runDataset(process.argv.slice(3), process.env).catch((error: unknown) => fail(error instanceof dataset.DatasetUsageError ? `${error.message}\n\n${dataset.DATASET_USAGE}` : error instanceof Error ? error.message : String(error)));
} else if (solve) {
  const { readFile } = await import("node:fs/promises");
  process.exitCode = await solve
    .runSolve(process.argv.slice(3), {
      boardUrl: process.env.BRAINCHAIN_PROBLEMS_URL?.trim() || solve.BOARD_URL,
      fetch,
      desk: () => {
        const { config } = settings();
        const { desk, terms } = deskFor(initWallet(process.env), version);
        if (typeof terms === "string" || terms.problem) fail(typeof terms === "string" ? terms : terms.problem!);
        return { desk, origin: config.desk, cost: terms.gradeCost, ...(terms.wallet ? { wallet: terms.wallet } : {}), chain: terms.chain };
      },
      read: (path) => readFile(path, "utf8"),
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      log: (line) => console.log(line),
      now: Date.now,
    })
    .catch((error: unknown) => fail(error instanceof solve.SolveUsageError ? `${error.message}\n\n${solve.SOLVE_USAGE}` : error instanceof Error ? error.message : String(error)));
} else if (command === "init") {
  const { text, code } = await runInit(process.env, version).catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
  console.log(text);
  process.exitCode = code;
} else if (command === "wallet") {
  const { config, account } = settings();
  const funds = await walletFunds(config, account.address).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
  console.log(walletReport(config, account.address, funds, approveCommand(config, version, process.env)));
  process.exitCode = walletExitCode(config, funds);
} else {
  await approve(process.argv[3] ?? "100");
}

function settings(): { config: Config; account: PrivateKeyAccount } {
  let config: Config;
  let account: PrivateKeyAccount;
  try {
    config = resolveConfig(process.env);
    account = payerAccount(initWallet(process.env));
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
    console.log(`${config.token} on ${config.chain} pays by signature alone, so there is nothing to approve. To pay in USDG on Robinhood Chain instead, run approve with BRAINCHAIN_PAY_ON=robinhood.`);
    process.exit(0);
  }
  const max = arg.toLowerCase() === "max";
  if (!max && !/^\d+(\.\d{1,6})?$/.test(arg)) fail(`"${arg}" is not an amount. Pass USDG with up to 6 decimals (for example 100), "max", or 0 to revoke.`);
  const [whole, fraction = ""] = arg.split(".");
  const amount = max ? maxUint256 : BigInt(whole!) * 10n ** BigInt(DECIMALS) + BigInt(fraction.padEnd(DECIMALS, "0"));
  const { chain, reader } = chainClients(config);
  const wallet = createWalletClient({ account, chain, transport: http(config.rpc, { timeout: 30_000 }) });
  let hash: Hex;
  try {
    hash = await wallet.writeContract({ address: config.asset, abi: erc20, functionName: "approve", args: [PERMIT2, amount] });
  } catch (error) {
    fail(approvalFailure(account.address, config.chain, error));
  }
  console.log(`Sent ${hash} on ${config.chain}. Waiting for it to confirm…`);
  const receipt = await reader.waitForTransactionReceipt({ hash, timeout: 180_000 }).catch((error: unknown) => fail(approvalUnconfirmed(hash, config.chain, error)));
  if (receipt.status !== "success") fail(`The approval ${hash} reverted on ${config.chain}. Nothing changed; run approve again.`);
  console.log(
    amount === 0n
      ? `Permit2 can no longer spend ${config.token} from ${account.address}. Run approve with an amount to pay for tasks again.`
      : `Permit2 can now spend ${max ? "any amount of" : formatUnits(amount)} ${config.token} from ${account.address}.`,
  );
  process.exit(0);
}
