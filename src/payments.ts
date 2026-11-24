import type { ClientEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment, x402Client, type PaymentRequirements } from "@x402/fetch";
import { keccak256, parseAbi, RpcRequestError, toBytes } from "viem";

import { formatMoney, formatUnits, MAX_TIMEOUT_SECONDS, PRICE, REPOST_AFTER_MINUTES, type Config } from "./config.js";
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

export function createDesk(options: DeskOptions): Desk & { spent(): bigint; track(grade: string): void } {
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
  const keyed = (kind: Posted, id: string) => `${kind}:${id.toLowerCase()}`;

  /** The offers this server may take: its own network, asset and payee. */
  const ours = <T extends { network?: string; asset?: string; payTo?: string }>(offers: readonly T[]) =>
    offers.filter((offer) => offer.network === config.network && typeof offer.asset === "string" && sameAddress(offer.asset, config.asset) && typeof offer.payTo === "string" && sameAddress(offer.payTo, config.payTo));

  /** The desk's price, read from a fresh 402 challenge. */
  async function quotedPrice(kind: Kind, signal = AbortSignal.timeout(15_000)): Promise<bigint | undefined> {
    return (await quote(kind, signal)).price;
  }

  /** The price in the offer this server would take, or, when the desk offered only others, why it takes none. */
  async function quote(kind: Kind, signal = AbortSignal.timeout(15_000)): Promise<{ price?: bigint; refused?: string }> {
    try {
      const probe = await fetchImpl(route[kind], {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        signal,
      });
      const header = probe.headers.get("payment-required");
      if (!header) return {};
      const offers = (JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { accepts?: Offer[] }).accepts ?? [];
      const kept = ours(offers);
      const amount = (kind === "exam" ? byAuthorization(kept) : kept[0])?.amount;
      if (amount) return { price: BigInt(amount) };
      const elsewhere = offers.filter((offer) => offer.network === config.network && typeof offer.payTo === "string" && typeof offer.maxTimeoutSeconds === "number");
      return elsewhere.length > 0 ? { refused: refusedTerms(elsewhere as { payTo: string; maxTimeoutSeconds: number }[]) } : {};
    } catch {
      return {};
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
      return `The desk's price for a sitting changed between reading it and paying it, so nothing was signed. Read the price again with brainchain_exam_info and sit again with it. Nothing was charged.`;
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
  async function explainRefusal(kind: Kind, reason: unknown, price: bigint, permit2 = config.permit2): Promise<string> {
    const code = typeof reason === "string" ? reason.trim() : "";
    // One deadline for both reads, so a slow chain cannot hold the reply, and either can fail without the other.
    const deadline = AbortSignal.timeout(10_000);
    const [funds, quoted] = await Promise.all([options.funds ? until(deadline, options.funds()).catch(() => undefined) : undefined, quotedPrice(kind, deadline)]);
    const needed = quoted ?? price;
    const what = kind === "exam" ? "sitting" : kind;
    // A sitting's amounts are shown as prices are, with two decimals; a task's and a grade's as they always were.
    const shown = kind === "exam" ? formatMoney : formatUnits;
    const again = kind === "task" ? "post again" : kind === "grade" ? "send it again" : "sit again";
    // `approve` with no amount lets Permit2 spend 100 USDG, more than a task or a grade costs. A sitting's approval is
    // its exact price, the smallest that works, so it is used up by that sitting and asked for again before the next.
    const unapproved =
      kind === "exam"
        ? `Permit2 is not yet approved to spend this wallet's ${config.token} for the ${formatMoney(needed)} ${config.token} this sitting costs; each sitting needs its own approval. ` +
          `Ask your operator to run \`${approveCommand} ${formatUnits(needed)}\`; it allows exactly this sitting's price, and needs a little ETH on ${config.chain}. Nothing was charged.`
        : `Permit2 is not yet approved to spend this wallet's ${config.token}. Ask your operator to run \`${approveCommand}\` once with the key this server uses; it needs a little ETH on ${config.chain}. Nothing was charged.`;
    if (funds && funds.balance < needed) {
      return `The paying wallet holds ${shown(funds.balance)} ${config.token} on ${config.chain}; a ${what} costs ${shown(needed)}. Nothing was charged. Send at least ${shown(needed - funds.balance)} ${config.token} to ${account().address} on ${config.chain}, then ${again}.`;
    }
    if (funds && permit2 && funds.allowance !== undefined && funds.allowance < needed) return unapproved;
    // The wallet's own figures win over the desk's code; without them the code says which it was.
    if (!funds && /insufficient_(balance|funds)$/.test(code)) {
      return `The paying wallet holds less than the ${shown(needed)} ${config.token} a ${what} costs on ${config.chain}. Nothing was charged. Send ${config.token} to ${account().address} on ${config.chain}, then ${again}.`;
    }
    if (permit2 && funds?.allowance === undefined && /allowance/.test(code)) return unapproved;
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
  async function release(kind: Posted, id: string): Promise<void> {
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
      if (typeof id === "string" && kind !== "exam") paid.set(keyed(kind, id), { at: now, forget });
      // A failed grade's reply says to send it again, and sending it again must not return this reply. Nor must a
      // sitting that came back without its briefs, which is read from the desk when asked for again, or a void one,
      // which the agent may sit again at once.
      if (typeof id !== "string" || (kind === "grade" && state === "failed") || (kind === "exam" && (!Array.isArray(briefs) || state === "void"))) forget();
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
   * how far it got. Every request it sends ends when `signal` aborts. With `authorize`, an offer paid by transfer
   * authorization is taken over one through Permit2, which needs an approval first.
   */
  function payingFetch(payment: Payment, cap: bigint, signal: AbortSignal, authorize = false): typeof fetch {
    const client = x402Client.fromConfig({
      schemes: [{ network: config.network, client: new ExactEvmScheme(account()) }],
      ...(authorize ? { paymentRequirementsSelector: (_version: number, offers: PaymentRequirements[]) => byAuthorization(offers)! } : {}),
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
      payment.permit2 = selectedRequirements.extra?.assetTransferMethod === "permit2";
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
      const why = await explainUnsigned(kind, error, payment.refused);
      throw /Payment creation aborted: |rejected by spendControls/.test(firstLine(error)) ? new PaymentRefused(why) : new Error(why);
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
    // A 402 may have charged the payment unless the desk has no order for it or gave it up, which it is asked below.
    if (signed && !refusedBeforeSettling(response.status)) {
      return possiblyCharged(kind, receipt(idOf(orderIdOf(signed))), `The desk answered ${response.status}.`);
    }
    if (signed && response.status === 402) {
      const order = orderIdOf(signed);
      const open = await stillOpen(kind, order);
      const reason = typeof reply.error === "string" && reply.error.trim() ? ` (${reply.error.trim().replace(/[.!?]+$/, "")})` : "";
      if (open) return possiblyCharged(kind, receipt(order), `The desk answered 402${reason}, and ${open}.`);
    }

    await unreserve(payment);
    if (response.status === 402 || response.status === 412) throw new PaymentRefused(await explainRefusal(kind, refusalCode(response.status, reply), PRICE[kind], payment.permit2));
    throw new Error(typeof reply.error === "string" && reply.error.trim() ? `${sentence(reply.error)} Nothing was charged.` : `The desk answered ${response.status}. Nothing was charged.`);
  }

  /**
   * Sittings this process paid for that BrainChain had not opened at the desk's last answer, by agent and class,
   * each with the request and payment header exactly as sent. Sending that same pair again is how this server reads
   * the sitting: the desk recognises a payment it has already taken and answers from its sitting without charging.
   */
  const unopened = new Map<string, Unopened>();
  const askAgain = "Call brainchain_sit_exam again with the same agentId and class: it sends the same request with the same payment, which the desk does not charge twice.";
  const failure = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));

  const ask = (sitting: Unopened, signal: AbortSignal): Promise<Response | Error> =>
    fetchImpl(route.exam, { method: "POST", headers: { "content-type": "application/json", [sitting.header[0]]: sitting.header[1] }, body: sitting.body, signal }).catch(failure);

  /** True after `ms`, or false as soon as `signal` aborts. */
  const pause = (ms: number, signal: AbortSignal) => until(signal, new Promise<boolean>((resolve) => setTimeout(() => resolve(true), ms))).catch(() => false);

  // A sitting is kept by the hash of its payment, which is lower case.
  const keeps = (sitting: string) => [...unopened.values()].some((paidFor) => paidFor.id === sitting.toLowerCase());

  /**
   * Stops keeping a paid sitting once BrainChain reads it as open, closed or unpaid. One that opened is read by its
   * id from then on and its payment stays counted; one whose payment did not settle was never charged, so its
   * amount goes back to the budget and the daily limit.
   */
  async function letGo(sitting: string, charged: boolean): Promise<void> {
    for (const [key, paidFor] of unopened) {
      if (paidFor.id !== sitting.toLowerCase()) continue;
      unopened.delete(key);
      if (!charged) await unreserve(paidFor);
    }
  }

  /**
   * A sitting the desk holds a payment for and has not opened, as it reads to an agent: where its payment stands
   * and how its briefs are read. Through the paid route only the request that paid for it reads them: kept here,
   * that request is sent again; otherwise the wallet's signature reads them once the sitting is open.
   */
  function notOpen(sitting: string, view: Record<string, unknown>): Record<string, unknown> {
    const named = { sitting, statusUrl: `${config.desk}/exams/${sitting}`, state: view.state, ...(typeof view.payment === "string" ? { payment: view.payment } : {}) };
    if (view.state === "unpaid") return { ...named, done: true, next: "The payment for this sitting did not settle, so nothing was charged and no sitting opens from it. brainchain_sit_exam opens a new one." };
    const reason = typeof view.reason === "string" && view.reason.trim() ? view.reason.trim() : undefined;
    const how = keeps(sitting)
      ? askAgain
      : "This server no longer holds the payment that bought the sitting, so it cannot fetch the briefs with it. Once the sitting is open, brainchain_exam_status with briefs: true reads them, signed by the wallet that sits it.";
    const stands = view.state === "paying" ? "The desk is settling this sitting's payment, and BrainChain opens the sitting once it has." : "The sitting is paid for, and BrainChain is opening it.";
    return { ...named, ...(reason ? { reason } : {}), done: false, next: `${stands}${reason ? ` It is not open yet for this reason: ${sentence(reason)}` : ""} ${how}`, retryAfterSeconds: 30 };
  }

  /** The sitting a refusal names: the one the agent already has, open or paid for and still to open. */
  const namedSitting = (status: number, reply: Record<string, unknown>) => (status === 409 && typeof reply.sitting === "string" && /^0x[0-9a-fA-F]{64}$/.test(reply.sitting) ? reply.sitting.toLowerCase() : undefined);

  /**
   * What a refusal that names a sitting comes to. One that is open and that this wallet sits is returned with its
   * briefs, which the wallet's signature reads; one that is paid for and not open yet says where it stands. A
   * sitting this wallet cannot read leaves BrainChain's refusal, with the sitting's id when its words lack it.
   */
  async function agentsSitting(sitting: string, said: string): Promise<unknown> {
    const read = (await examStatus(sitting, true).catch(() => undefined)) as Record<string, unknown> | undefined;
    if (read && Array.isArray(read.briefs)) return { ...read, duplicate: true };
    if (read && beforeOpening(read) && read.state !== "unpaid") return read;
    throw new Error(said.toLowerCase().includes(sitting) ? said : `${sentence(said)} The sitting is ${sitting}, and brainchain_exam_status reads where it stands.`);
  }

  /**
   * Reads what the desk answered a paid sitting with, and while it says the items are still to be drawn, asks
   * again until `signal` aborts. A refusal that charged nothing gives the amount back and is thrown in the desk's
   * own words; any other answer keeps the sitting, so the next call for the same agent and class asks for it again.
   */
  async function follow(key: string, sitting: Unopened, first: Response | Error, signal: AbortSignal): Promise<unknown> {
    unopened.set(key, sitting);
    const price = `${formatMoney(sitting.hold?.amount ?? 0n)} ${config.token}`;
    // A sitting is named only as the desk names it: a payment it has not answered for may have bought nothing to read.
    const named = (id: unknown) => (typeof id === "string" && /^0x[0-9a-fA-F]{64}$/.test(id) ? { sitting: id.toLowerCase(), statusUrl: `${config.desk}/exams/${id.toLowerCase()}` } : {});
    const uncharged = async (why: string): Promise<never> => {
      unopened.delete(key);
      await unreserve(sitting);
      throw new Error(why);
    };
    let waiting: Record<string, unknown> | undefined;
    for (let answer = first; ; answer = await ask(sitting, signal)) {
      if (answer instanceof Error) {
        return waiting ?? { price, possiblyCharged: true, done: false, error: `The desk did not confirm the sitting (${firstLine(answer)}). The payment may have gone through. ${askAgain}`, retryAfterSeconds: 30 };
      }
      const reply = (await until(signal, jsonObject(answer)).catch(() => undefined)) ?? {};
      if (answer.ok && Array.isArray(reply.briefs)) {
        unopened.delete(key);
        // The desk answers a payment it already holds under another id with the sitting that one bought, and cancels this one.
        const given = named(reply.sitting);
        const cancelled = given.sitting !== undefined && given.sitting !== sitting.id;
        if (cancelled) await unreserve(sitting);
        return { ...reply, ...given, price: cancelled ? `${formatMoney(0n)} ${config.token}` : price, ...(cancelled ? { duplicate: true } : {}), ...sittingGuidance(reply) };
      }
      const said = typeof reply.error === "string" ? reply.error.trim() : "";
      if (/Nothing was charged/.test(said)) {
        const earlier = namedSitting(answer.status, reply);
        if (earlier === undefined) return uncharged(said);
        // The agent already has a sitting, so this payment was turned away uncharged: that sitting is the one to read.
        unopened.delete(key);
        await unreserve(sitting);
        return agentsSitting(earlier, said);
      }
      if (answer.status === 402 || answer.status === 412) return uncharged(await explainRefusal("exam", refusalCode(answer.status, reply), sitting.hold?.amount ?? 0n, sitting.permit2));
      if (refusedBeforeSettling(answer.status)) return uncharged(said ? `${sentence(said)} Nothing was charged.` : `The desk answered ${answer.status}. Nothing was charged.`);
      const reason = said ? ` (${said.replace(/[.!?]+$/, "")})` : "";
      // A 409 that names the sitting is the desk still taking the payment. One that names none means the desk will not
      // take this payment again, so it is dropped; whether its authorization was spent elsewhere is unknown, so it stays counted.
      if (answer.status === 409 && typeof reply.sitting !== "string") {
        unopened.delete(key);
        throw new Error(`The desk will not take that payment again, and BrainChain holds no sitting for it${reason}. Call brainchain_sit_exam again to pay for a new sitting.`);
      }
      if (answer.status !== 202 && answer.status !== 502 && answer.status !== 409) {
        return { ...named(reply.sitting), price, possiblyCharged: true, done: false, error: `The desk answered ${answer.status}${reason}. The payment may have gone through. ${askAgain}`, retryAfterSeconds: 60 };
      }
      const told = said || (typeof reply.message === "string" && reply.message.trim()) || "BrainChain has not opened the sitting yet.";
      waiting = {
        ...named(reply.sitting),
        price,
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
   * Pays for a sitting at the price the desk states, and at no other, when that is no more than the price the agent
   * was shown. The default limit per payment can be under that price, so for this one payment the limit is the price
   * itself. A limit the operator set still holds, as do the budget and the daily limit: a price above any of them is
   * refused before anything is signed.
   */
  async function openSitting(key: string, request: SittingRequest): Promise<unknown> {
    const wallet = account();
    const { price, refused } = await quote("exam");
    if (price === undefined) {
      if (refused) throw new Error(`The desk asked to be paid on terms this server does not accept: ${refused} Nothing was charged.`);
      if ((await read(`${config.desk}/exams`).catch(() => null)) === undefined) throw new Error(NOT_OPEN);
      throw new Error(`The desk at ${config.desk} gave no price for a sitting on ${config.chain}, so nothing was signed. It may be out of reach, or the exam may not be open on this network; brainchain_exam_info shows which. Nothing was charged.`);
    }
    // `price` is given in base units, so amounts are said in the token and in base units.
    const amount = (units: bigint) => `${formatMoney(units)} ${config.token} (${units} base units)`;
    if (price > request.price) {
      throw new Error(
        `A sitting costs ${amount(price)}, more than the ${amount(request.price)} passed as price, so nothing was signed. To pay the new price, call brainchain_sit_exam again with price "${price}". Nothing was charged.`,
      );
    }
    const over = (what: string, setting: string) =>
      `A sitting costs ${formatMoney(price)} ${config.token}, more than ${what} (${setting}). Ask your operator to raise ${setting} and restart the server. Nothing was charged.`;
    if (config.maxPriceSet && price > config.maxPrice) throw new Error(over(`the ${formatMoney(config.maxPrice)} ${config.token} this server may pay at once`, "BRAINCHAIN_MAX_PRICE_UNITS"));
    if (price > config.budget) throw new Error(over(`this server's budget of ${formatMoney(config.budget)} ${config.token} per run`, "BRAINCHAIN_BUDGET_UNITS"));
    if (config.daily !== undefined && price > config.daily) throw new Error(over(`this wallet's daily limit of ${formatMoney(config.daily)} ${config.token}`, "BRAINCHAIN_DAILY_UNITS"));

    const agent = { chainId: config.identityChainId, id: request.agentId };
    const at = Math.floor(Date.now() / 1000);
    const signature = await wallet.signMessage({ message: sittingMessage(config.brainchainId, agent, request.class, at) });
    const body = JSON.stringify({ agent, class: request.class, wallet: wallet.address, at, signature });
    const payment: Payment = {};
    const limit = timeLimit();
    try {
      const answer = await payingFetch(payment, price, limit.signal, true)(route.exam, { method: "POST", headers: { "content-type": "application/json" }, body }).catch(failure);
      if (payment.signed && payment.header) return await follow(key, { id: orderIdOf(payment.signed), body, header: payment.header, hold: payment.hold, permit2: payment.permit2 }, answer, limit.signal);
      // No payment was signed, so nothing can have been charged. This is BrainChain turning the request away before
      // the desk asked for payment, such as a wallet that does not hold the id, and its reason is passed on.
      await unreserve(payment);
      if (answer instanceof Error) throw new Error(await explainUnsigned("exam", answer, payment.refused));
      const reply = (await until(limit.signal, jsonObject(answer)).catch(() => undefined)) ?? {};
      if (answer.ok) throw new Error(`The desk at ${config.desk} answered ${answer.status} without asking for payment, so no sitting was opened. Check BRAINCHAIN_DESK_URL. Nothing was charged.`);
      const said = typeof reply.error === "string" ? reply.error.trim() : "";
      // The desk looks at only so many unpaid sitting requests from one address in a minute, and says so in place of a price.
      if (answer.status === 429) {
        return {
          error: "The desk has had too many sitting requests from this address in the last minute, so it did not look at this one. Nothing was signed or charged.",
          done: false,
          next: "Call brainchain_sit_exam again after retryAfterSeconds.",
          retryAfterSeconds: retryAfter(answer) ?? 60,
        };
      }
      const earlier = /Nothing was charged/.test(said) ? namedSitting(answer.status, reply) : undefined;
      if (earlier !== undefined) return await agentsSitting(earlier, said);
      throw new Error(/Nothing was charged/.test(said) ? said : said ? `${sentence(said)} Nothing was charged.` : `The desk answered ${answer.status}. Nothing was charged.`);
    } finally {
      limit.clear();
    }
  }

  /**
   * A sitting paid for and not yet opened is asked for again in place of a new one; an identical call otherwise
   * returns the first sitting, as an identical post does. The price is no part of what makes a call identical: one
   * agent sits one class at a time.
   */
  function sit(request: SittingRequest): Promise<unknown> {
    const now = Date.now();
    for (const [key, entry] of recent) if (now - entry.at >= REPOST_AFTER_MINUTES * 60_000) recent.delete(key);
    const key = canonicalStringify({ kind: "exam", network: config.network, agentId: request.agentId, class: request.class });
    const waiting = unopened.get(key);
    if (!waiting) return once(key, now, () => openSitting(key, request), "exam");
    const limit = timeLimit();
    return (
      ask(waiting, limit.signal)
        .then((answer) => follow(key, waiting, answer, limit.signal))
        .finally(limit.clear)
        // A kept sitting that has passed or failed since is returned as it ended, and nothing new is paid for in this
        // call, nor for a void one, whose payment is owed back; the next call pays for a new sitting.
        .then((reply) => (closedSince(reply) ? closed(reply as Record<string, unknown>) : reply))
    );
  }

  /** The desk's 404 for a path it has no route for, told apart from a 404 that gives a reason, such as an unknown agent. */
  const NO_ROUTE = "Not found.";

  /**
   * One free read of the desk as JSON; undefined for what the desk does not have. With `said`, a 404 a route gives
   * its own reason for, such as an agent id no one controls, is thrown in the desk's words.
   */
  async function read(url: string, said = false): Promise<Record<string, unknown> | undefined> {
    let response: Response;
    try {
      response = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
    } catch (error) {
      throw new Error(`Could not reach BrainChain at ${config.desk} (${firstLine(error)}). Try again in a minute.`);
    }
    const view = await jsonObject(response);
    if (response.status === 404) {
      const reason = typeof view?.error === "string" ? view.error.trim() : "";
      if (said && reason && reason !== NO_ROUTE) throw new Unknown(reason);
      return undefined;
    }
    if (response.status >= 500 || RETRY_LATER.has(response.status)) throw new Busy(`BrainChain answered ${response.status}: it is busy or briefly unavailable.`, retryAfter(response) ?? 60);
    if (!response.ok) throw new Error(typeof view?.error === "string" ? view.error : `BrainChain answered ${response.status}.`);
    if (!view) throw new Error("BrainChain's reply could not be read. Try again shortly.");
    return view;
  }

  async function examInfo(): Promise<unknown> {
    const [view, price] = await Promise.all([read(`${config.desk}/exams`), quotedPrice("exam")]);
    if (!view) throw new Error(NOT_OPEN);
    const pool = view.pool as { inUse?: unknown } | undefined;
    // BrainChain lists each item in use by its hash, which tells an agent nothing, so only the count is kept.
    const counted = Array.isArray(pool?.inUse) ? { ...view, pool: { ...pool, inUse: pool.inUse.length } } : view;
    // The price in base units on the chain this server pays on, read from the desk's offer: what brainchain_sit_exam takes as price.
    return price === undefined ? counted : { ...counted, priceUnits: price.toString() };
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
      return unconfirmed(`BrainChain did not confirm the delivery (${firstLine(error)}).`);
    }
    const reply = (await jsonObject(response)) ?? {};
    if (response.ok) return { ...reply, next: "Delivered, and BrainChain judges it next. Read the outcome with brainchain_exam_status." };
    const said = typeof reply.error === "string" ? reply.error.trim() : "";
    // A 5xx can come after the work was stored, whatever it says.
    if (response.status >= 500) return unconfirmed(said ? `BrainChain answered ${response.status} (${said.replace(/[.!?]+$/, "")}).` : `BrainChain answered ${response.status}.`);
    throw new Error(said || `BrainChain answered ${response.status}.`);
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
      return { sitting, error: `Could not reach BrainChain at ${config.desk} (${firstLine(error)}).`, done: false, next: "Read the sitting again after retryAfterSeconds.", retryAfterSeconds: 30 };
    }
    const view = await jsonObject(response);
    // BrainChain knows a sitting from the moment the desk holds its payment, and this server only passes on ids BrainChain gave.
    if (response.status === 404) throw new Error("BrainChain has no sitting with this id. Check the id: it must be one that brainchain_sit_exam returned.");
    if (response.status >= 500 || RETRY_LATER.has(response.status)) {
      return { sitting, error: `BrainChain answered ${response.status}.`, done: false, next: "BrainChain is busy or briefly unavailable. Read the sitting again after retryAfterSeconds.", retryAfterSeconds: retryAfter(response) ?? 30 };
    }
    // Before a sitting opens, both its address and its briefs address say where its payment stands, the briefs address with a 409.
    if (view && beforeOpening(view) && (response.ok || response.status === 409)) {
      if (view.state === "unpaid") await letGo(sitting, false);
      return notOpen(sitting, view);
    }
    if (!response.ok) throw new Error(typeof view?.error === "string" ? view.error : `BrainChain answered ${response.status}.`);
    if (!view) return { sitting, error: "BrainChain's reply could not be read.", done: false, next: "Read the sitting again shortly.", retryAfterSeconds: 30 };
    // An open or closed sitting is read by its id from here on, so its payment header is not sent again.
    await letGo(sitting, true);
    return { ...view, ...sittingGuidance(view) };
  }

  async function licences(agentId: string): Promise<unknown> {
    let view: Record<string, unknown> | undefined;
    try {
      view = await read(`${config.desk}/licences/${config.identityChainId}/${agentId}`, true);
    } catch (error) {
      if (error instanceof Busy) return { agent: { chainId: config.identityChainId, id: agentId }, error: error.message, done: false, next: "Read the licences again after retryAfterSeconds.", retryAfterSeconds: error.retryAfterSeconds };
      throw error;
    }
    if (!view) throw new Error("The licence exam is not open yet, so there are no licences to list.");
    const held = Array.isArray(view.licences) ? (view.licences as { class?: unknown; state?: unknown }[]) : [];
    if (held.length === 0) return { ...view, next: `Agent ${agentId} holds no licence. brainchain_exam_info says what a sitting takes, and brainchain_sit_exam opens one.` };
    // Each licence keeps BrainChain's `reason` as given. A lapsed one is no use to whoever holds the id now, who may earn its own.
    const lapsed = held.flatMap((licence) => (licence.state === "lapsed" && typeof licence.class === "string" ? [licence.class] : []));
    if (lapsed.length === 0) return view;
    return {
      ...view,
      next: `Agent ${agentId}'s ${lapsed.join(" and ")} licence has lapsed: the id now has another owner or build than the licence was earned under. The id's current holder may sit for a licence of its own with brainchain_sit_exam.`,
    };
  }

  /**
   * The head and first entries of an agent's numbered record, and what its Agent Papers say of its epoch, licences and
   * ceiling. The two are read separately, so if one cannot be read just now the other still comes back, with the reason in its place.
   */
  async function agentRecord(agentId: string): Promise<unknown> {
    const recordUrl = `${config.desk}/agents/${config.identityChainId}/${agentId}/record`;
    const papersUrl = `${config.desk}/papers/${config.identityChainId}/${agentId}`;
    const [record, file] = await Promise.allSettled([read(`${recordUrl}?from=1&limit=${RECORD_PAGE}`), read(papersUrl, true)]);
    const unread = (url: string, reason: unknown) => ({ url, error: firstLine(reason), ...(reason instanceof Busy ? { retryAfterSeconds: reason.retryAfterSeconds } : {}) });
    if (record.status === "rejected" && file.status === "rejected") {
      if (!(record.reason instanceof Busy)) throw record.reason;
      return { agent: { chainId: config.identityChainId, id: agentId }, error: record.reason.message, done: false, next: "Read the record again after retryAfterSeconds.", retryAfterSeconds: record.reason.retryAfterSeconds };
    }
    const entries = record.status === "fulfilled" ? record.value : undefined;
    const papers = file.status === "fulfilled" ? (file.value?.brainchain as { papers?: Record<string, unknown> } | undefined)?.papers : undefined;
    if (record.status === "fulfilled" && !entries && file.status === "fulfilled" && !file.value) {
      throw new Error(`BrainChain has no record and no Agent Papers for agent ${agentId} on chain ${config.identityChainId}. Check the id.`);
    }
    // No record, and BrainChain says why it has no Agent Papers either: an id it knows nothing of, with nothing to verify.
    if (record.status === "fulfilled" && !entries && file.status === "rejected" && file.reason instanceof Unknown) throw file.reason;
    return {
      agent: { chainId: config.identityChainId, id: agentId },
      record:
        record.status === "rejected"
          ? unread(recordUrl, record.reason)
          : entries
            ? { url: recordUrl, head: entries.head, entries: entries.entries, ...(typeof entries.next === "string" ? { more: `${config.desk}${entries.next}` } : {}) }
            : { url: recordUrl, entries: [], note: "BrainChain has no entry on record for this agent." },
      papers:
        file.status === "rejected"
          ? unread(papersUrl, file.reason)
          : papers
            ? { url: papersUrl, signedAt: papers.at, epoch: papers.epoch, licences: papers.licences, ...(papers.ceiling === undefined ? {} : { ceiling: papers.ceiling, ...atOnce(papers.ceiling) }) }
            : { url: papersUrl, note: "BrainChain serves no Agent Papers for this agent." },
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
      if (at === undefined) throw new NoGrade("The desk has no grade with this id. Check the id: it must be one that brainchain_grade returned.");
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
      throw new NoGrade(`The desk has no grade with this id. This server sent it more than ${REPOST_AFTER_MINUTES} minutes ago, so it was never charged, and it can be sent again.`);
    }
    if (response.status >= 500 || RETRY_LATER.has(response.status)) {
      return { grade: id, error: `The desk answered ${response.status}.`, done: false, next: "The desk is busy or briefly unavailable. Read the grade again after retryAfterSeconds.", retryAfterSeconds: retryAfter(response) ?? 30 };
    }
    if (!response.ok) throw new Error(typeof view?.error === "string" ? view.error : `The desk answered ${response.status}.`);
    if (!view) return { grade: id, error: "The desk's reply could not be read.", done: false, next: "Read the grade again shortly.", retryAfterSeconds: 30 };
    if (view.state === "failed") await release("grade", id);
    return { ...view, ...gradeGuidance(view) };
  }

  /** A grade paid for this server from elsewhere, such as BrainChain's free checks, read back like one it paid itself. */
  function track(id: string): void {
    paid.set(keyed("grade", id), { at: Date.now(), forget: () => {} });
  }

  return { post, get, grade, getGrade, track, examInfo, sit, submitExam, examStatus, licences, agentRecord, spent: () => limits.spent() };
}

/** A payment the wallet's own limits or the desk turned down, so nothing was charged and sending it again changes nothing yet. */
export class PaymentRefused extends Error {}

/** The desk has no record of a grade. */
export class NoGrade extends Error {}

/** What this server pays the desk for. A task and a grade are read back at a route of their own; a sitting is asked for again with its payment. */
type Kind = "task" | "grade" | "exam";
type Posted = Exclude<Kind, "exam">;

/**
 * Whether the desk is speaking of a sitting it has a payment for and has not opened: `paying` while the payment
 * settles, `opening` once it is paid, `unpaid` when the payment did not settle.
 */
const beforeOpening = (view: Record<string, unknown>) => view.state === "paying" || view.state === "opening" || view.state === "unpaid";

/**
 * Whether the desk turned a paid request away before settling anything, so nothing was charged. Every 4xx is that: a
 * request it cannot read, a brief too large, or a payment it will not take, such as one Permit2 may not move yet
 * (412). Two are not: a 408 comes from a proxy, possibly after the desk took the payment, and a 409 can be a payment
 * the desk is still taking. Any other answer to a signed payment may have charged it.
 */
const refusedBeforeSettling = (status: number) => status >= 400 && status < 500 && status !== 408 && status !== 409;

/** The desk's code for a refused payment; a 412 is x402's answer to a payment Permit2 may not move yet, whatever its body says. */
const refusalCode = (status: number, reply: Record<string, unknown>) => (typeof reply.error === "string" && reply.error.trim() ? reply.error : status === 412 ? "permit2_allowance_required" : undefined);

/** Whether the desk answered a sitting's payment with the sitting as it ended, with a pass or a fail. */
function closedSince(reply: unknown): boolean {
  const { state, briefs } = reply as Record<string, unknown>;
  return Array.isArray(briefs) && (state === "passed" || state === "failed");
}

/** A kept sitting that ended before this call, as this call returns it: done, with nothing new paid for. */
function closed(reply: Record<string, unknown>): Record<string, unknown> {
  const outcome = typeof reply.next === "string" ? ` ${reply.next}` : "";
  return { ...reply, done: true, next: `The sitting this server paid for earlier has ended, so this call paid for nothing new.${outcome}` };
}

const NOT_OPEN = "The licence exam is not open yet, so there is nothing to sit or pay for. Nothing was signed or charged.";

/** The ceiling in words, from its amount in base units of USDG. */
function atOnce(ceiling: unknown): { holdsAtOnce?: string } {
  const units = (ceiling as { units?: unknown } | null)?.units;
  return typeof units === "string" && /^\d+$/.test(units) ? { holdsAtOnce: `up to ${formatMoney(BigInt(units))} USDG of paid work at once` } : {};
}

/** A 404 BrainChain gave its own reason for, such as an agent id no single account controls. */
class Unknown extends Error {}

/** A read BrainChain answered with "not now", and how long it asked to wait. */
class Busy extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds: number,
  ) {
    super(message);
  }
}

interface Offer {
  network?: string;
  asset?: string;
  payTo?: string;
  amount?: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
}

/** An offer paid by transfer authorization, which needs no approval, before one through Permit2. */
function byAuthorization<T extends { extra?: Record<string, unknown> }>(offers: readonly T[]): T | undefined {
  return offers.find((offer) => offer.extra?.assetTransferMethod !== "permit2") ?? offers[0];
}

/** The headers an x402 payment travels in: version 2's, and version 1's. */
const PAYMENT_HEADERS = ["payment-signature", "x-payment"];

/** One payment as it goes: what it holds against the limits, what was signed, and the header it left in. */
interface Payment {
  hold?: Hold;
  signed?: { payload: unknown };
  header?: [string, string];
  /** Why every term the desk offered was turned down, when all were. */
  refused?: string;
  /** Whether the offer taken moves the token through Permit2, which needs an approval first. */
  permit2?: boolean;
}

/** A paid sitting the desk has still to open: its id, the request and the payment header as they were sent, and what it holds against the limits. */
interface Unopened {
  id: string;
  body: string;
  header: [string, string];
  hold?: Hold;
  permit2?: boolean;
}

const percent = (p: number) => `${Math.round(p * 100)}%`;
const fields = (value: unknown): Record<string, unknown> => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/**
 * Why the pass probability is below what `levels` shows, from the desk's rule: it is the lower of the panel's two graders,
 * and zero when the result failed checks the brief carries. The reply carries no reasons, so only those two are said.
 */
function basis(view: Record<string, unknown>, pass: number): string {
  const levels = Array.isArray(view.levels) ? view.levels.map(fields) : [];
  if (!levels.some((level) => level.passes === true)) return "";
  const own = levels.reduce((sum, level) => sum + (level.passes === true && typeof level.probability === "number" ? level.probability : 0), 0);
  const second = fields(view.second);
  const other = typeof second.passProbability === "number" ? second.passProbability : undefined;
  const near = (a: number, b: number) => Math.abs(a - b) < 0.005;
  if (near(pass, own)) return "";
  const named = typeof second.model === "string" ? ` (${second.model})` : "";
  if (other !== undefined && near(pass, other)) return ` Jev put ${percent(own)} on a passing level, as levels shows. The second grader${named} put ${percent(other)}, and the lower of the two counts.`;
  if (pass === 0 && Math.min(own, other ?? own) >= 0.005) {
    return ` Jev put ${percent(own)} on a passing level${other === undefined ? "" : ` and the second grader${named} ${percent(other)}`}, but the result failed the checks in the brief, which counts as 0%.`;
  }
  return "";
}

/** What a grade's state means for the caller. */
export function gradeGuidance(view: Record<string, unknown>): Guidance {
  if (view.state === "graded") {
    const pass = typeof view.passProbability === "number" ? view.passProbability : undefined;
    const at = pass === undefined ? "" : ` at ${percent(pass)}`;
    const why = pass === undefined ? "" : basis(view, pass);
    // The desk links a page for the record on mainnet only; `record`, the record's own file, is always there.
    const decision = fields(view.decision);
    const field = ["page", "record"].find((name) => typeof decision[name] === "string");
    const record = field ? ` The record is at decision.${field}.` : "";
    return { done: true, next: `${view.accepted === true ? `BrainChain accepts the work${at}.` : `BrainChain does not accept the work${at}.`}${why}${record}` };
  }
  if (view.state === "failed") return { done: true, next: "The payment did not go through, so nothing was charged and the work was not graded. Send it again with brainchain_grade." };
  if (view.state === "unconfirmed") return { done: false, next: "The desk is confirming the payment on chain. Read the grade with brainchain_get_grade after retryAfterSeconds; do not send it again.", retryAfterSeconds: 30 };
  return { done: false, next: "BrainChain is still grading the work. Read the grade with brainchain_get_grade after retryAfterSeconds; reading it is free.", retryAfterSeconds: 20 };
}

export interface Guidance {
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
  const paid = (): Guidance => ({ done: true, next: `${task.accepted === true ? "BrainChain accepted the work and the model was paid" : "The model was paid"}.${result}` });
  // Not done: the caller is owed a refund transaction, and the model can still dispute.
  // The caller hears the verdict now and comes back once, when the window has closed.
  const rejected = (): Guidance => {
    const start = "BrainChain did not accept the work, so the result is withheld.";
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
      return wait(600, `The grade is disputed; BrainChain rules on it${by}. If no ruling comes, the grade stands.${result}`);
    case "ruled":
      return wait(900, `BrainChain ruled on the dispute. The ruling settles when its appeal window closes${due ? ` at ${due}` : ""}, unless the side it went against appeals.${result}`);
    case "appealed":
      return wait(600, `The ruling was appealed; BrainChain rules again${by}. If no second ruling comes, the first one stands.${result}`);
    case "graded":
      if (task.accepted === true) {
        // The caller has what it paid for, and on a desk task only the model could still dispute, against its own payment.
        if (result) return { done: true, next: `BrainChain accepted the work.${result} The payment becomes final when the dispute window closes, ${config.terms.finalAfter} after grading.` };
        return wait(60, typeof view.resultError === "string" ? "BrainChain accepted the work, but the result could not be read just now." : "BrainChain accepted the work; the result is being prepared.");
      }
      if (task.accepted === false) return rejected();
      return wait(60, "BrainChain graded the work; the verdict is being recorded.");
    case "open":
      return wait(60, `Waiting for BrainChain to hire a model.${unless("no model is hired")}`);
    case "hired":
      return wait(60, `A model is working on the task.${unless("the work is not delivered")}`);
    case "delivered":
    case "submitted":
      return wait(30, `The model delivered; BrainChain is grading the work.${unless("it is not graded")}`);
  }
  // The order can read posted a moment before the task's status reaches it.
  if (view.state === "posted" && task.status === undefined) return wait(20, "The task is posted; its status shows here shortly.");
  return wait(60, "The order is in progress.");
}
