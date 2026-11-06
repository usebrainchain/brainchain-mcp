import type { ClientEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { keccak256, toBytes } from "viem";

import { formatUnits, MAX_TIMEOUT_SECONDS, REPOST_AFTER_MINUTES, type Config } from "./config.js";
import { createLimits, type Hold, type Limits } from "./limits.js";
import type { TaskRequest, Desk } from "./tools.js";

const BUDGET_REASON = "budget";
const DAILY_REASON = "daily limit";
const RESULT_LIMIT = 20_000;

/** What a refused budget or daily limit tells a person, for a post and for a bond alike. */
export async function limitReached(config: Config, limits: Limits, which: "budget" | "daily limit", verb = "signed payments for"): Promise<string> {
  if (which === "budget") {
    return `This server has already ${verb} ${formatUnits(limits.spent())} of its ${formatUnits(config.budget)} ${config.token} budget. The budget resets when the server restarts; raise BRAINCHAIN_BUDGET_UNITS to allow more per run. Nothing was charged.`;
  }
  const today = await limits.spentToday();
  // One limit covers both chains, so it is named without a token.
  return `This wallet has already ${verb} ${today === undefined ? "most" : formatUnits(today)} of its daily limit of ${formatUnits(config.daily!)}, counting USDG and USDC together. The limit resets at 00:00 UTC; raise BRAINCHAIN_DAILY_UNITS to allow more. Nothing was charged.`;
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

export interface DeskOptions {
  config: Config;
  /** A function is called when a payment is about to be signed, so a desk can exist before its key does. */
  signer: ClientEvmSigner | (() => ClientEvmSigner);
  /** The command a person runs to approve Permit2, for refusal messages. */
  approveCommand: string;
  fetch?: typeof fetch;
  /** Reads the paying wallet's balance and, for USDG, its Permit2 allowance, to explain a refused payment. */
  funds?: () => Promise<Funds>;
  postTimeoutMs?: number;
  /** The budget and daily limit, shared with whatever else spends from the wallet; made here when absent. */
  limits?: Limits;
}

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export const firstLine = (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";
/** Text from the desk or a library, ended as a sentence so what this server adds after it reads apart. */
const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);
/** Statuses that say "not now" rather than "no", alongside every 5xx. */
const RETRY_LATER = new Set([408, 425, 429]);

/** Settles as `work` does, or rejects once `signal` aborts. */
function until<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  return Promise.race([work, new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))]);
}

/** Retry-After in seconds, from either form the header takes. */
function retryAfter(response: Response): number | undefined {
  const header = response.headers.get("retry-after")?.trim();
  if (!header) return undefined;
  const seconds = /^\d+$/.test(header) ? Number(header) : Math.ceil((Date.parse(header) - Date.now()) / 1000);
  return Number.isFinite(seconds) ? Math.max(1, seconds) : undefined;
}

async function jsonObject(response: Response): Promise<Record<string, unknown> | undefined> {
  const value: unknown = await response.json().catch(() => undefined);
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function createDesk(options: DeskOptions): Desk & { spent(): bigint } {
  const { config, signer, approveCommand } = options;
  const fetchImpl = options.fetch ?? fetch;
  const account = () => (typeof signer === "function" ? signer() : signer);
  const limits = options.limits ?? createLimits(config, account);
  const endpoint = `${config.desk}/x402/tasks`;
  const recent = new Map<string, { at: number; reply: Promise<unknown> }>();
  /** When this process paid, or may have paid, for each order, and how to forget its post; the desk can take minutes to know one. */
  const paid = new Map<string, { at: number; forget: () => void }>();
  /** What each of those orders still holds against the budget and the daily limit. */
  const held = new Map<string, Hold>();

  /** The desk's price, read from a fresh 402 challenge. */
  async function quotedPrice(signal = AbortSignal.timeout(15_000)): Promise<bigint | undefined> {
    try {
      const probe = await fetchImpl(endpoint, {
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

  /** Turns an x402 client error, raised before anything was signed, into a step a person or model can act on. */
  async function explainUnsigned(error: unknown): Promise<string> {
    const message = firstLine(error);
    if (message.includes(`Payment creation aborted: ${BUDGET_REASON}`)) return await limitReached(config, limits, "budget");
    if (message.includes(`Payment creation aborted: ${DAILY_REASON}`)) return await limitReached(config, limits, "daily limit");
    if (/rejected by spendControls/.test(message)) {
      const price = await quotedPrice();
      if (price !== undefined && price > config.maxPrice) {
        return `The desk asks ${formatUnits(price)} ${config.token} per task, above this server's limit of ${formatUnits(config.maxPrice)} ${config.token}. Raise BRAINCHAIN_MAX_PRICE_UNITS and restart the server to allow it. Nothing was charged.`;
      }
      return `The desk asked for a payment outside this server's limits (${config.token} at ${config.asset}, at most ${formatUnits(config.maxPrice)} per task). Check BRAINCHAIN_PAY_ON and BRAINCHAIN_PAYMENT_ASSET. Nothing was charged.`;
    }
    if (/filtered out by policies/.test(message)) {
      return `The desk asked to be paid on terms this server does not accept: the payee must be ${config.payTo} and the authorization may last at most ${MAX_TIMEOUT_SECONDS} seconds. Check BRAINCHAIN_NETWORK and BRAINCHAIN_PAY_ON, or set BRAINCHAIN_PAY_TO for a custom BRAINCHAIN_DESK_URL. Nothing was charged.`;
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

  /** Explains a payment the desk refused, from the wallet's balance and Permit2 allowance where possible. */
  async function explainRefusal(reason: unknown): Promise<string> {
    const fallback =
      typeof reason === "string" && reason.trim() ? `The desk refused the payment: ${sentence(reason)} Nothing was charged.` : "The desk refused the payment. Nothing was charged.";
    if (!options.funds) return fallback;
    try {
      // One deadline for both reads, so a slow chain cannot hold the reply.
      const deadline = AbortSignal.timeout(10_000);
      const [{ balance, allowance }, quoted] = await until(deadline, Promise.all([options.funds(), quotedPrice(deadline)]));
      const needed = quoted ?? config.maxPrice;
      if (balance < needed) {
        const { address } = account();
        return `The paying wallet holds ${formatUnits(balance)} ${config.token} on ${config.chain}; a task costs ${formatUnits(needed)}. Nothing was charged. Send at least ${formatUnits(needed - balance)} ${config.token} to ${address} on ${config.chain}, then post again.`;
      }
      if (config.permit2 && allowance !== undefined && allowance < needed) {
        return `Permit2 is not yet approved to spend this wallet's ${config.token}. Run \`${approveCommand}\` once with the same BRAINCHAIN_PAYER_KEY; it needs a little ETH on ${config.chain}. Nothing was charged.`;
      }
    } catch {
      // The chain read failed or ran out of time; the desk's own reason is the best explanation left.
    }
    return fallback;
  }

  function possiblyCharged(receipt: Record<string, unknown>, cause: string): Record<string, unknown> {
    return {
      ...receipt,
      possiblyCharged: true,
      error: `${cause} The payment may have gone through. Read this order with brainchain_get_task; do not post the task again.`,
    };
  }

  /**
   * The desk answers 402 for a payment it refuses, and for a settlement it could not
   * confirm, which it keeps as an order and checks against the chain. Says why such a
   * payment may still be charged, or undefined when the desk has no order or gave it up.
   */
  async function stillOpen(order: string): Promise<string | undefined> {
    let response: Response;
    try {
      response = await fetchImpl(`${endpoint}/${order}`, { signal: AbortSignal.timeout(10_000) });
    } catch {
      return "the order could not be read";
    }
    if (response.status === 404) return undefined;
    const view = response.ok ? await jsonObject(response) : undefined;
    if (typeof view?.state !== "string") return "the order could not be read";
    return view.state === "failed" ? undefined : `it holds the order as ${view.state}`;
  }

  /** A payment the desk gave up was never charged, so its task can be posted again at once and its amount spent on another. */
  async function release(order: string): Promise<void> {
    paid.get(order)?.forget();
    const hold = held.get(order);
    held.delete(order);
    if (hold) await limits.give(hold);
  }

  /** An agent that retries a post it gave up waiting on gets the first order back instead of paying twice. */
  function post(task: TaskRequest): Promise<unknown> {
    const now = Date.now();
    for (const [key, entry] of recent) if (now - entry.at >= REPOST_AFTER_MINUTES * 60_000) recent.delete(key);
    const key = canonicalStringify({ network: config.network, title: task.title, brief: task.brief, levels: task.levels });
    const previous = recent.get(key);
    if (previous) return previous.reply.then((reply) => ({ ...(reply as object), duplicate: true }));

    const entry = { at: now, reply: pay(task) };
    recent.set(key, entry);
    const forget = () => {
      if (recent.get(key) === entry) recent.delete(key);
    };
    entry.reply.then((reply) => {
      const { order } = reply as { order?: unknown };
      if (typeof order === "string") paid.set(order.toLowerCase(), { at: now, forget });
      else forget();
    }, forget);
    return entry.reply;
  }

  async function pay(task: TaskRequest): Promise<unknown> {
    let signed: { payload: unknown } | undefined;
    let hold: Hold | undefined;
    const unreserve = async () => {
      if (hold) await limits.give(hold);
      hold = undefined;
    };
    const receipt = (order: string) => {
      if (hold) held.set(order.toLowerCase(), hold);
      return { order, price: `${formatUnits(hold?.amount ?? 0n)} ${config.token}`, statusUrl: `${endpoint}/${order}` };
    };

    const client = x402Client.fromConfig({
      schemes: [{ network: config.network, client: new ExactEvmScheme(account()) }],
      spendControls: { allowedAssets: [{ network: config.network, asset: config.asset, maxAmountPerPayment: config.maxPrice.toString() }] },
      policies: [
        (_version, requirements) =>
          requirements.filter(
            (r) =>
              r.network === config.network &&
              sameAddress(r.asset, config.asset) &&
              sameAddress(r.payTo, config.payTo) &&
              r.maxTimeoutSeconds <= MAX_TIMEOUT_SECONDS,
          ),
      ],
    });
    // A payment is reserved against the budget and the daily limit before it is
    // signed, so parallel calls cannot overshoot either. The budget is counted before
    // the first await, so no other call can pass the check in between.
    client.onBeforePaymentCreation(async ({ selectedRequirements }) => {
      const taken = await limits.take(BigInt(selectedRequirements.amount));
      if (typeof taken === "string") return { abort: true, reason: taken };
      hold = taken;
    });
    client.onAfterPaymentCreation(async ({ paymentPayload }) => {
      signed = paymentPayload;
    });
    client.onPaymentCreationFailure(async () => {
      if (!signed) await unreserve();
    });

    // Short enough that a possiblyCharged reply reaches a client that gives up after 60 seconds.
    // The x402 client sends clones of the request, and a clone follows the request's signal
    // through weak references only, so once garbage is collected a deadline set on the request
    // never fires. Each request it sends carries the deadline itself, which the timer keeps alive.
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")), options.postTimeoutMs ?? 45_000);
    const timed: typeof fetch = (input, init) => fetchImpl(input, { ...init, signal: deadline.signal });
    let response: Response;
    try {
      response = await wrapFetchWithPayment(timed, client)(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(task),
      });
    } catch (error) {
      if (signed) return possiblyCharged(receipt(orderIdOf(signed)), `The desk did not confirm the order (${firstLine(error)}).`);
      throw new Error(await explainUnsigned(error));
    } finally {
      clearTimeout(timer);
    }

    const reply = (await jsonObject(response)) ?? {};
    if (response.ok) {
      if (!signed) {
        throw new Error(`The desk at ${config.desk} answered ${response.status} without asking for payment, so no task was posted. Check BRAINCHAIN_DESK_URL. Nothing was charged.`);
      }
      return { ...reply, ...receipt(typeof reply.order === "string" ? reply.order : orderIdOf(signed)) };
    }
    // The desk answers 400 (a brief it refuses, including one too large to post)
    // before settling. Any other answer to a signed payment may have charged it,
    // a 402 included unless the desk has no order for it or gave the payment up.
    if (signed && response.status !== 400 && response.status !== 402) {
      return possiblyCharged(receipt(typeof reply.order === "string" ? reply.order : orderIdOf(signed)), `The desk answered ${response.status}.`);
    }
    if (signed && response.status === 402) {
      const order = orderIdOf(signed);
      const open = await stillOpen(order);
      const reason = typeof reply.error === "string" && reply.error.trim() ? ` (${reply.error.trim().replace(/[.!?]+$/, "")})` : "";
      if (open) return possiblyCharged(receipt(order), `The desk answered 402${reason}, and ${open}.`);
    }

    await unreserve();
    if (response.status === 402) throw new Error(await explainRefusal(reply.error));
    throw new Error(typeof reply.error === "string" && reply.error.trim() ? `${sentence(reply.error)} Nothing was charged.` : `The desk answered ${response.status}. Nothing was charged.`);
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
      const at = paid.get(order)?.at;
      if (at === undefined || Date.now() - at >= REPOST_AFTER_MINUTES * 60_000) {
        await release(order);
        return {
          order,
          error: "The desk has no order with this id.",
          done: true,
          next: `Check the order id: it must be one that brainchain_post_task returned. If you posted it more than ${REPOST_AFTER_MINUTES} minutes ago, it was never charged.`,
        };
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
    if (view.state === "failed") await release(order);
    // Results are served by the desk itself; anything else is left as a link.
    if (typeof view.result === "string" && view.result.startsWith(`${config.desk}/records/`)) {
      try {
        const text = await fetchImpl(view.result, { signal: AbortSignal.timeout(20_000) });
        if (text.ok) {
          const full = await text.text();
          view.resultText =
            full.length <= RESULT_LIMIT
              ? full
              : `${full.slice(0, RESULT_LIMIT)}\n\n[Cut at ${RESULT_LIMIT.toLocaleString("en-US")} of ${full.length.toLocaleString("en-US")} characters. The full result is at ${view.result}.]`;
        } else view.resultError = `The result could not be fetched (HTTP ${text.status}); it is at ${view.result}.`;
      } catch (error) {
        view.resultError = `The result could not be fetched (${firstLine(error)}); it is at ${view.result}.`;
      }
    }
    return { ...view, ...guidance(view, config) };
  }

  return { post, get, spent: () => limits.spent() };
}

interface Guidance {
  done: boolean;
  next: string;
  retryAfterSeconds?: number;
}

/** What the order means for the caller, and when to look again. Every state and status pair is in payments.test.ts. */
export function guidance(view: Record<string, unknown>, config: Pick<Config, "chain" | "terms">, now = Date.now()): Guidance {
  const task = (view.task ?? {}) as { status?: string; accepted?: boolean; due?: { by?: unknown } };
  const wait = (retryAfterSeconds: number, next: string): Guidance => ({ done: false, next, retryAfterSeconds });
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
    if (left !== undefined && left <= 0) return wait(60, `${start} The dispute window has closed, so the full amount is refunded on ${config.chain} shortly.`);
    const when = left === undefined ? `, ${config.terms.finalAfter} after grading` : ` at ${due}`;
    return wait(
      left === undefined ? 900 : left + 60,
      `${start} The full amount is refunded on ${config.chain} when the dispute window closes${when}, unless the model disputes the grade and a ruling pays it. Report this now, then read the order again after that time for the refund transaction.`,
    );
  };

  switch (view.state) {
    case "paid-out":
      return paid();
    case "refunded":
      return { done: true, next: `${why}The full amount was refunded on ${config.chain}${typeof view.refundTx === "string" ? ` in ${view.refundTx}` : ""}.` };
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
      return wait(60, `${why}The refund is being sent on ${config.chain}.`);
  }

  switch (task.status) {
    case "paid":
      return paid();
    case "refunded":
      // The board has returned the money to the desk; the payer's refund transaction comes next.
      return wait(60, `${why}The refund is being sent on ${config.chain}.`);
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
