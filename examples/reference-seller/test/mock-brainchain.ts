import { getAddress, keccak256, recoverTypedDataAddress, toBytes, type Address, type Hex } from "viem";

/** How the mock's Jev grades a paid request. */
export interface MockGrade {
  passProbability: number;
  checks?: "passed" | "failed" | "timed out";
}

export interface MockOptions {
  origin: string;
  payTo: Address;
  network: `eip155:${number}`;
  asset: Address;
  price: bigint;
  partners?: Record<string, { price: bigint; payers?: Address[] }>;
  decide?: (request: Record<string, unknown>) => MockGrade;
  /** Reads of the status URL that answer "paid" before the verdict. Any at all makes the paid request answer 202. */
  pending?: number;
  /** Refuses every payment with this reason. */
  refuse?: string;
}

interface Payment {
  x402Version: number;
  accepted: Record<string, unknown>;
  payload: { authorization: { from: Address; to: Address; value: string; validAfter: string; validBefore: string; nonce: Hex }; signature: Hex };
}

const DOMAIN = { name: "USD Coin", version: "2" };
const TRANSFER = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;
const base64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(value, { status, headers });

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const source = value as Record<string, unknown>;
  return `{${Object.keys(source).filter((key) => source[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(source[key])}`).join(",")}}`;
}

/**
 * BrainChain's grade route as a fetch handler: the 402 offer, an EIP-3009 payment checked down to its signature,
 * partner routes bound to their wallets, 202 while Jev grades, and the status URL.
 */
export function mockBrainChain(options: MockOptions) {
  const paid: { path: string; request: Record<string, unknown>; payer: Address; amount: string }[] = [];
  const reads: string[] = [];
  const seen: string[] = [];
  let signed = 0;
  const grades = new Map<string, { n: number; polls: number; grade: MockGrade; payer: Address }>();

  const accept = (price: bigint) => ({ scheme: "exact", network: options.network, amount: price.toString(), asset: options.asset, payTo: options.payTo, maxTimeoutSeconds: 300, extra: DOMAIN });

  function offer(url: URL, price: bigint, error?: string): Response {
    const required = { x402Version: 2, error: error ?? "Payment required", resource: { url: url.href, description: "Jev grades a result against your brief.", mimeType: "application/json" }, accepts: [accept(price)] };
    return json(error ? { error } : {}, 402, { "payment-required": base64(required) });
  }

  async function refusal(payment: Payment, price: bigint): Promise<string | undefined> {
    if (payment.x402Version !== 2 || canonical(payment.accepted) !== canonical(accept(price))) return "The payment does not match the offer.";
    const { authorization: a, signature } = payment.payload;
    if (getAddress(a.to) !== getAddress(options.payTo) || a.value !== price.toString() || Number(a.validBefore) <= Date.now() / 1000) return "The authorization does not pay this offer.";
    const signer = await recoverTypedDataAddress({
      domain: { ...DOMAIN, chainId: Number(options.network.split(":")[1]), verifyingContract: options.asset },
      types: TRANSFER,
      primaryType: "TransferWithAuthorization",
      message: { from: a.from, to: a.to, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce },
      signature,
    });
    if (getAddress(signer) !== getAddress(a.from)) return "The signature is not the payer's.";
  }

  function view(id: string, texts: boolean): Record<string, unknown> {
    const { n, polls, grade } = grades.get(id)!;
    const head = { grade: id, state: polls > 0 ? "paid" : "graded", status: `${options.origin}/x402/grades/${id}`, network: options.network, paymentTx: keccak256(toBytes(id)) };
    if (polls > 0) return head;
    const failed = grade.checks !== undefined && grade.checks !== "passed";
    const passProbability = failed ? 0 : grade.passProbability;
    return {
      ...head,
      accepted: passProbability >= 0.8,
      answer: passProbability >= 0.5 ? "accept" : "reject",
      passProbability,
      bar: 0.8,
      confidence: failed ? 1 : Math.max(passProbability, 1 - passProbability),
      ...(grade.checks
        ? { checks: { language: "python", outcome: grade.checks, ...(texts && failed ? { error: "AssertionError", output: "Traceback (most recent call last):\n  ...\nAssertionError" } : {}) } }
        : {}),
      decision: { id: String(n), record: `${options.origin}/records/${id}.json`, page: `${options.origin}/decision?id=${n}` },
    };
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    seen.push(`${request.method} ${url.pathname}`);
    const status = url.pathname.match(/^\/x402\/grades\/(0x[0-9a-f]{64})$/);
    if (request.method === "GET" && status) {
      const id = status[1]!;
      reads.push(id);
      const grade = grades.get(id);
      if (!grade) return json({ error: "No grade with that id." }, 404);
      if (grade.polls > 0) grade.polls--;
      return json(view(id, false));
    }
    const route = url.pathname.match(/^\/x402\/grades(?:\/for\/([^/]+))?$/);
    if (request.method !== "POST" || !route) return json({ error: "No such route." }, 404);
    const partner = route[1] === undefined ? undefined : options.partners?.[route[1]];
    if (route[1] !== undefined && !partner) return json({ error: "No such route." }, 404);
    const price = partner?.price ?? options.price;

    const body = (await request.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    if (typeof body?.brief !== "string" || typeof body.result !== "string") return json({ error: "Send a JSON object with brief and result." }, 400);
    const header = request.headers.get("payment-signature");
    if (!header) return offer(url, price);
    signed++;
    const payment = JSON.parse(Buffer.from(header, "base64").toString()) as Payment;
    const refused = (await refusal(payment, price)) ?? options.refuse;
    if (refused) return offer(url, price, refused);
    const payer = getAddress(payment.payload.authorization.from);
    if (partner?.payers && !partner.payers.some((p) => getAddress(p) === payer)) {
      return json({ error: "This route is for a named partner's wallets. Nothing was charged; pay at /x402/grades." }, 403);
    }

    const id = keccak256(toBytes(canonical(payment.payload)));
    grades.set(id, { n: 4800 + grades.size, polls: options.pending ?? 0, grade: options.decide?.(body) ?? { passProbability: 0.91, checks: "passed" }, payer });
    paid.push({ path: url.pathname, request: body, payer, amount: payment.payload.authorization.value });
    const settled = { "payment-response": base64({ success: true, transaction: keccak256(toBytes(id)), network: options.network, payer }) };
    if (options.pending) return json({ message: "Jev is still grading the work. Read the verdict at the status URL; reading it is free.", ...view(id, true) }, 202, settled);
    return json(view(id, true), 200, settled);
  }

  return {
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => handle(new Request(input, init))) as typeof fetch,
    paid,
    reads,
    seen,
    grades,
    /** How many requests carried a payment header, refused or not. */
    get signed() {
      return signed;
    },
  };
}
