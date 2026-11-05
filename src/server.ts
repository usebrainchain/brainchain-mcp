import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { address as solanaAddress, createSolanaRpc, getBase58Decoder, getBase58Encoder } from "@solana/kit";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { createPublicClient, defineChain, formatEther, http, maxUint256, parseAbi, type PrivateKeyAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { bondsClosed, createBonds, type Bonds } from "./bonds.js";
import { evmPayment, expandHome, formatUnits, resolveConfig, type Config } from "./config.js";
import { stateDirProblem } from "./daily.js";
import { createLimits } from "./limits.js";
import { createDesk, type Payer, type SolanaPayer } from "./payments.js";
import { PREMIUMS_NAME, PREMIUMS_TOOL } from "./premiums.js";
import { BOND_STATUS_NAME, BOND_TASK_NAME, bondTools, callTool, GET_TASK_NAME, GET_TASK_TOOL, POST_TASK_NAME, postTaskTool, type Desk, type Terms } from "./tools.js";

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
  `${BOND_TASK_NAME} locks USDG behind a BrainChain task this wallet will deliver as a worker, and ${BOND_STATUS_NAME} follows it; neither posts a task. ` +
  `The paying wallet's key is for this server alone. Never read it, print it, write it down or pass it to a command. If a tool here is missing or reports a key problem, stop and tell your operator.`;

const keyHelp = (variable: string) =>
  `Add ${variable} to this server's env in your MCP client config (in Claude Code, \`claude mcp add … -e ${variable}=…\`), or ${variable}_FILE with the path of a file holding it, then restart the server. ` +
  `${GET_TASK_NAME}, ${PREMIUMS_NAME} and ${BOND_STATUS_NAME} work without a key. An agent reading this: stop and tell your operator. Do not look for the key.`;
const KEY_HELP = keyHelp("BRAINCHAIN_PAYER_KEY");

const BONDS_NEED_EVM_KEY =
  "Delivery bonds lock USDG on Robinhood Chain, so they need a Robinhood Chain key beside the Solana one: set BRAINCHAIN_PAYER_KEY or BRAINCHAIN_PAYER_KEY_FILE as well, then restart the server.";

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Read here and never echoed. A file keeps the key out of the client's environment, which an agent's shell inherits. */
function readKeyFile(given: string, variable = "BRAINCHAIN_PAYER_KEY_FILE", maxBytes = 256): string {
  const path = expandHome(given);
  if (!isAbsolute(path)) throw new Error(`${variable} must be an absolute path or start with ~/.`);
  try {
    const stats = statSync(path);
    if (!stats.isFile() || stats.size > maxBytes) throw new Error(`${variable} must name a file holding only the key; ${path} does not.`);
    if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) throw new Error(`${path} can be read by other accounts on this machine. Run chmod 600 on it, then restart the server.`);
    return readFileSync(path, "utf8");
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code) throw new Error(`${variable} could not be read: ${path} (${code}).`);
    throw error;
  }
}

/** A Solana secret key as wallets export it: base58, or a JSON array of its 64 bytes. */
function solanaSecret(text: string): Uint8Array | undefined {
  try {
    if (text.startsWith("[")) {
      const value: unknown = JSON.parse(text);
      if (!Array.isArray(value) || !value.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) return undefined;
      return value.length === 64 ? Uint8Array.from(value as number[]) : undefined;
    }
    const bytes = getBase58Encoder().encode(text);
    return bytes.length === 64 ? Uint8Array.from(bytes) : undefined;
  } catch {
    return undefined;
  }
}

export function solanaPayer(env: Record<string, string | undefined>): SolanaPayer {
  const file = env.BRAINCHAIN_SOLANA_KEY_FILE?.trim();
  const given = env.BRAINCHAIN_SOLANA_KEY?.trim();
  if (file && given) throw new Error("Set BRAINCHAIN_SOLANA_KEY or BRAINCHAIN_SOLANA_KEY_FILE, not both.");
  if (given?.startsWith("$")) {
    const shown = /[1-9A-HJ-NP-Za-km-z]{16,}/.test(given) ? "" : ` ${given}`;
    throw new Error(`BRAINCHAIN_SOLANA_KEY is not set: your MCP client passed the placeholder${shown} through unexpanded, so the variable was not set when the client started.`);
  }
  // A JSON array of 64 bytes runs to about 260 characters, past the limit for a hex key file.
  const text = (file ? readKeyFile(file, "BRAINCHAIN_SOLANA_KEY_FILE", 1024) : given)?.trim();
  if (!file && !text) throw new Error("Set BRAINCHAIN_SOLANA_KEY to the secret key of the Solana wallet that pays for tasks: base58, as wallets export it, or a JSON array of its 64 bytes.");
  const secret = solanaSecret(text ?? "");
  const name = file ? "The key in BRAINCHAIN_SOLANA_KEY_FILE" : "BRAINCHAIN_SOLANA_KEY";
  if (!secret) throw new Error(`${name} must be a 64-byte Solana secret key: base58, or a JSON array of 64 numbers.`);
  // The second half is the public key, which is the wallet's address.
  return { address: getBase58Decoder().decode(secret.subarray(32)), secret };
}

/** The wallet's USDC, in its associated token account, which is the account an x402 payment spends from. */
export async function solanaBalance(config: Pick<Config, "rpc" | "asset">, owner: string): Promise<bigint> {
  const rpc = createSolanaRpc(config.rpc);
  const [account] = await findAssociatedTokenPda({ owner: solanaAddress(owner), mint: solanaAddress(config.asset), tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const signal = AbortSignal.timeout(15_000);
  const { value } = await rpc.getAccountInfo(account, { encoding: "base64", commitment: "confirmed" }).send({ abortSignal: signal });
  if (!value) return 0n;
  return BigInt((await rpc.getTokenAccountBalance(account, { commitment: "confirmed" }).send({ abortSignal: signal })).value.amount);
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
    id: evmPayment(config).chainId,
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
  eth?: bigint;
}

/** Reads what `wallet` reports, on the payment chain only. */
export async function walletFunds(config: Config, address: string): Promise<WalletFunds> {
  if (config.payOn === "solana") return { balance: await solanaBalance(config, address) };
  const { reader } = chainClients(config);
  const { asset } = evmPayment(config);
  const [balance, allowance, eth] = await Promise.all([
    reader.readContract({ address: asset, abi: erc20, functionName: "balanceOf", args: [address as `0x${string}`] }),
    config.permit2 ? reader.readContract({ address: asset, abi: erc20, functionName: "allowance", args: [address as `0x${string}`, PERMIT2] }) : undefined,
    reader.getBalance({ address: address as `0x${string}` }),
  ]);
  return { balance, ...(allowance === undefined ? {} : { allowance }), eth };
}

/** What `wallet` says: the wallet that pays, what it holds, and what it still needs before a post can be paid. */
export function walletReport(config: Config, address: string, funds: WalletFunds | Error, approve: string): string {
  const lines = [`${address} pays for tasks in ${config.token} on ${config.chain}.`];
  if (funds instanceof Error) {
    lines.push(`Its balance could not be read from ${config.chain} (${messageOf(funds).split("\n")[0]}). The key and settings are fine.`);
    return lines.join("\n");
  }
  const { balance, allowance, eth } = funds;
  const short = balance < config.maxPrice ? ` A task costs ${config.terms.cost}, so send at least ${formatUnits(config.maxPrice - balance)} ${config.token} to it on ${config.chain} before posting.` : "";
  lines.push(`It holds ${formatUnits(balance)} ${config.token}.${short}`);
  if (config.payOn === "solana") lines.push("The payment facilitator pays the Solana network fee, so the wallet needs no SOL.");
  if (allowance !== undefined) {
    if (allowance >= maxUint256 / 2n) lines.push(`Permit2 may spend any amount of its ${config.token}.`);
    else if (allowance >= config.maxPrice) lines.push(`Permit2 may spend up to ${formatUnits(allowance)} of its ${config.token}.`);
    else {
      const only = allowance > 0n ? ` (only ${formatUnits(allowance)})` : "";
      lines.push(
        `Permit2 is not approved to spend enough of its ${config.token} for a task${only}. Run \`${approve}\` once; it needs a little ETH on ${config.chain}, and the wallet holds ${formatEther(eth ?? 0n)} ETH there.`,
      );
    }
  }
  return lines.join("\n");
}

export function approveCommand(config: Config, version: string): string {
  return `${config.name === "testnet" ? "BRAINCHAIN_NETWORK=testnet " : ""}npx -y brainchain-mcp@${version} approve`;
}

/** A missing key or a bad setting is reported when a tool needs it, so the server always starts and lists its tools. */
function deskFor(env: Record<string, string | undefined>, version: string, fetchImpl?: typeof fetch): { desk: Desk; terms: Terms | string; bonds: Bonds; bondTools: [Tool, Tool] } {
  let config: Config;
  try {
    config = resolveConfig(env);
  } catch (error) {
    const problem = `${messageOf(error)} Fix it in this server's environment and restart the server.`;
    const refuse = async (): Promise<never> => {
      throw new Error(problem);
    };
    return { desk: { post: refuse, get: refuse }, terms: problem, bonds: { bond: refuse, status: refuse }, bondTools: bondTools({ maxBond: 0n, budget: 0n }, undefined, `Invalid setting: ${problem}`) };
  }

  const solana = config.payOn === "solana";
  const given = (...names: string[]) => names.some((name) => env[name]?.trim());
  const evmKeyGiven = given("BRAINCHAIN_PAYER_KEY", "BRAINCHAIN_PAYER_KEY_FILE");
  const readPayer = (): Payer => (solana ? solanaPayer(env) : payerAccount(env));
  let account: Payer | undefined;
  let keyProblem: string | undefined;
  try {
    account = readPayer();
  } catch (error) {
    // No key at all is a read-only server, which is allowed. A key that is there and unusable is a mistake to report.
    if (solana ? given("BRAINCHAIN_SOLANA_KEY", "BRAINCHAIN_SOLANA_KEY_FILE") : evmKeyGiven) keyProblem = messageOf(error);
  }
  // Bonds lock USDG on Robinhood Chain, so on Solana they take the EVM key when one is given beside the Solana key.
  let bondAccount = solana ? undefined : (account as PrivateKeyAccount | undefined);
  if (solana && evmKeyGiven) {
    try {
      bondAccount = payerAccount(env);
    } catch (error) {
      keyProblem = [keyProblem, messageOf(error)].filter(Boolean).join(" ");
    }
  }
  // Said at start, not at the first post: with a daily limit set, no payment can be signed without its record.
  const problem = [keyProblem, config.daily === undefined ? undefined : stateDirProblem(config.stateDir)].filter(Boolean).join(" ");
  const payer = () => {
    try {
      return (account ??= readPayer());
    } catch (error) {
      throw new Error(`${messageOf(error)} ${keyHelp(solana ? "BRAINCHAIN_SOLANA_KEY" : "BRAINCHAIN_PAYER_KEY")}`);
    }
  };
  const bondSigner = (): PrivateKeyAccount => {
    if (!solana) return payer() as PrivateKeyAccount;
    if (!evmKeyGiven) throw new Error(BONDS_NEED_EVM_KEY);
    try {
      return (bondAccount ??= payerAccount(env));
    } catch (error) {
      throw new Error(`${messageOf(error)} ${KEY_HELP}`);
    }
  };
  const limits = createLimits(config, payer);
  const evmFunds = async () => {
    const { reader } = chainClients(config);
    const { asset } = evmPayment(config);
    const owner = payer().address as `0x${string}`;
    const [balance, allowance] = await Promise.all([
      reader.readContract({ address: asset, abi: erc20, functionName: "balanceOf", args: [owner] }),
      config.permit2 ? reader.readContract({ address: asset, abi: erc20, functionName: "allowance", args: [owner, PERMIT2] }) : undefined,
    ]);
    return { balance, allowance };
  };
  const desk = createDesk({
    config,
    signer: payer,
    approveCommand: approveCommand(config, version),
    fetch: fetchImpl,
    limits,
    funds: solana ? async () => ({ balance: await solanaBalance(config, payer().address) }) : evmFunds,
  });
  const closed = bondsClosed(config) ?? (solana && !evmKeyGiven ? BONDS_NEED_EVM_KEY : undefined) ?? (problem ? `Invalid setting: ${problem}` : undefined);
  return {
    desk,
    terms: { ...config.terms, ...(account ? { wallet: account.address } : {}), ...(problem ? { problem } : {}) },
    bonds: createBonds({ config, signer: bondSigner, limits }),
    bondTools: bondTools(config, bondAccount?.address, closed),
  };
}

export interface ServerOptions {
  fetch?: typeof fetch;
  /** Where a configuration error is reported once at startup; stderr by default, since stdout carries the protocol. */
  log?: (message: string) => void;
}

export function createServer(env: Record<string, string | undefined>, version: string, options: ServerOptions = {}): Server {
  const { desk, terms, bonds, bondTools: bondToolList } = deskFor(env, version, options.fetch);
  const problem = typeof terms === "string" ? terms : terms.problem;
  if (problem) (options.log ?? console.error)(`brainchain-mcp has an invalid setting: ${problem}`);
  const tools = [postTaskTool(terms), GET_TASK_TOOL, PREMIUMS_TOOL, ...bondToolList];
  const server = new Server({ name: "brainchain", title: "BrainChain", version }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, (request) => callTool(desk, request.params.name, request.params.arguments, undefined, bonds));
  return server;
}
