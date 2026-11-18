import type { ClientEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { keccak256, parseAbi, RpcRequestError, toBytes } from "viem";

import { formatUnits, MAX_TIMEOUT_SECONDS, PRICE, REPOST_AFTER_MINUTES, type Config } from "./config.js";
import { briefsMessage, RECORD_PAGE, resultMessage, sittingGuidance, sittingMessage } from "./exams.js";
import { createLimits, type Hold, type Limits } from "./limits.js";
import type { Desk, GradeRequest, SittingRequest, TaskRequest } from "./tools.js";

const BUDGET_REASON = "budget";
const DAILY_REASON = "daily limit";
/** A result longer than this is cut, with a link to the rest. */
export const RESULT_LIMIT = 20_000;
/** The token calls this server makes, for Permit2's allowance on a payment and the registry's on a bond. */
export const erc20 = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

/** What a refused budget or daily limit tells a person who posts. */
async function limitReached(config: Config, limits: Limits, which: "budget" | "daily limit"): Promise<string> {
  if (which === "budget") {
    return `This server has already signed payments for ${formatUnits(limits.spent())} of its ${formatUnits(config.budget)} ${config.token} budget. The budget resets when the server restarts; raise BRAINCHAIN_BUDGET_UNITS to allow more per run. Nothing was charged.`;
  }
  const today = await limits.spentToday();
  // One limit covers both chains, so it is named without a token.
  return `This wallet has already signed payments for ${today === undefined ? "most" : formatUnits(today)} of its daily limit of ${formatUnits(config.daily!)}, counting USDG and USDC together. The limit resets at 00:00 UTC; raise BRAINCHAIN_DAILY_UNITS to allow more. Nothing was charged.`;
}

/** Same serialization the desk hashes into an order id: sorted keys, no whitespace. */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  const source = value as Record<string, unknown>;
  return `{${Object.keys(source)
    .filter((key) => source[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalStringify(source[key])}`)
    .join(",")}}`;
}

/** The desk names an order after the hash of the signed payment it was paid with. */
export function orderIdOf(paymentPayload: { payload: unknown }): `0x${string}` {
  return keccak256(toBytes(canonicalStringify(paymentPayload.payload)));
}

export interface Funds {
  balance: bigint;
  /** Permit2's allowance; absent when the token pays by signature alone. */
  allowance?: bigint;
}

/** The paying wallet: it signs payments as typed data, and the exam's messages with personal_sign. */
export type Signer = ClientEvmSigner & { signMessage(args: { message: string }): Promise<`0x${string}`> };

export interface DeskOptions {
  config: Config;
  /** A function is called when a payment is about to be signed, so a desk can exist before its key does. */
  signer: Signer | (() => Signer);
  /** The command a person runs to approve Permit2, for refusal messages. */
  approveCommand: string;
  fetch?: typeof fetch;
  /** Reads the paying wallet's balance and, for USDG, its Permit2 allowance, to explain a refused payment. */
  funds?: () => Promise<Funds>;
  postTimeoutMs?: number;
  /** How long a paid sitting the desk has not opened yet waits before the same request is sent again. */
  askAgainMs?: number;
  /** The budget and daily limit, shared with whatever else spends from the wallet; made here when absent. */
  limits?: Limits;
}

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export const firstLine = (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";
/** Text from the desk or a library, ended as a sentence so what this server adds after it reads apart. */
export const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

/** A library's error in a few words: the HTTP status or the node's own refusal when there is one, else the error's first line. */
export function brief(error: unknown): string {
  for (let cause = error; cause instanceof Error; cause = cause.cause) {
    const { status } = cause as { status?: unknown };
    if (typeof status === "number") return `HTTP ${status}.`;
    if (cause instanceof RpcRequestError && cause.details) return sentence(cause.details.split("\n")[0]!);
  }
  return sentence(firstLine(error));
}

const CHAINS = new Map([
  ["4663", "Robinhood Chain"],
  ["8453", "Base"],
  ["46630", "Robinhood Chain testnet"],
  ["84532", "Base Sepolia"],
]);
const SOLANA = new Map([
  ["5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "Solana"],
  ["EtWTRABZaYq6iMfeYKouRu166VU2xqa1", "Solana devnet"],
]);

/**
 * Where an order was paid, from its own network: the server reading it may pay on another chain.
 * An order on `acp:<chain id>` was paid into an escrow there, which the desk never holds.
 */
export function paidOn(network: unknown): { chain: string; escrow: boolean } {
  const [kind, id = ""] = typeof network === "string" ? network.split(":") : [];
  const chain = kind === "solana" ? SOLANA.get(id) : kind === "eip155" || kind === "acp" ? CHAINS.get(id) : undefined;
  return { chain: chain ?? "the chain it was paid on", escrow: kind === "acp" };
}
/** Statuses that say "not now" rather than "no", alongside every 5xx. */
const RETRY_LATER = new Set([408, 425, 429]);

/** Settles as `work` does, or rejects once `signal` aborts. */
function until<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  const aborted = new Promise<never>((_, reject) => {
    // A signal that has already aborted fires no event.
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  return Promise.race([work, aborted]);
}

/** Retry-After in seconds, from either form the header takes. */
function retryAfter(response: Response): number | undefined {
  const header = response.headers.get("retry-after")?.trim();
  if (!header) return undefined;
  const seconds = /^\d+$/.test(header) ? Number(header) : Math.ceil((Date.parse(header) - Date.now()) / 1000);
  return Number.isFinite(seconds) ? Math.max(1, seconds) : undefined;
}

/** Far above any reply or result the desk sends, so a body that runs past it comes from something else. */
export const BODY_LIMIT = 1 << 20;

/** A body as text up to `limit` bytes; one that runs past it is cancelled there and comes back cut. */
async function capped(response: Response, limit = BODY_LIMIT): Promise<{ text: string; cut: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { text: "", cut: false };
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { text: text + decoder.decode(), cut: false };
    if (size + value.byteLength > limit) {
      text += decoder.decode(value.subarray(0, limit - size), { stream: true });
      void reader.cancel().catch(() => undefined);
      return { text, cut: true };
    }
    size += value.byteLength;
    text += decoder.decode(value, { stream: true });
  }
}

async function jsonObject(response: Response): Promise<Record<string, unknown> | undefined> {
  const value: unknown = await capped(response)
    .then(({ text, cut }) => (cut ? undefined : JSON.parse(text)))
    .catch(() => undefined);
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function createDesk(options: DeskOptions): Desk & { spent(): bigint } {
  const { config, signer, approveCommand } = options;
  const fetchImpl = options.fetch ?? fetch;
  const account = () => (typeof signer === "function" ? signer() : signer);
  const limits = options.limits ?? createLimits(config, account);
  const endpoint = `${config.desk}/x402/tasks`;
  const gradesEndpoint = `${config.desk}/x402/grades`;
  const route = { task: endpoint, grade: gradesEndpoint, exam: `${config.desk}/x402/exams` };
  const recent = new Map<string, { at: number; reply: Promise<unknown> }>();
  /** When this process paid, or may have paid, for each order, and how to forget its post; the desk can take minutes to know one. */
  const paid = new Map<string, { at: number; forget: () => void }>();
  /** What each of those orders still holds against the budget and the daily limit. */
  const held = new Map<string, Hold>();
  // A task's order and a grade are read at different routes, so each map entry belongs to one kind.
  const keyed = (kind: Kind, id: string) => `${kind}:${id.toLowerCase()}`;

  /** The desk's price, read from a fresh 402 challenge. */
  async function quotedPrice(kind: Kind, signal = AbortSignal.timeout(15_000)): Promise<bigint | undefined> {
    try {
      const probe = await fetchImpl(route[kind], {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        signal,
      });
      const header = probe.headers.get("payment-required");
      if (!header) return undefined;
      const required = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { accepts?: { network?: string; amount?: string }[] };
      const amount = required.accepts?.find((accept) => accept.network === config.network)?.amount;
      return amount ? BigInt(amount) : undefined;
    } catch {
      return undefined;
    }
  }

  /** What the desk asked that this server will not sign, named by the condition that failed. */
  function refusedTerms(requirements: readonly { payTo: string; maxTimeoutSeconds: number }[]): string {
    const payee = requirements.some((r) => sameAddress(r.payTo, config.payTo));
    const brief = requirements.some((r) => r.maxTimeoutSeconds <= MAX_TIMEOUT_SECONDS);
    const check = "Check BRAINCHAIN_NETWORK and BRAINCHAIN_PAY_ON, or set BRAINCHAIN_PAY_TO for a custom BRAINCHAIN_DESK_URL.";
    if (!payee && brief) return `it named ${requirements[0]!.payTo} as the payee, and this server pays only ${config.payTo}. ${check}`;
    if (payee && !brief) return `it asked for an authorization that lasts ${Math.min(...requirements.map((r) => r.maxTimeoutSeconds))} seconds, and this server signs none for longer than ${MAX_TIMEOUT_SECONDS}.`;
    return `the payee must be ${config.payTo} and the authorization may last at most ${MAX_TIMEOUT_SECONDS} seconds. ${check}`;
  }

  /** Turns an x402 client error, raised before anything was signed, into a step a person or model can act on. */
  async function explainUnsigned(kind: Kind, error: unknown, refused?: string): Promise<string> {
    const message = firstLine(error);
    if (message.includes(`Payment creation aborted: ${BUDGET_REASON}`)) return await limitReached(config, limits, "budget");
    if (message.includes(`Payment creation aborted: ${DAILY_REASON}`)) return await limitReached(config, limits, "daily limit");
    // A sitting is signed for the price read a moment before, and for nothing else.
    if (kind === "exam" && /rejected by spendControls/.test(message)) {
      return `The desk asked for another payment than the one it had just quoted for a sitting (${config.token} at ${config.asset}), so nothing was signed. Try again. Nothing was charged.`;
    }
    if (/rejected by spendControls/.test(message)) {
      const price = await quotedPrice(kind);
      if (price !== undefined && price > config.maxPrice) {
        return `The desk asks ${formatUnits(price)} ${config.token} per ${kind}, above this server's limit of ${formatUnits(config.maxPrice)} ${config.token}. Raise BRAINCHAIN_MAX_PRICE_UNITS and restart the server to allow it. Nothing was charged.`;
      }
      return `The desk asked for a payment outside this server's limits (${config.token} at ${config.asset}, at most ${formatUnits(config.maxPrice)} per ${kind}). Check BRAINCHAIN_PAY_ON and BRAINCHAIN_PAYMENT_ASSET. Nothing was charged.`;
    }
    if (/filtered out by policies/.test(message)) {
      return `The desk asked to be paid on terms this server does not accept: ${refused ?? refusedTerms([])} Nothing was charged.`;
    }
    if (/No network\/scheme registered/.test(message)) {
      return `The desk does not take payment on ${config.chain} (${config.network}). Check BRAINCHAIN_NETWORK and BRAINCHAIN_PAY_ON. Nothing was charged.`;
    }
    if (/Failed to parse payment requirements/.test(message)) {
      return "The desk's payment request could not be read. Try again in a minute. Nothing was charged.";
    }
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      return `The desk at ${config.desk} did not answer in time. Nothing was charged; try again.`;
    }
    if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(message)) {
      return `Could not reach the desk at ${config.desk}. Nothing was charged. Check your connection or BRAINCHAIN_DESK_URL and try again.`;
    }
    // The x402 client puts its own words before an error raised while it prepared the payment.
    return `The payment could not be prepared: ${sentence(message.replace(/^Failed to create payment payload: /, ""))} Nothing was charged.`;
  }

  /**
   * Explains a payment the desk refused, from the wallet's balance and Permit2 allowance where they can be read,
   * and from the desk's own code where they cannot.
   */
  async function explainRefusal(kind: Kind, reason: unknown, price: bigint): Promise<string> {
    const code = typeof reason === "string" ? reason.trim() : "";
    // One deadline for both reads, so a slow chain cannot hold the reply, and either can fail without the other.
    const deadline = AbortSignal.timeout(10_000);
    const [funds, quoted] = await Promise.all([options.funds ? until(deadline, options.funds()).catch(() => undefined) : undefined, quotedPrice(kind, deadline)]);
    const needed = quoted ?? price;
    const what = kind === "exam" ? "sitting" : kind;
    const again = kind === "task" ? "post again" : kind === "grade" ? "send it again" : "sit again";
    const unapproved = `Permit2 is not yet approved to spend this wallet's ${config.token}. Run \`${approveCommand}\` once with the key this server uses; it needs a little ETH on ${config.chain}. Nothing was charged.`;
    if (funds && funds.balance < needed) {
      return `The paying wallet holds ${formatUnits(funds.balance)} ${config.token} on ${config.chain}; a ${what} costs ${formatUnits(needed)}. Nothing was charged. Send at least ${formatUnits(needed - funds.balance)} ${config.token} to ${account().address} on ${config.chain}, then ${again}.`;
    }
    if (funds && config.permit2 && funds.allowance !== undefined && funds.allowance < needed) return unapproved;
    // The wallet's own figures win over the desk's code; without them the code says which it was.
    if (!funds && /insufficient_(balance|funds)$/.test(code)) {
      return `The paying wallet holds less than the ${formatUnits(needed)} ${config.token} a ${what} costs on ${config.chain}. Nothing was charged. Send ${config.token} to ${account().address} on ${config.chain}, then ${again}.`;
    }
    if (!funds && config.permit2 && /allowance/.test(code)) return unapproved;
    return code ? `The desk refused the payment: ${sentence(code)} Nothing was charged.` : "The desk refused the payment. Nothing was charged.";
  }

  function possiblyCharged(kind: Posted, receipt: Record<string, unknown>, cause: string): Record<string, unknown> {
    const follow = kind === "task" ? "Read this order with brainchain_get_task; do not post the task again." : "Read the grade with brainchain_get_grade; do not send it again.";
    return { ...receipt, possiblyCharged: true, error: `${cause} The payment may have gone through. ${follow}` };
  }

  /**
   * The desk answers 402 for a payment it refuses, and for a settlement it could not
   * confirm, which it keeps as an order and checks against the chain. Says why such a
   * payment may still be charged, or undefined when the desk has no order or gave it up.
   */
  async function stillOpen(kind: Posted, id: string): Promise<string | undefined> {
    const what = kind === "task" ? "order" : "grade";
    let response: Response;
    try {
      response = await fetchImpl(`${route[kind]}/${id}`, { signal: AbortSignal.timeout(10_000) });
    } catch {
      return `the ${what} could not be read`;
    }
    if (response.status === 404) return undefined;
    const view = response.ok ? await jsonObject(response) : undefined;
    if (typeof view?.state !== "string") return `the ${what} could not be read`;
    return view.state === "failed" ? undefined : `it holds the ${what} as ${view.state}`;
  }

  /** A payment the desk gave up was never charged, so its task can be posted again at once and its amount spent on another. */
  async function release(kind: Kind, id: string): Promise<void> {
    const key = keyed(kind, id);
    paid.get(key)?.forget();
    const hold = held.get(key);
    held.delete(key);
    if (hold) await limits.give(hold);
  }

  /** An agent that retries a post it gave up waiting on gets the first order back instead of paying twice. */
  function post(task: TaskRequest): Promise<unknown> {
    const now = Date.now();
    for (const [key, entry] of recent) if (now - entry.at >= REPOST_AFTER_MINUTES * 60_000) recent.delete(key);
    const key = canonicalStringify({ network: config.network, title: task.title, brief: task.brief, levels: task.levels });
    return once(key, now, () => pay("task", task), "task");
  }

  /** As post, for a grade: an identical request within the window returns the first grade instead of paying again. */
  function grade(request: GradeRequest): Promise<unknown> {
    const now = Date.now();
    for (const [key, entry] of recent) if (now - entry.at >= REPOST_AFTER_MINUTES * 60_000) recent.delete(key);
    const key = canonicalStringify({ kind: "grade", network: config.network, ...request });
    return once(key, now, () => pay("grade", request), "grade");
  }

  function once(key: string, now: number, send: () => Promise<unknown>, kind: Kind): Promise<unknown> {
    const previous = recent.get(key);
    if (previous) return previous.reply.then((reply) => ({ ...(reply as object), duplicate: true }));

    const entry = { at: now, reply: send() };
    recent.set(key, entry);
    const forget = () => {
      if (recent.get(key) === entry) recent.delete(key);
    };
    entry.reply.then((reply) => {
      const { [kind === "task" ? "order" : kind === "grade" ? "grade" : "sitting"]: id, state, briefs } = reply as Record<string, unknown>;
      if (typeof id === "string") paid.set(keyed(kind, id), { at: now, forget });
      // A failed grade's reply says to send it again, and sending it again must not return this reply.
      // Nor must a sitting that came back without its briefs: asked for again, it is read from the desk.
      if (typeof id !== "string" || (kind === "grade" && state === "failed") || (kind === "exam" && !Array.isArray(briefs))) forget();
    }, forget);
    return entry.reply;
  }

  /** An amount that cannot be given back stays counted, the safe direction, and must not hide why the payment stopped. */
  async function unreserve(payment: { hold?: Hold }): Promise<void> {
    const given = payment.hold;
    payment.hold = undefined;
    if (given) await limits.give(given).catch(() => undefined);
  }

  /**
   * A fetch that pays what the desk asks, to this desk alone and at most `cap` a payment, and notes in `payment`
   * how far it got. Every request it sends ends when `signal` aborts.
   */
  function payingFetch(payment: Payment, cap: bigint, signal: AbortSignal): typeof fetch {
    const client = x402Client.fromConfig({
      schemes: [{ network: config.network, client: new ExactEvmScheme(account()) }],
      spendControls: { allowedAssets: [{ network: config.network, asset: config.asset, maxAmountPerPayment: cap.toString() }] },
      policies: [
        (_version, requirements) => {
          const kept = requirements.filter(
            (r) => r.network === config.network && sameAddress(r.asset, config.asset) && sameAddress(r.payTo, config.payTo) && r.maxTimeoutSeconds <= MAX_TIMEOUT_SECONDS,
          );
          if (kept.length === 0) payment.refused = refusedTerms(requirements);
          return kept;
        },
      ],
    });
    // A payment is reserved against the budget and the daily limit before it is
    // signed, so parallel calls cannot overshoot either. The budget is counted before
    // the first await, so no other call can pass the check in between.
    client.onBeforePaymentCreation(async ({ selectedRequirements }) => {
      const taken = await limits.take(BigInt(selectedRequirements.amount));
      if (typeof taken === "string") return { abort: true, reason: taken };
      payment.hold = taken;
    });
    client.onAfterPaymentCreation(async ({ paymentPayload }) => {
      payment.signed = paymentPayload;
    });
    client.onPaymentCreationFailure(async () => {
      if (!payment.signed) await unreserve(payment);
    });
    // The x402 client sends clones of the request, and a clone follows the request's signal
    // through weak references only, so once garbage is collected a deadline set on the request
    // never fires. Each request it sends carries the deadline itself, which the timer keeps alive.
    return wrapFetchWithPayment((input, init) => {
      const headers = input instanceof Request ? input.headers : new Headers(init?.headers);
      const name = PAYMENT_HEADERS.find((header) => headers.has(header));
      if (name) payment.header = [name, headers.get(name)!];
      return fetchImpl(input, { ...init, signal });
    }, client);
  }

  /** Short enough that a possiblyCharged reply reaches a client that gives up after 60 seconds. */
  function timeLimit(): { signal: AbortSignal; clear: () => void } {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")), options.postTimeoutMs ?? 45_000);
    return { signal: deadline.signal, clear: () => clearTimeout(timer) };
  }

  async function pay(kind: Posted, body: TaskRequest | GradeRequest): Promise<unknown> {
    const url = route[kind];
    const payment: Payment = {};
    const price = () => `${formatUnits(payment.hold?.amount ?? 0n)} ${config.token}`;
    const receipt = (id: string) => {
      if (payment.hold) held.set(keyed(kind, id), payment.hold);
      return kind === "task" ? { order: id, price: price(), statusUrl: `${endpoint}/${id}` } : { grade: id, price: price(), statusUrl: `${gradesEndpoint}/${id}` };
    };

    const limit = timeLimit();
    let response: Response;
    try {
      response = await payingFetch(payment, config.maxPrice, limit.signal)(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (error) {
      limit.clear();
      if (payment.signed) return possiblyCharged(kind, receipt(orderIdOf(payment.signed)), `The desk did not confirm the ${kind === "task" ? "order" : "grade"} (${firstLine(error)}).`);
      throw new Error(await explainUnsigned(kind, error, payment.refused));
    }
    // A desk or proxy can send its headers and then stall, so the deadline holds until the body is read.
    const reply = (await until(limit.signal, jsonObject(response)).catch(() => undefined)) ?? {};
    limit.clear();
    const { signed } = payment;
    const idOf = (fallback: string) => (kind === "task" ? (typeof reply.order === "string" ? reply.order : fallback) : typeof reply.grade === "string" ? reply.grade : fallback);
    if (response.ok) {
      if (!signed) {
        throw new Error(`The desk at ${config.desk} answered ${response.status} without asking for payment, so nothing was ${kind === "task" ? "posted" : "graded"}. Check BRAINCHAIN_DESK_URL. Nothing was charged.`);
      }
      const id = idOf(orderIdOf(signed));
      // The desk answers an identical grade from the same wallet with the earlier one and cancels this payment.
      const cancelled = kind === "grade" && id.toLowerCase() !== orderIdOf(signed).toLowerCase();
      const failed = kind === "grade" && reply.state === "failed";
      if (cancelled || failed) await unreserve(payment);
      if (failed) await release(kind, id);
      const done = { ...reply, ...receipt(id), ...(cancelled ? { duplicate: true } : {}) };
      return kind === "task" ? done : { ...done, ...gradeGuidance(done) };
    }
    // The desk answers 400 (a brief it refuses, including one too large to post)
    // before settling. Any other answer to a signed payment may have charged it,
    // a 402 included unless the desk has no order for it or gave the payment up.
    if (signed && response.status !== 400 && response.status !== 402) {
      return possiblyCharged(kind, receipt(idOf(orderIdOf(signed))), `The desk answered ${response.status}.`);
    }
    if (signed && response.status === 402) {
      const order = orderIdOf(signed);
      const open = await stillOpen(kind, order);
      const reason = typeof reply.error === "string" && reply.error.trim() ? ` (${reply.error.trim().replace(/[.!?]+$/, "")})` : "";
      if (open) return possiblyCharged(kind, receipt(order), `The desk answered 402${reason}, and ${open}.`);
    }

    await unreserve(payment);
    if (response.status === 402) throw new Error(await explainRefusal(kind, reply.error, PRICE[kind]));
    throw new Error(typeof reply.error === "string" && reply.error.trim() ? `${sentence(reply.error)} Nothing was charged.` : `The desk answered ${response.status}. Nothing was charged.`);
  }

  /**
   * Sittings this process paid for that the desk had not opened when it last answered, by agent and class: each
   * with its request and payment as they were sent. The desk answers a payment it has taken from the sitting it
   * bought and never charges it twice, so sending the same two again is how such a sitting is read.
   */
  const unopened = new Map<string, Unopened>();
  const askAgain = "Call brainchain_sit_exam again with the same agentId and class: it sends the same request with the same payment, which the desk does not charge twice.";
  const failure = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));

  const ask = (sitting: Unopened, signal: AbortSignal): Promise<Response | Error> =>
    fetchImpl(route.exam, { method: "POST", headers: { "content-type": "application/json", [sitting.header[0]]: sitting.header[1] }, body: sitting.body, signal }).catch(failure);

  /** True after `ms`, or false as soon as `signal` aborts. */
  const pause = (ms: number, signal: AbortSignal) => until(signal, new Promise<boolean>((resolve) => setTimeout(() => resolve(true), ms))).catch(() => false);

  /**
   * Reads what the desk answered a paid sitting with, and while it says the items are still to be drawn, asks
   * again until `signal` aborts. A refusal that charged nothing gives the amount back and is thrown in the desk's
   * own words; any other answer keeps the sitting, so the next call for the same agent and class asks for it again.
   */
  async function follow(key: string, sitting: Unopened, first: Response | Error, signal: AbortSignal): Promise<unknown> {
    unopened.set(key, sitting);
    const receipt = { sitting: sitting.id, price: `${formatUnits(sitting.hold?.amount ?? 0n)} ${config.token}`, statusUrl: `${config.desk}/exams/${sitting.id}` };
    const uncharged = async (why: string): Promise<never> => {
      unopened.delete(key);
      await unreserve(sitting);
      throw new Error(why);
    };
    let waiting: Record<string, unknown> | undefined;
    for (let answer = first; ; answer = await ask(sitting, signal)) {
      if (answer instanceof Error) {
        return waiting ?? { ...receipt, possiblyCharged: true, done: false, error: `The desk did not confirm the sitting (${firstLine(answer)}). The payment may have gone through. ${askAgain}`, retryAfterSeconds: 30 };
      }
      const reply = (await until(signal, jsonObject(answer)).catch(() => undefined)) ?? {};
      if (answer.ok && Array.isArray(reply.briefs)) {
        unopened.delete(key);
        return { ...reply, ...receipt, ...sittingGuidance(reply) };
      }
      const said = typeof reply.error === "string" ? reply.error.trim() : "";
      if (/Nothing was charged/.test(said)) return uncharged(said);
      // As for a task or a grade, the desk answers 400 before it settles anything.
      if (answer.status === 400) return uncharged(said ? `${sentence(said)} Nothing was charged.` : "The desk answered 400. Nothing was charged.");
      if (answer.status === 402) return uncharged(await explainRefusal("exam", reply.error, sitting.hold?.amount ?? 0n));
      // 409 with the sitting named is the desk still taking the payment.
      if (answer.status !== 202 && answer.status !== 502 && !(answer.status === 409 && typeof reply.sitting === "string")) {
        const reason = said ? ` (${said.replace(/[.!?]+$/, "")})` : "";
        return { ...receipt, possiblyCharged: true, done: false, error: `The desk answered ${answer.status}${reason}. The payment may have gone through. ${askAgain}`, retryAfterSeconds: 60 };
      }
      const told = said || (typeof reply.message === "string" && reply.message.trim()) || "The desk has not opened the sitting yet.";
      waiting = {
        ...receipt,
        ...(typeof reply.state === "string" ? { state: reply.state } : {}),
        ...(typeof reply.reason === "string" ? { reason: reply.reason } : {}),
        done: false,
        next: `${sentence(told)} ${askAgain}`,
        retryAfterSeconds: 30,
      };
      if (!(await pause(options.askAgainMs ?? 3_000, signal))) return waiting;
    }
  }

  /**
   * Pays for a sitting at the price the desk states, and at no other: the limit per payment is that price for this
   * one payment, whatever BRAINCHAIN_MAX_PRICE_UNITS says, and a price the budget or the daily limit cannot hold
   * is refused before anything is signed.
   */
  async function openSitting(key: string, request: SittingRequest): Promise<unknown> {
    const wallet = account();
    const price = await quotedPrice("exam");
    if (price === undefined) {
      throw new Error(`The desk at ${config.desk} named no price for a sitting on ${config.chain}, so nothing was signed. It may be out of reach, or the exam may not be open on this network: brainchain_exam_info says. Nothing was charged.`);
    }
    const over = (limit: bigint, what: string, setting: string) =>
      `A sitting costs ${formatUnits(price)} ${config.token}, above ${what} of ${formatUnits(limit)} (${setting}). Raise it and restart the server to allow the sitting. Nothing was charged.`;
    if (price > config.budget) throw new Error(over(config.budget, "this server's budget per run", "BRAINCHAIN_BUDGET_UNITS"));
    if (config.daily !== undefined && price > config.daily) throw new Error(over(config.daily, "this wallet's daily limit", "BRAINCHAIN_DAILY_UNITS"));

    const agent = { chainId: config.identityChainId, id: request.agentId };
    const at = Math.floor(Date.now() / 1000);
    const signature = await wallet.signMessage({ message: sittingMessage(config.brainchainId, agent, request.class, at) });
    const body = JSON.stringify({ agent, class: request.class, wallet: wallet.address, at, signature });
    const payment: Payment = {};
    const limit = timeLimit();
    try {
      const answer = await payingFetch(payment, price, limit.signal)(route.exam, { method: "POST", headers: { "content-type": "application/json" }, body }).catch(failure);
      if (payment.signed && payment.header) return await follow(key, { id: orderIdOf(payment.signed), body, header: payment.header, hold: payment.hold }, answer, limit.signal);
      // Nothing left this server signed, so nothing can have been charged.
      await unreserve(payment);
      if (answer instanceof Error) throw new Error(await explainUnsigned("exam", answer, payment.refused));
      const reply = (await until(limit.signal, jsonObject(answer)).catch(() => undefined)) ?? {};
      if (answer.ok) throw new Error(`The desk at ${config.desk} answered ${answer.status} without asking for payment, so no sitting was opened. Check BRAINCHAIN_DESK_URL. Nothing was charged.`);
      const said = typeof reply.error === "string" ? reply.error.trim() : "";
      throw new Error(/Nothing was charged/.test(said) ? said : said ? `${sentence(said)} Nothing was charged.` : `The desk answered ${answer.status}. Nothing was charged.`);
    } finally {
      limit.clear();
    }
  }

  /** A sitting paid for and not yet opened is asked for again in place of a new one; an identical call otherwise returns the first sitting, as an identical post does. */
  function sit(request: SittingRequest): Promise<unknown> {
    const now = Date.now();
    for (const [key, entry] of recent) if (now - entry.at >= REPOST_AFTER_MINUTES * 60_000) recent.delete(key);
    const key = canonicalStringify({ kind: "exam", network: config.network, ...request });
    const waiting = unopened.get(key);
    if (!waiting) return once(key, now, () => openSitting(key, request), "exam");
    const limit = timeLimit();
    return ask(waiting, limit.signal)
      .then((answer) => follow(key, waiting, answer, limit.signal))
      .finally(limit.clear);
  }

  /** One free read of the desk as JSON; undefined for what the desk does not have. */
  async function read(url: string): Promise<Record<string, unknown> | undefined> {
    let response: Response;
    try {
      response = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
    } catch (error) {
      throw new Error(`Could not reach the desk (${firstLine(error)}). Try again in a minute.`);
    }
    const view = await jsonObject(response);
    if (response.status === 404) return undefined;
    if (response.status >= 500 || RETRY_LATER.has(response.status)) throw new Error(`The desk answered ${response.status}: it is busy or briefly unavailable. Try again in a minute.`);
    if (!response.ok) throw new Error(typeof view?.error === "string" ? view.error : `The desk answered ${response.status}.`);
    if (!view) throw new Error("The desk's reply could not be read. Try again shortly.");
    return view;
  }

  const closed = `The licence exam is not open at ${config.desk}.`;

  async function examInfo(): Promise<unknown> {
    const view = await read(`${config.desk}/exams`);
    if (!view) throw new Error(closed);
    const pool = view.pool as { inUse?: unknown } | undefined;
    // Every item in use is named by its commitment, which a sitter has no use for: the count says as much.
    return Array.isArray(pool?.inUse) ? { ...view, pool: { ...pool, inUse: pool.inUse.length } } : view;
  }

  /** Signs and sends the work for one item. The desk takes one delivery an item, so a delivery it did not confirm is read before it is sent again. */
  async function submitExam(sitting: string, item: number, text: string): Promise<unknown> {
    const signature = await account().signMessage({ message: resultMessage(config.brainchainId, sitting, item, text) });
    const unconfirmed = (cause: string) => ({
      sitting,
      item,
      possiblyDelivered: true,
      error: `${cause} The work may have arrived. Read the sitting with brainchain_exam_status, and send the item again only if it still reads open.`,
    });
    let response: Response;
    try {
      response = await fetchImpl(`${config.desk}/exams/${sitting}/items/${item}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, signature }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      return unconfirmed(`The desk did not confirm the delivery (${firstLine(error)}).`);
    }
    const reply = (await jsonObject(response)) ?? {};
    if (response.ok) return { ...reply, next: "Delivered, and the desk judges it next. Read the outcome with brainchain_exam_status." };
    if (typeof reply.error === "string" && reply.error.trim()) throw new Error(reply.error.trim());
    if (response.status >= 500) return unconfirmed(`The desk answered ${response.status}.`);
    throw new Error(`The desk answered ${response.status}.`);
  }

  /** A sitting as anyone may read it, with its briefs when this wallet, the one sitting it, signs for them. */
  async function examStatus(sitting: string, briefs: boolean): Promise<unknown> {
    let url = `${config.desk}/exams/${sitting}`;
    if (briefs) {
      const at = Math.floor(Date.now() / 1000);
      url += `/briefs?at=${at}&signature=${await account().signMessage({ message: briefsMessage(config.brainchainId, sitting, at) })}`;
    }
    let response: Response;
    try {
      response = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
    } catch (error) {
      return { sitting, error: `Could not reach the desk (${firstLine(error)}).`, done: false, next: "Read the sitting again after retryAfterSeconds.", retryAfterSeconds: 30 };
    }
    const view = await jsonObject(response);
    if (response.status === 404) {
      // The desk shows a sitting once it has opened it, and one paid for here may not have been yet.
      if (![...unopened.values()].some((paidFor) => paidFor.id === sitting)) throw new Error("The desk has no sitting with this id. Check the id: it must be one that brainchain_sit_exam returned.");
      return { sitting, done: false, next: `The sitting is paid for, and the desk has not opened it yet. ${askAgain}`, retryAfterSeconds: 30 };
    }
    if (response.status >= 500 || RETRY_LATER.has(response.status)) {
      return { sitting, error: `The desk answered ${response.status}.`, done: false, next: "The desk is busy or briefly unavailable. Read the sitting again after retryAfterSeconds.", retryAfterSeconds: retryAfter(response) ?? 30 };
    }
    if (!response.ok) throw new Error(typeof view?.error === "string" ? view.error : `The desk answered ${response.status}.`);
    if (!view) return { sitting, error: "The desk's reply could not be read.", done: false, next: "Read the sitting again shortly.", retryAfterSeconds: 30 };
    return { ...view, ...sittingGuidance(view) };
  }

  async function licences(agentId: string): Promise<unknown> {
    const view = await read(`${config.desk}/licences/${config.identityChainId}/${agentId}`);
    if (!view) throw new Error(closed);
    const none = Array.isArray(view.licences) && view.licences.length === 0;
    return none ? { ...view, next: `Agent ${agentId} holds no licence. brainchain_exam_info says what a sitting takes, and brainchain_sit_exam opens one.` } : view;
  }

  /** The head and first entries of an agent's numbered record, and what its Papers say of its epoch, licences and ceiling. */
  async function agentRecord(agentId: string): Promise<unknown> {
    const recordUrl = `${config.desk}/agents/${config.identityChainId}/${agentId}/record`;
    const papersUrl = `${config.desk}/papers/${config.identityChainId}/${agentId}`;
    const [record, file] = await Promise.all([read(`${recordUrl}?from=1&limit=${RECORD_PAGE}`), read(papersUrl)]);
    if (!record && !file) throw new Error(`The desk has no record and no Papers for agent ${agentId} on chain ${config.identityChainId}. Check the id.`);
    const papers = (file?.brainchain as { papers?: Record<string, unknown> } | undefined)?.papers;
    return {
      agent: { chainId: config.identityChainId, id: agentId },
      record: record
        ? { url: recordUrl, head: record.head, entries: record.entries, ...(typeof record.next === "string" ? { next: `${config.desk}${record.next}` } : {}) }
        : { url: recordUrl, entries: [], note: "The desk has no entry on record for this agent." },
      papers: papers
        ? { url: papersUrl, signedAt: papers.at, epoch: papers.epoch, licences: papers.licences, ...(papers.ceiling === undefined ? {} : { ceiling: papers.ceiling }) }
        : { url: papersUrl, note: "The desk serves no Papers for this agent." },
      verify: typeof papers?.verify === "string" ? papers.verify : `npx brainchain-verify ${config.name} --record ${agentId}`,
    };
  }

  async function get(order: string): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(`${endpoint}/${order}`, { signal: AbortSignal.timeout(20_000) });
    } catch (error) {
      return { order, error: `Could not reach the desk (${firstLine(error)}).`, done: false, next: "Read the order again after retryAfterSeconds.", retryAfterSeconds: 30 };
    }
    const view = await jsonObject(response);
    if (response.status === 404) {
      if (paid.has(keyed("grade", order))) throw new Error("This id is a grade, not a task's order. Read it with brainchain_get_grade.");
      const at = paid.get(keyed("task", order))?.at;
      // Only an order this server paid for can be said never to have been charged.
      if (at === undefined) throw new Error("The desk has no order with this id. Check the id: it must be one that brainchain_post_task returned.");
      if (Date.now() - at >= REPOST_AFTER_MINUTES * 60_000) {
        await release("task", order);
        throw new Error(`The desk has no order with this id. This server posted it more than ${REPOST_AFTER_MINUTES} minutes ago, so it was never charged, and the task can be posted again.`);
      }
      return {
        order,
        error: "The desk has no order with this id.",
        done: false,
        next: `If brainchain_post_task said possiblyCharged, the payment either never reached the desk or is still settling. Read the order again in a minute. If the desk still has no record ${REPOST_AFTER_MINUTES} minutes after you posted, nothing was charged and you can post the task again.`,
        retryAfterSeconds: 60,
      };
    }
    if (response.status >= 500 || RETRY_LATER.has(response.status)) {
      return { order, error: `The desk answered ${response.status}.`, done: false, next: "The desk is busy or briefly unavailable. Read the order again after retryAfterSeconds.", retryAfterSeconds: retryAfter(response) ?? 30 };
    }
    if (!response.ok) throw new Error(typeof view?.error === "string" ? view.error : `The desk answered ${response.status}.`);
    // An unreadable 2xx comes from a proxy or a dropped connection; ask again.
    if (!view) return { order, error: "The desk's reply could not be read.", done: false, next: "Read the order again shortly.", retryAfterSeconds: 30 };
    if (view.state === "failed") await release("task", order);
    // Results are served by the desk itself; anything else is left as a link.
    if (typeof view.result === "string" && view.result.startsWith(`${config.desk}/records/`)) {
      try {
        const text = await fetchImpl(view.result, { signal: AbortSignal.timeout(20_000) });
        if (text.ok) {
          const { text: full, cut } = await capped(text);
          view.resultText =
            full.length <= RESULT_LIMIT && !cut
              ? full
              : `${full.slice(0, RESULT_LIMIT)}\n\n[Cut at ${RESULT_LIMIT.toLocaleString("en-US")} of ${cut ? "more than " : ""}${full.length.toLocaleString("en-US")} UTF-16 units. The full result is at ${view.result}.]`;
        } else view.resultError = `The result could not be fetched (HTTP ${text.status}); it is at ${view.result}.`;
      } catch (error) {
        view.resultError = `The result could not be fetched (${firstLine(error)}); it is at ${view.result}.`;
      }
    }
    return { ...view, ...guidance(view, config) };
  }

  /** A grade's verdict as the desk keeps it; reading it is free and needs no key. */
  async function getGrade(id: string): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(`${gradesEndpoint}/${id}`, { signal: AbortSignal.timeout(20_000) });
    } catch (error) {
      return { grade: id, error: `Could not reach the desk (${firstLine(error)}).`, done: false, next: "Read the grade again after retryAfterSeconds.", retryAfterSeconds: 30 };
    }
    const view = await jsonObject(response);
    if (response.status === 404) {
      if (paid.has(keyed("task", id))) throw new Error("This id is a task's order, not a grade. Read it with brainchain_get_task.");
      const at = paid.get(keyed("grade", id))?.at;
      if (at === undefined) throw new Error("The desk has no grade with this id. Check the id: it must be one that brainchain_grade returned.");
      if (Date.now() - at < REPOST_AFTER_MINUTES * 60_000) {
        return {
          grade: id,
          error: "The desk has no grade with this id.",
          done: false,
          next: "If brainchain_grade said possiblyCharged, the payment is still settling or never reached the desk. Read the grade again in a minute.",
          retryAfterSeconds: 60,
        };
      }
      await release("grade", id);
      throw new Error(`The desk has no grade with this id. This server sent it more than ${REPOST_AFTER_MINUTES} minutes ago, so it was never charged, and it can be sent again.`);
    }
    if (response.status >= 500 || RETRY_LATER.has(response.status)) {
      return { grade: id, error: `The desk answered ${response.status}.`, done: false, next: "The desk is busy or briefly unavailable. Read the grade again after retryAfterSeconds.", retryAfterSeconds: retryAfter(response) ?? 30 };
    }
    if (!response.ok) throw new Error(typeof view?.error === "string" ? view.error : `The desk answered ${response.status}.`);
    if (!view) return { grade: id, error: "The desk's reply could not be read.", done: false, next: "Read the grade again shortly.", retryAfterSeconds: 30 };
    if (view.state === "failed") await release("grade", id);
    return { ...view, ...gradeGuidance(view) };
  }

  return { post, get, grade, getGrade, examInfo, sit, submitExam, examStatus, licences, agentRecord, spent: () => limits.spent() };
}

/** What this server pays the desk for. A task and a grade are read back at a route of their own; a sitting is asked for again with its payment. */
type Kind = "task" | "grade" | "exam";
type Posted = Exclude<Kind, "exam">;

/** The headers an x402 payment travels in: version 2's, and version 1's. */
const PAYMENT_HEADERS = ["payment-signature", "x-payment"];

/** One payment as it goes: what it holds against the limits, what was signed, and the header it left in. */
interface Payment {
  hold?: Hold;
  signed?: { payload: unknown };
  header?: [string, string];
  /** Why every term the desk offered was turned down, when all were. */
  refused?: string;
}

/** A paid sitting the desk has still to open: its id, the request and the payment header as they were sent, and what it holds against the limits. */
interface Unopened {
  id: string;
  body: string;
  header: [string, string];
  hold?: Hold;
}

/** What a grade's state means for the caller. */
export function gradeGuidance(view: Record<string, unknown>): Guidance {
  if (view.state === "graded") {
    const pass = typeof view.passProbability === "number" ? ` at ${Math.round(view.passProbability * 100)}%` : "";
    return { done: true, next: view.accepted === true ? `Jev accepts the work${pass}. The record is at decision.page.` : `Jev does not accept the work${pass}. The record is at decision.page.` };
  }
  if (view.state === "failed") return { done: true, next: "The payment did not go through, so nothing was charged and the work was not graded. Send it again with brainchain_grade." };
  if (view.state === "unconfirmed") return { done: false, next: "The desk is confirming the payment on chain. Read the grade with brainchain_get_grade after retryAfterSeconds; do not send it again.", retryAfterSeconds: 30 };
  return { done: false, next: "Jev is still grading the work. Read the grade with brainchain_get_grade after retryAfterSeconds; reading it is free.", retryAfterSeconds: 20 };
}

interface Guidance {
  done: boolean;
  next: string;
  retryAfterSeconds?: number;
}

/** What the order means for the caller, and when to look again. Every state and status pair is in payments.test.ts. */
export function guidance(view: Record<string, unknown>, config: Pick<Config, "terms">, now = Date.now()): Guidance {
  const task = (view.task ?? {}) as { status?: string; accepted?: boolean; due?: { by?: unknown } };
  const wait = (retryAfterSeconds: number, next: string): Guidance => ({ done: false, next, retryAfterSeconds });
  const { chain, escrow } = paidOn(view.network);
  // The desk sends no refund for an escrowed order: the escrow gives the money back, with no transaction of the desk's to wait for.
  const escrowReturns = `escrow on ${chain} that holds the payment returns the full amount`;
  const refunding = escrow ? `The ${escrowReturns}.` : `The refund is being sent on ${chain}.`;
  // Without a task the desk could not post the order, so no work ever existed.
  const why = typeof view.refundReason === "string" ? `${view.refundReason} ` : task.status === undefined ? "The task could not be posted. " : "";
  const due = typeof task.due?.by === "string" ? task.due.by : undefined;
  const by = due ? ` by ${due}` : "";
  // The board refunds a step that misses its deadline; saying when lets the caller stop waiting at the right time.
  const unless = (missed: string) => (due ? ` If ${missed}${by}, the full amount is refunded.` : "");
  const fetched = typeof view.resultText === "string";
  const link = !fetched && typeof view.result === "string" && view.resultError === undefined ? view.result : undefined;
  const result = fetched ? " The result follows this summary." : link ? ` The result is at ${link}.` : "";
  // Accepted comes from the grade alone: a ruling can pay work the grade rejected.
  const paid = (): Guidance => ({ done: true, next: `${task.accepted === true ? "Jev accepted the work and the model was paid" : "The model was paid"}.${result}` });
  // Not done: the caller is owed a refund transaction, and the model can still dispute.
  // The caller hears the verdict now and comes back once, when the window has closed.
  const rejected = (): Guidance => {
    const start = "Jev did not accept the work, so the result is withheld.";
    const closes = due === undefined ? NaN : Date.parse(due);
    const left = Number.isFinite(closes) ? Math.ceil((closes - now) / 1000) : undefined;
    // The desk sends the refund within a minute or two of the window closing.
    if (left !== undefined && left <= 0) return wait(60, `${start} The dispute window has closed, so ${escrow ? `the ${escrowReturns}` : `the full amount is refunded on ${chain} shortly`}.`);
    const when = left === undefined ? `, ${config.terms.finalAfter} after grading` : ` at ${due}`;
    return wait(
      left === undefined ? 900 : left + 60,
      escrow
        ? `${start} The ${escrowReturns}, unless the model disputes the grade before the dispute window closes${when}${left === undefined ? "," : ""} and a ruling pays it. Report this now, then read the order again after that time.`
        : `${start} The full amount is refunded on ${chain} when the dispute window closes${when}, unless the model disputes the grade and a ruling pays it. Report this now, then read the order again after that time for the refund transaction.`,
    );
  };

  switch (view.state) {
    case "paid-out":
      return paid();
    case "refunded":
      return { done: true, next: escrow ? `${why}The ${escrowReturns}.` : `${why}The full amount was refunded on ${chain}${typeof view.refundTx === "string" ? ` in ${view.refundTx}` : ""}.` };
    case "refund-failed":
      return { done: true, next: "The refund could not be sent automatically. Write to hello@usebrainchain.com with this order id." };
    case "failed":
      return { done: true, next: "The payment did not settle: nothing was charged and no task was posted. You can post the task again." };
    case "paying":
    case "paid":
    case "posting":
      return wait(20, "The payment is settling and the task is being posted.");
    case "unconfirmed":
      return wait(30, "The payment may have gone through; BrainChain is checking it against the chain. Do not post the task again.");
    case "refunding":
      return wait(60, `${why}${refunding}`);
  }

  switch (task.status) {
    case "paid":
      return paid();
    case "refunded":
      // The board has returned the money to the desk; the payer's refund transaction comes next.
      return wait(60, `${why}${refunding}`);
    // A dispute, a ruling under its appeal window and an appeal can each still change a grade, accepted or not.
    case "disputed":
      return wait(600, `The grade is disputed; Jev rules on it${by}. If no ruling comes, the grade stands.${result}`);
    case "ruled":
      return wait(900, `Jev ruled on the dispute. The ruling settles when its appeal window closes${due ? ` at ${due}` : ""}, unless the side it went against appeals.${result}`);
    case "appealed":
      return wait(600, `The ruling was appealed; Jev rules again${by}. If no second ruling comes, the first one stands.${result}`);
    case "graded":
      if (task.accepted === true) {
        // The caller has what it paid for, and on a desk task only the model could still dispute, against its own payment.
        if (result) return { done: true, next: `Jev accepted the work.${result} The payment becomes final when the dispute window closes, ${config.terms.finalAfter} after grading.` };
        return wait(60, typeof view.resultError === "string" ? "Jev accepted the work, but the result could not be read just now." : "Jev accepted the work; the result is being prepared.");
      }
      if (task.accepted === false) return rejected();
      return wait(60, "Jev graded the work; the verdict is being recorded.");
    case "open":
      return wait(60, `Waiting for Jev to hire a model.${unless("no model is hired")}`);
    case "hired":
      return wait(60, `A model is working on the task.${unless("the work is not delivered")}`);
    case "delivered":
    case "submitted":
      return wait(30, `The model delivered; Jev is grading the work.${unless("Jev has not graded it")}`);
  }
  // The order can read posted a moment before the task's status reaches it.
  if (view.state === "posted" && task.status === undefined) return wait(20, "The task is posted; its status shows here shortly.");
  return wait(60, "The order is in progress.");
}
