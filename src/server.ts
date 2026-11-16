import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { createPublicClient, defineChain, formatEther, http, maxUint256, WaitForTransactionReceiptTimeoutError, type PrivateKeyAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { bondsClosed, createBonds, type Bonds } from "./bonds.js";
import { expandHome, formatUnits, PRICE, resolveConfig, type Config } from "./config.js";
import { CUSTODY_NAME, CUSTODY_TOOL } from "./custody.js";
import { stateDirProblem } from "./daily.js";
import { createLimits } from "./limits.js";
import { MAKERS_NAME, MAKERS_TOOL } from "./makers.js";
import { createDesk, erc20, firstLine } from "./payments.js";
import { PREMIUMS_NAME, PREMIUMS_TOOL } from "./premiums.js";
import { BOND_STATUS_NAME, BOND_TASK_NAME, bondTools, callTool, GET_GRADE_NAME, GET_GRADE_TOOL, GET_TASK_NAME, GET_TASK_TOOL, GRADE_NAME, gradeTool, POST_TASK_NAME, postTaskTool, type Desk, type Terms } from "./tools.js";

/** The canonical Permit2 contract; x402 payments in USDG are signed Permit2 transfers. */
export const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

export const INSTRUCTIONS =
  `Post a task with ${POST_TASK_NAME}, then read it with ${GET_TASK_NAME} and the order id it returns, waiting retryAfterSeconds between reads until done is true. ` +
  `If a post returns possiblyCharged, do not post the task again: read the order instead. ` +
  `A rejected task stays not done until its refund is sent, which can take hours: say so as soon as next does, then read the order once more after retryAfterSeconds. ` +
  `Two things end it without a refund transaction: a ruling that pays the model, and a refund the desk gives up sending, when state reads refund-failed and next says who to write to; pass that on. ` +
  `To have Jev judge work delivered somewhere else, send the brief and the result to ${GRADE_NAME}, and read the verdict with ${GET_GRADE_NAME} until done is true if it is not done at once. ` +
  `${BOND_TASK_NAME} locks USDG behind a BrainChain task this wallet will deliver as a worker, and ${BOND_STATUS_NAME} follows it; neither posts a task. ` +
  `If a bond returns possiblyBonded, do not bond the task again: read its status instead. ` +
  `The paying wallet's key is for this server alone. Never read it, print it, write it down or pass it to a command. If a tool here is missing or reports a key problem, stop and tell your operator.`;

const KEY_HELP =
  `Keep the key in a file only your account can read (chmod 600) and add BRAINCHAIN_PAYER_KEY_FILE with its path to this server's env in your MCP client config ` +
  `(in Claude Code, \`claude mcp add brainchain -e BRAINCHAIN_PAYER_KEY_FILE=~/.brainchain/payer.key -- npx -y brainchain-mcp\`), then restart the server. ` +
  `${GET_TASK_NAME}, ${GET_GRADE_NAME}, ${PREMIUMS_NAME}, ${CUSTODY_NAME} and ${MAKERS_NAME} work without a key; ${BOND_STATUS_NAME} reads this wallet's bonds, so it needs the key too. An agent reading this: stop and tell your operator. Do not look for the key.`;

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
  if (!file && !key) throw new Error("No paying key is set: point BRAINCHAIN_PAYER_KEY_FILE at a file holding the private key of the wallet that pays, 64 hex characters with or without 0x.");
  const name = file ? "The key in BRAINCHAIN_PAYER_KEY_FILE" : "BRAINCHAIN_PAYER_KEY";
  if (!/^[0-9a-f]{64}$/i.test(key ?? "")) throw new Error(`${name} must be 64 hex characters, with or without 0x.`);
  try {
    return privateKeyToAccount(`0x${key}`);
  } catch {
    throw new Error(`${name} is not a valid private key.`);
  }
}

/** Started by hand in a terminal, the server would wait in silence for a client that never comes. */
export function terminalHint(stdin: { isTTY?: boolean }, version: string): string | undefined {
  if (!stdin.isTTY) return undefined;
  return `brainchain-mcp ${version} speaks MCP on stdio and is waiting for a client; press Ctrl+C to quit. Add it to one instead, for example \`claude mcp add brainchain -e BRAINCHAIN_PAYER_KEY_FILE=~/.brainchain/payer.key -- npx -y brainchain-mcp@${version}\`, or run it with --help.`;
}

/** A private key typed as an argument is never printed back: by now it is in the shell's history. */
export function pastedKey(args: readonly string[]): string | undefined {
  if (!args.some((arg) => /(^|[^0-9a-f])[0-9a-f]{64}($|[^0-9a-f])/i.test(arg))) return undefined;
  return (
    "An argument looks like a private key, so it is not printed here. It is now in your shell history, and may be in this terminal's scrollback or a session transcript: " +
    "treat it as exposed, move the wallet's funds to a new key and stop using this one. brainchain-mcp reads its key from BRAINCHAIN_PAYER_KEY_FILE or BRAINCHAIN_PAYER_KEY, never from an argument."
  );
}

/** What a failed `approve` should tell a person. viem says the cost "exceeds the balance"; nodes say "insufficient funds". */
export function approvalFailure(address: string, chain: string, error: unknown): string {
  const message = error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error);
  return /insufficient funds|exceeds the balance/i.test(message) ? `${address} needs a little ETH on ${chain} to send the approval.` : `The approval failed: ${message}`;
}

/** What `approve` says when the approval was sent and its receipt did not come back: it may still confirm, so it is no failure. */
export function approvalUnconfirmed(hash: string, chain: string, error: unknown): string {
  const what = error instanceof WaitForTransactionReceiptTimeoutError ? " and has not confirmed yet" : `, and whether it confirmed could not be read (${firstLine(error).replace(/[.!?]+$/, "")})`;
  return `The approval ${hash} was sent on ${chain}${what}. It may still go through: look it up in a ${chain} block explorer before you run approve again.`;
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

export interface WalletFunds {
  balance: bigint;
  /** Permit2's allowance, for a token paid through Permit2. */
  allowance?: bigint;
  /** ETH for gas on the payment chain, which only the approval needs. */
  eth: bigint;
}

/** Reads what `wallet` reports, on the payment chain only. */
export async function walletFunds(config: Config, address: `0x${string}`): Promise<WalletFunds> {
  const { reader } = chainClients(config);
  const [balance, allowance, eth] = await Promise.all([
    reader.readContract({ address: config.asset, abi: erc20, functionName: "balanceOf", args: [address] }),
    config.permit2 ? reader.readContract({ address: config.asset, abi: erc20, functionName: "allowance", args: [address, PERMIT2] }) : undefined,
    reader.getBalance({ address }),
  ]);
  return { balance, ...(allowance === undefined ? {} : { allowance }), eth };
}

/** What a post needs the wallet to hold and Permit2 to spend: the desk's price, or under a raised ceiling the ceiling, since the price may have risen with it. */
const postNeeds = (config: Config) => (config.maxPrice > PRICE.task ? config.maxPrice : PRICE.task);

/** What `wallet` exits with: 0 when the wallet can pay for a task, 1 when it cannot, 2 when its balance could not be read. */
export function walletExitCode(config: Config, funds: WalletFunds | Error): 0 | 1 | 2 {
  if (config.maxPrice < PRICE.task) return 1;
  if (funds instanceof Error) return 2;
  const need = postNeeds(config);
  return funds.balance < need || (funds.allowance !== undefined && funds.allowance < need) ? 1 : 0;
}

function limitsLine(config: Config): string {
  const limits = [
    `${formatUnits(config.maxPrice)} ${config.token} per task or grade (BRAINCHAIN_MAX_PRICE_UNITS)`,
    `${formatUnits(config.budget)} ${config.token} per server run (BRAINCHAIN_BUDGET_UNITS)`,
    `${config.daily === undefined ? "no daily limit" : `${formatUnits(config.daily)} per UTC day, USDG and USDC together`} (BRAINCHAIN_DAILY_UNITS)`,
    ...(config.bonds ? [`${formatUnits(config.maxBond)} USDG per bond (BRAINCHAIN_MAX_BOND_UNITS)`] : []),
  ];
  return `Limits: ${limits.join(", ")}.`;
}

/** What `wallet` says: the wallet that pays, the limits it pays within, what it holds, and what it still needs before a post can be paid. */
export function walletReport(config: Config, address: string, funds: WalletFunds | Error, approve: string): string {
  const lines = [`${address} pays for tasks in ${config.token} on ${config.chain}.`, limitsLine(config)];
  const under = config.maxPrice < PRICE.task;
  if (under) {
    lines.push(
      `BRAINCHAIN_MAX_PRICE_UNITS lets this server pay at most ${formatUnits(config.maxPrice)} ${config.token} at a time, under the ${formatUnits(PRICE.task)} ${config.token} a task costs, so posts will be refused until it is raised.`,
    );
  }
  if (funds instanceof Error) {
    lines.push(`Its balance could not be read from ${config.chain} (${messageOf(funds).split("\n")[0]}). ${under ? "The key is fine." : "The key and settings are fine."}`);
    return lines.join("\n");
  }
  const { balance, allowance, eth } = funds;
  // Under a raised ceiling the wallet may still hold the price, so it is told what covers the ceiling, not what posting needs.
  const ceiling = config.maxPrice > PRICE.task;
  const need = postNeeds(config);
  const missing = `send at least ${formatUnits(need - balance)} ${config.token} to it on ${config.chain}`;
  const short = balance >= need ? "" : ceiling ? ` A task costs ${config.terms.cost}; ${missing} to cover that.` : ` A task costs ${config.terms.cost}, so ${missing} before posting.`;
  lines.push(`It holds ${formatUnits(balance)} ${config.token}.${short}`);
  if (allowance !== undefined) {
    if (allowance >= maxUint256 / 2n) lines.push(`Permit2 may spend any amount of its ${config.token}.`);
    else if (allowance >= need) lines.push(`Permit2 may spend up to ${formatUnits(allowance)} of its ${config.token}.`);
    else {
      const only = allowance > 0n ? ` (only ${formatUnits(allowance)})` : "";
      lines.push(
        `Permit2 is not approved to spend enough of its ${config.token} for a task${ceiling ? ` that costs ${formatUnits(config.maxPrice)}` : ""}${only}. Run \`${approve}\` once; it needs a little ETH on ${config.chain}, and the wallet holds ${formatEther(eth)} ETH there.`,
      );
    }
  }
  return lines.join("\n");
}

/** Quoting a leading ~ is safe: the server expands it itself. */
const shellWord = (word: string) => (/^[\w./~-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`);

/** PowerShell, the shell a Windows terminal opens, reads a single-quoted word as written, with '' for a quote. */
const powershellWord = (word: string) => `'${word.replaceAll("'", "''")}'`;

/**
 * The command that approves Permit2 with this server's key, in the form the
 * local shell runs: an inline assignment on macOS and Linux, PowerShell's
 * $env: on Windows, where `NAME=value command` is not a command at all.
 */
export function approveCommand(config: Config, version: string, env: Record<string, string | undefined>, platform: NodeJS.Platform = process.platform): string {
  const file = env.BRAINCHAIN_PAYER_KEY_FILE?.trim();
  // `approve` is a new process that sees only its own environment. A value that is no path may be a key in the wrong variable, so it is never printed.
  const named = file && isAbsolute(expandHome(file)) ? file : undefined;
  const settings: [string, string][] = [...(config.name === "testnet" ? [["BRAINCHAIN_NETWORK", "testnet"] as [string, string]] : []), ...(named ? [["BRAINCHAIN_PAYER_KEY_FILE", named] as [string, string]] : [])];
  const run = `npx -y brainchain-mcp@${version} approve`;
  if (platform === "win32") return [...settings.map(([name, value]) => `$env:${name}=${powershellWord(value)}`), run].join("; ");
  return [...settings.map(([name, value]) => `${name}=${name === "BRAINCHAIN_NETWORK" ? value : shellWord(value)}`), run].join(" ");
}

interface Wiring {
  desk: Desk;
  terms: Terms | string;
  bonds: Bonds;
  bondTools: [Tool, Tool];
  gradeTool: Tool;
  refused: Map<string, string>;
}

/** A setting the server cannot read at all: every tool answers with it but the three that read public data and need no setting. */
function unreadable(problem: string): Wiring {
  const refuse = async (): Promise<never> => {
    throw new Error(problem);
  };
  return {
    desk: { post: refuse, get: refuse, grade: refuse, getGrade: refuse },
    terms: problem,
    bonds: { bond: refuse, status: refuse },
    bondTools: bondTools({}, undefined, { invalid: { bond: problem, status: problem } }),
    gradeTool: gradeTool(problem),
    refused: new Map([POST_TASK_NAME, GET_TASK_NAME, GRADE_NAME, GET_GRADE_NAME, BOND_TASK_NAME, BOND_STATUS_NAME].map((name) => [name, problem])),
  };
}

/** A missing key or a bad setting is reported when a tool needs it, so the server always starts and lists its tools. */
function deskFor(env: Record<string, string | undefined>, version: string, fetchImpl?: typeof fetch): Wiring {
  const fix = (error: unknown) => `${messageOf(error)} Fix it in this server's environment and restart the server.`;
  let config: Config;
  let paymentProblem: string | undefined;
  try {
    config = resolveConfig(env);
  } catch (error) {
    // A setting only payments read stops the tools that pay, and orders, grades and bonds are still read.
    paymentProblem = fix(error);
    try {
      config = resolveConfig(env, { payments: false });
    } catch (unread) {
      return unreadable(fix(unread));
    }
  }

  let account: PrivateKeyAccount | undefined;
  let keyProblem: string | undefined;
  try {
    account = payerAccount(env);
  } catch (error) {
    // No key at all is a read-only server, which is allowed. A key that is there and unusable is a mistake to report.
    if (env.BRAINCHAIN_PAYER_KEY?.trim() || env.BRAINCHAIN_PAYER_KEY_FILE?.trim()) keyProblem = messageOf(error);
  }
  // Said at start, not at the first post: with a daily limit set, no payment can be signed without its record.
  const problem = [paymentProblem, keyProblem, config.daily === undefined ? undefined : stateDirProblem(config.stateDir)].filter(Boolean).join(" ");
  const payer = () => {
    try {
      return (account ??= payerAccount(env));
    } catch (error) {
      throw new Error(`${messageOf(error)} ${KEY_HELP}`);
    }
  };
  const limits = createLimits(config, payer);
  const desk = createDesk({
    config,
    signer: payer,
    approveCommand: approveCommand(config, version, env),
    fetch: fetchImpl,
    limits,
    funds: async () => walletFunds(config, payer().address),
  });
  // What the descriptions promise for a setting that cannot be used: a tool the setting stops answers with it
  // and touches nothing else. A setting only payments read stops the tools that pay, and so does a refused
  // state folder, which could still take a write or hang on one. Reading a bond needs the key and no record,
  // so only a key problem stops that.
  const refused = new Map<string, string>();
  if (problem) for (const name of [POST_TASK_NAME, GRADE_NAME, BOND_TASK_NAME]) refused.set(name, keyProblem ? `${problem} ${KEY_HELP}` : problem);
  if (keyProblem) refused.set(BOND_STATUS_NAME, `${keyProblem} ${KEY_HELP}`);
  const terms = { ...config.terms, ...(account ? { wallet: account.address } : {}), ...(problem ? { problem } : {}) };
  return {
    desk,
    terms,
    gradeTool: gradeTool(terms),
    bonds: createBonds({ config, signer: payer, limits }),
    bondTools: bondTools(config, account?.address, { closed: bondsClosed(config), invalid: { bond: problem || undefined, status: keyProblem } }),
    refused,
  };
}

export interface ServerOptions {
  fetch?: typeof fetch;
  /** Where a configuration error is reported once at startup; stderr by default, since stdout carries the protocol. */
  log?: (message: string) => void;
}

export function createServer(env: Record<string, string | undefined>, version: string, options: ServerOptions = {}): Server {
  const { desk, terms, bonds, bondTools: bondToolList, gradeTool: gradeToolDef, refused } = deskFor(env, version, options.fetch);
  const problem = typeof terms === "string" ? terms : terms.problem;
  if (problem) (options.log ?? console.error)(`brainchain-mcp has an invalid setting: ${problem}`);
  const tools = [postTaskTool(terms), GET_TASK_TOOL, gradeToolDef, GET_GRADE_TOOL, PREMIUMS_TOOL, CUSTODY_TOOL, MAKERS_TOOL, ...bondToolList];
  const server = new Server({ name: "brainchain", title: "BrainChain", version }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, (request) => callTool(desk, request.params.name, request.params.arguments, undefined, bonds, refused));
  return server;
}
