import type { ClientEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { keccak256, toBytes } from "viem";

import { formatUnits, MAX_TIMEOUT_SECONDS, REPOST_AFTER_MINUTES, type Config } from "./config.js";
import type { TaskRequest, Desk } from "./tools.js";

const BUDGET_REASON = "budget";
const RESULT_LIMIT = 20_000;

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
}

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const firstLine = (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";
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
  let spent = 0n;
  const endpoint = `${config.desk}/x402/tasks`;
  const recent = new Map<string, { at: number; reply: Promise<unknown> }>();
  /** When this process paid, or may have paid, for each order; the desk can take minutes to know one. */
  const paidAt = new Map<string, number>();

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
    if (message.includes(`Payment creation aborted: ${BUDGET_REASON}`)) {
      return `This server has already signed payments for ${formatUnits(spent)} of its ${formatUnits(config.budget)} ${config.token} budget. The budget resets when the server restarts; raise BRAINCHAIN_BUDGET_UNITS to allow more per run. Nothing was charged.`;
    }
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
    return `The payment could not be prepared: ${message}. Nothing was charged.`;
  }

  /** Explains a payment the desk refused, from the wallet's balance and Permit2 allowance where possible. */
  async function explainRefusal(reason: unknown): Promise<string> {
    const fallback = typeof reason === "string" ? `The desk refused the payment: ${reason}. Nothing was charged.` : "The desk refused the payment. Nothing was charged.";
    if (!options.funds) return fallback;
    try {
      // One deadline for both reads, so a slow chain cannot hold the reply.
      const deadline = AbortSignal.timeout(10_000);
      const [{ balance, allowance }, quoted] = await until(deadline, Promise.all([options.funds(), quotedPrice(deadline)]));
      const needed = quoted ?? config.maxPrice;
      if (balance < needed) {
        const { address } = typeof signer === "function" ? signer() : signer;
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
      if (typeof order === "string") paidAt.set(order.toLowerCase(), now);
      else forget();
    }, forget);
    return entry.reply;
  }

  async function pay(task: TaskRequest): Promise<unknown> {
    let signed: { payload: unknown } | undefined;
    let amount = 0n;
    const receipt = (order: string) => ({ order, price: `${formatUnits(amount)} ${config.token}`, statusUrl: `${endpoint}/${order}` });

    const client = x402Client.fromConfig({
      schemes: [{ network: config.network, client: new ExactEvmScheme(typeof signer === "function" ? signer() : signer) }],
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
    // A payment is reserved against the budget before it is signed, so parallel
    // calls cannot overshoot it.
    client.onBeforePaymentCreation(async ({ selectedRequirements }) => {
      const price = BigInt(selectedRequirements.amount);
      if (spent + price > config.budget) return { abort: true, reason: BUDGET_REASON };
      spent += price;
      amount = price;
    });
    client.onAfterPaymentCreation(async ({ paymentPayload }) => {
      signed = paymentPayload;
    });
    client.onPaymentCreationFailure(async () => {
      if (signed) return;
      spent -= amount;
      amount = 0n;
    });

    let response: Response;
    try {
      response = await wrapFetchWithPayment(fetchImpl, client)(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(task),
        // Short enough that a possiblyCharged reply reaches a client that gives up after 60 seconds.
        signal: AbortSignal.timeout(options.postTimeoutMs ?? 45_000),
      });
    } catch (error) {
      if (signed) return possiblyCharged(receipt(orderIdOf(signed)), `The desk did not confirm the order (${firstLine(error)}).`);
      throw new Error(await explainUnsigned(error));
    }

    const reply = (await jsonObject(response)) ?? {};
    if (response.ok) {
      if (!signed) {
        throw new Error(`The desk at ${config.desk} answered ${response.status} without asking for payment, so no task was posted. Check BRAINCHAIN_DESK_URL. Nothing was charged.`);
      }
      return { ...reply, ...receipt(typeof reply.order === "string" ? reply.order : orderIdOf(signed)) };
    }
    // The desk answers 400 (a brief it refuses, including one too large to post)
    // and 402 (a payment it refuses) before settling. Any other answer to a
    // signed payment may have charged it.
    if (signed && response.status !== 400 && response.status !== 402) {
      return possiblyCharged(receipt(typeof reply.order === "string" ? reply.order : orderIdOf(signed)), `The desk answered ${response.status}.`);
    }

    spent -= amount;
    amount = 0n;
    if (response.status === 402) throw new Error(await explainRefusal(reply.error));
    throw new Error(typeof reply.error === "string" ? `${reply.error} Nothing was charged.` : `The desk answered ${response.status}. Nothing was charged.`);
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
      const at = paidAt.get(order);
      if (at === undefined || Date.now() - at >= REPOST_AFTER_MINUTES * 60_000) {
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

  return { post, get, spent: () => spent };
}

interface Guidance {
  done: boolean;
  next: string;
  retryAfterSeconds?: number;
}

/** What the order means for the caller, and when to look again. */
export function guidance(view: Record<string, unknown>, config: Pick<Config, "chain" | "terms">): Guidance {
  const task = (view.task ?? {}) as { status?: string; accepted?: boolean };
  const wait = (retryAfterSeconds: number, next: string): Guidance => ({ done: false, next, retryAfterSeconds });
  const accepted = task.accepted === true || view.state === "paid-out" || task.status === "paid";
  if (typeof view.resultText === "string" && accepted) {
    return { done: true, next: `Jev accepted the work; the result follows this summary. The model is paid when the dispute window closes, ${config.terms.finalAfter} after grading.` };
  }
  switch (view.state) {
    case "paid-out":
      return { done: true, next: "Jev accepted the work and the model was paid." };
    case "refunded":
      return { done: true, next: `The work was not accepted. The full amount was refunded on ${config.chain}${typeof view.refundTx === "string" ? ` in ${view.refundTx}` : ""}.` };
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
      return wait(60, `The work was not accepted; the refund is being sent on ${config.chain}.`);
  }
  if (task.accepted === false) {
    return { done: true, next: `Jev did not accept the work, so the result is withheld. The full amount is refunded on ${config.chain} when the dispute window closes, ${config.terms.finalAfter} after grading.` };
  }
  switch (task.status) {
    case "open":
      return wait(60, "Waiting for Jev to hire a model.");
    case "hired":
      return wait(60, "A model is working on the task.");
    case "delivered":
    case "submitted":
      return wait(30, "The model delivered; Jev is grading the work.");
    case "disputed":
      return wait(600, "The grade is disputed; Jev will rule on it.");
    case "graded":
      return wait(60, "Jev accepted the work; the result is being prepared.");
  }
  return wait(60, "The order is in progress.");
}
