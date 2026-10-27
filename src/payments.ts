import type { ClientEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { keccak256, toBytes } from "viem";

import { formatUnits, MAX_TIMEOUT_SECONDS, type Config } from "./config.js";
import type { TaskRequest, Desk } from "./tools.js";

const BUDGET_REASON = "budget";

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
  signer: ClientEvmSigner;
  /** The command a person runs to approve Permit2, for refusal messages. */
  approveCommand: string;
  fetch?: typeof fetch;
  /** Reads the paying wallet's balance and, for USDG, its Permit2 allowance, to explain a refused payment. */
  funds?: () => Promise<Funds>;
  postTimeoutMs?: number;
}

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const firstLine = (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";

export function createDesk(options: DeskOptions): Desk & { spent(): bigint } {
  const { config, signer, approveCommand } = options;
  const fetchImpl = options.fetch ?? fetch;
  let spent = 0n;
  const endpoint = `${config.desk}/x402/tasks`;

  async function json(response: Response): Promise<Record<string, unknown>> {
    return (await response.json().catch(() => ({}))) as Record<string, unknown>;
  }

  /** The desk's price, read from a fresh 402 challenge. */
  async function quotedPrice(): Promise<bigint | undefined> {
    try {
      const probe = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(15_000),
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
      return `This server has already signed payments for ${formatUnits(spent)} of its ${formatUnits(config.budget)} ${config.token} budget. Restart it with a higher BRAINCHAIN_BUDGET_UNITS to spend more. Nothing was charged.`;
    }
    if (/rejected by spendControls/.test(message)) {
      const price = await quotedPrice();
      if (price !== undefined && price > config.maxPrice) {
        return `The desk asks ${formatUnits(price)} ${config.token} per task, above this server's limit of ${formatUnits(config.maxPrice)}. Raise BRAINCHAIN_MAX_PRICE_UNITS to allow it. Nothing was charged.`;
      }
      return `The desk asked for a payment outside this server's limits (${config.token} at ${config.asset}, at most ${formatUnits(config.maxPrice)} per task). Nothing was charged.`;
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
      return `Could not reach the desk at ${config.desk}. Nothing was charged.`;
    }
    return `The payment could not be prepared: ${message}. Nothing was charged.`;
  }

  /** Explains a payment the desk refused, from the wallet's balance and Permit2 allowance where possible. */
  async function explainRefusal(reason: unknown): Promise<string> {
    const fallback = typeof reason === "string" ? `The desk refused the payment: ${reason}. Nothing was charged.` : "The desk refused the payment. Nothing was charged.";
    if (!options.funds) return fallback;
    try {
      const { balance, allowance } = await options.funds();
      const needed = (await quotedPrice()) ?? config.maxPrice;
      if (balance < needed) return `The paying wallet holds ${formatUnits(balance)} ${config.token} on ${config.chain}; a task costs ${formatUnits(needed)}. Nothing was charged.`;
      if (config.permit2 && allowance !== undefined && allowance < needed) {
        return `Permit2 may not spend this wallet's ${config.token} yet. Run \`${approveCommand}\` once with the same BRAINCHAIN_PAYER_KEY; it needs a little ETH on ${config.chain}. Nothing was charged.`;
      }
    } catch {
      // The chain read failed; the desk's own reason is the best explanation left.
    }
    return fallback;
  }

  function possiblyCharged(order: string, cause: string): Record<string, unknown> {
    return {
      order,
      possiblyCharged: true,
      error: `${cause} The payment may have gone through. Check brainchain_get_task with this order id; do not post the task again.`,
    };
  }

  async function post(task: TaskRequest): Promise<unknown> {
    let signed: { payload: unknown } | undefined;
    let amount = 0n;

    const client = x402Client.fromConfig({
      schemes: [{ network: config.network, client: new ExactEvmScheme(signer) }],
      // Only this network's token, never above the per-task cap.
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
    // calls cannot overshoot it; a recovered retry replaces the first reservation.
    client.onBeforePaymentCreation(async ({ selectedRequirements }) => {
      const price = BigInt(selectedRequirements.amount);
      if (spent - amount + price > config.budget) return { abort: true, reason: BUDGET_REASON };
      spent += price - amount;
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
        signal: AbortSignal.timeout(options.postTimeoutMs ?? 120_000),
      });
    } catch (error) {
      if (signed) return possiblyCharged(orderIdOf(signed), `The desk did not confirm the order (${firstLine(error)}).`);
      throw new Error(await explainUnsigned(error));
    }

    const reply = await json(response);
    if (response.ok) return { ...reply, order: typeof reply.order === "string" ? reply.order : signed ? orderIdOf(signed) : undefined };
    // The desk answers 400 (a brief it refuses) and 402 (a payment it refuses)
    // before settling. Any other answer to a signed payment may have charged it.
    if (signed && response.status !== 400 && response.status !== 402) {
      return possiblyCharged(typeof reply.order === "string" ? reply.order : orderIdOf(signed), `The desk answered ${response.status}.`);
    }

    // The desk refused the brief or the payment before settling it.
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
      return { order, error: `Could not reach the desk (${firstLine(error)}).`, done: false, next: "The desk could not be reached. Read the order again shortly.", retryAfterSeconds: 30 };
    }
    const view = await json(response);
    // A payment authorization lasts at most MAX_TIMEOUT_SECONDS, so an order the
    // desk still does not know after that was never charged.
    if (response.status === 404) {
      return {
        order,
        error: "The desk has no order with this id.",
        done: false,
        next: `If brainchain_post_task said possiblyCharged, the payment either never reached the desk or is still settling. Read the order again in a minute. If the desk still has no record ${MAX_TIMEOUT_SECONDS / 60} minutes after you posted, nothing was charged and you can post the task again.`,
        retryAfterSeconds: 60,
      };
    }
    if (response.status >= 500) {
      return { order, error: `The desk answered ${response.status}.`, done: false, next: "The desk is briefly unavailable. Read the order again shortly.", retryAfterSeconds: 30 };
    }
    if (!response.ok) throw new Error(typeof view.error === "string" ? view.error : `The desk answered ${response.status}.`);
    // Results are served by the desk itself; anything else is left as a link.
    if (typeof view.result === "string" && view.result.startsWith(`${config.desk}/records/`)) {
      try {
        const text = await fetchImpl(view.result, { signal: AbortSignal.timeout(20_000) });
        if (text.ok) view.resultText = await text.text();
        else view.resultError = `The result could not be fetched (HTTP ${text.status}); it is at ${view.result}.`;
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
    return { done: true, next: `Jev accepted the work; the result is in resultText. The model is paid when the dispute window closes, ${config.terms.finalAfter} after grading.` };
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
