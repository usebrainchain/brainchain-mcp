import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import { createKeyPairSignerFromBytes, getBase58Decoder, getBase64Encoder, getCompiledTransactionMessageDecoder, getTransactionDecoder } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";

import { REPOST_AFTER_MINUTES, resolveConfig } from "./config.js";
import { canonicalStringify, createDesk, guidance, orderIdOf } from "./payments.js";
import { callTool, checkBrief, POST_TASK_NAME, type Desk } from "./tools.js";

// Anvil's second default account: a public test key that holds nothing anywhere.
const signer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const config = resolveConfig({ BRAINCHAIN_NETWORK: "testnet" });
const endpoint = `${config.desk}/x402/tasks`;
const task = { title: "Explain a Merkle proof", brief: "In two paragraphs.", levels: ["Accurate and complete", "Accurate", "Wrong"] };

interface ChallengeOverrides {
  amount?: string;
  payTo?: string;
  maxTimeoutSeconds?: number;
}

function challenge(terms: ChallengeOverrides = {}): string {
  const required = {
    x402Version: 2,
    error: "Payment required",
    resource: { url: endpoint, description: "A BrainChain task", mimeType: "application/json" },
    accepts: [
      {
        scheme: "exact",
        network: config.network,
        amount: terms.amount ?? "1000000",
        asset: config.asset,
        payTo: terms.payTo ?? config.payTo,
        maxTimeoutSeconds: terms.maxTimeoutSeconds ?? 300,
        extra: { assetTransferMethod: "permit2" },
      },
    ],
  };
  return Buffer.from(JSON.stringify(required)).toString("base64");
}

/** A desk that challenges unpaid requests and hands paid ones to `paid`. */
function fakeDesk(paid: (payment: { payload: unknown }) => Response | Promise<Response>, terms?: ChallengeOverrides) {
  const seen: { payload: unknown }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const header = request.headers.get("payment-signature");
    if (!header) return new Response("{}", { status: 402, headers: { "payment-required": challenge(terms) } });
    const payment = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { payload: unknown };
    seen.push(payment);
    return paid(payment);
  }) as typeof fetch;
  return { fetchImpl, seen };
}

const accepted = (payment: { payload: unknown }) =>
  new Response(JSON.stringify({ order: orderIdOf(payment), status: `/x402/tasks/${orderIdOf(payment)}` }), { status: 202 });

function desk(fetchImpl: typeof fetch, overrides: Partial<typeof config> = {}) {
  return createDesk({ config: { ...config, ...overrides }, signer, approveCommand: "npx -y brainchain-mcp approve", fetch: fetchImpl, postTimeoutMs: 10_000 });
}

describe("paying on Solana", () => {
  const solana = resolveConfig({ BRAINCHAIN_NETWORK: "testnet", BRAINCHAIN_PAY_ON: "solana" });
  const evm = resolveConfig({ BRAINCHAIN_NETWORK: "testnet" });

  /** A Solana node that knows one account: the USDC mint, with 6 decimals. */
  async function solanaNode() {
    const mint = new Uint8Array(82);
    mint[44] = 6;
    mint[45] = 1;
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        const { id, method } = JSON.parse(body) as { id: unknown; method: string };
        const result =
          method === "getAccountInfo"
            ? { context: { slot: 1 }, value: { data: [Buffer.from(mint).toString("base64"), "base64"], executable: false, lamports: 1461600, owner: TOKEN_PROGRAM_ADDRESS, rentEpoch: 0, space: 82 } }
            : null;
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, result }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
  }

  async function payer() {
    const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    const secret = new Uint8Array(64);
    secret.set(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).slice(-32), 0);
    secret.set(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)), 32);
    return { address: (await createKeyPairSignerFromBytes(secret)).address as string, secret };
  }

  /** The desk's challenge as it stands with every lane on: Robinhood Chain, Base and Solana. */
  function challengeAll(payTo = solana.payTo): string {
    const accepts = [
      { scheme: "exact", network: evm.network, amount: "1000000", asset: evm.asset, payTo: evm.payTo, maxTimeoutSeconds: 300, extra: { assetTransferMethod: "permit2" } },
      {
        scheme: "exact",
        network: solana.network,
        amount: "1000000",
        asset: solana.asset,
        payTo,
        maxTimeoutSeconds: 300,
        extra: { feePayer: "BENrLoUbndxoNMUS5JXApGMtNykLjFXXixMtpDwDR9SP", recentBlockhash: getBase58Decoder().decode(new Uint8Array(32).fill(9)), lastValidBlockHeight: "1000" },
      },
    ];
    return Buffer.from(JSON.stringify({ x402Version: 2, error: "Payment required", resource: { url: endpoint, description: "A BrainChain task", mimeType: "application/json" }, accepts })).toString("base64");
  }

  function deskWithSolana(payTo?: string) {
    const seen: { payload: { transaction?: string }; accepted: { network: string } }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const header = request.headers.get("payment-signature");
      if (!header) return new Response("{}", { status: 402, headers: { "payment-required": challengeAll(payTo) } });
      const payment = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as (typeof seen)[number];
      seen.push(payment);
      return accepted(payment);
    }) as typeof fetch;
    return { fetchImpl, seen };
  }

  it("signs one USDC transfer to the desk's Solana wallet, picking the Solana accept, and names the order as the desk does", async () => {
    const node = await solanaNode();
    try {
      const wallet = await payer();
      const { fetchImpl, seen } = deskWithSolana();
      const d = createDesk({ config: { ...solana, rpc: node.url }, signer: wallet, approveCommand: "unused", fetch: fetchImpl, postTimeoutMs: 10_000 });
      const reply = (await d.post(task)) as Record<string, unknown>;
      expect(seen).toHaveLength(1);
      expect(seen[0]!.accepted.network).toBe(solana.network);
      expect(reply).toMatchObject({ order: orderIdOf(seen[0]!), price: "1 test USDC" });
      expect(d.spent()).toBe(1_000_000n);

      const wire = getTransactionDecoder().decode(getBase64Encoder().encode(seen[0]!.payload.transaction!));
      const message = getCompiledTransactionMessageDecoder().decode(wire.messageBytes);
      const transfer = message.instructions.find((ix) => message.staticAccounts[ix.programAddressIndex] === TOKEN_PROGRAM_ADDRESS)!;
      const [source, mint, destination, authority] = transfer.accountIndices!.map((i) => message.staticAccounts[i]);
      const ata = async (owner: string) => (await findAssociatedTokenPda({ owner: owner as never, mint: solana.asset as never, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];
      expect({ source, mint, destination, authority }).toEqual({ source: await ata(wallet.address), mint: solana.asset, destination: await ata(solana.payTo), authority: wallet.address });
      expect(new DataView(transfer.data!.buffer, transfer.data!.byteOffset + 1, 8).getBigUint64(0, true)).toBe(1_000_000n);
    } finally {
      node.close();
    }
  });

  it("refuses a Solana accept paying anyone but the desk, even one that differs only in case", async () => {
    const node = await solanaNode();
    try {
      const swapped = solana.payTo.replace(/[a-z]/, (c) => c.toUpperCase());
      const { fetchImpl, seen } = deskWithSolana(swapped);
      const d = createDesk({ config: { ...solana, rpc: node.url }, signer: await payer(), approveCommand: "unused", fetch: fetchImpl });
      await expect(d.post(task)).rejects.toThrow(`the payee must be ${solana.payTo}`);
      expect(seen).toHaveLength(0);
      expect(d.spent()).toBe(0n);
    } finally {
      node.close();
    }
  });

  it("refuses a key for the wrong chain before signing anything", async () => {
    const { fetchImpl, seen } = deskWithSolana();
    await expect(createDesk({ config: solana, signer, approveCommand: "unused", fetch: fetchImpl }).post(task)).rejects.toThrow("The paying key is not for Solana devnet.");
    expect(seen).toHaveLength(0);
  });
});

describe("order ids", () => {
  it("match the desk's: keccak256 of the payload with sorted keys", () => {
    const payload = {
      signature: "0xabc",
      permit2Authorization: {
        permitted: { token: "0x1eC185467cA2D5d1c24f0EdCB91301Bca4d0a787", amount: "1000000" },
        spender: "0x402",
        nonce: "123",
        deadline: "1792900000",
        witness: { to: "0xf848984c8A0D9E49Cc9C97380C62b34C6f3b97D1", validAfter: "0", extra: "0x" },
        from: "0x01",
      },
    };
    // Computed with the desk's own serializer.
    expect(orderIdOf({ payload })).toBe("0xd3df7ba38a2d01e400f6c151b798543edf69d329ee7f44709c1c4b9da48ce955");
    expect(canonicalStringify({ b: [1, { d: null, c: true }], a: "x" })).toBe('{"a":"x","b":[1,{"c":true,"d":null}]}');
  });
});

describe("posting", () => {
  it("pays once and returns the desk's order, the price paid and where to read it", async () => {
    const { fetchImpl, seen } = fakeDesk(accepted);
    const d = desk(fetchImpl);
    const reply = (await d.post(task)) as Record<string, unknown>;
    const order = orderIdOf(seen[0]!);
    expect(seen).toHaveLength(1);
    expect(reply).toMatchObject({ order, price: "1 test USDG", statusUrl: `${endpoint}/${order}` });
    expect(reply).not.toHaveProperty("duplicate");
    expect(d.spent()).toBe(1_000_000n);
  });

  it("returns the order id when the paid request fails, so the model does not pay twice", async () => {
    const { fetchImpl, seen } = fakeDesk(() => {
      throw new TypeError("fetch failed");
    });
    const reply = (await desk(fetchImpl).post(task)) as { order: string; possiblyCharged: boolean; error: string };
    expect(reply.possiblyCharged).toBe(true);
    expect(reply).toMatchObject({ order: orderIdOf(seen[0]!), price: "1 test USDG", statusUrl: `${endpoint}/${orderIdOf(seen[0]!)}` });
    expect(reply.error).toMatch(/do not post the task again/);
  });

  it("treats a duplicate (409) and a gateway error as possibly charged", async () => {
    for (const status of [409, 502]) {
      const { fetchImpl, seen } = fakeDesk(() => new Response(JSON.stringify({ error: "busy" }), { status }));
      const reply = (await desk(fetchImpl).post(task)) as { order: string; possiblyCharged: boolean };
      expect(reply).toMatchObject({ possiblyCharged: true, order: orderIdOf(seen[0]!) });
    }
  });

  it("treats any reply to a signed payment other than 400 or 402 as possibly charged", async () => {
    for (const status of [408, 429, 403]) {
      const { fetchImpl, seen } = fakeDesk(() => new Response("{}", { status }));
      const d = desk(fetchImpl);
      const reply = (await d.post(task)) as { order: string; possiblyCharged: boolean };
      expect(reply).toMatchObject({ possiblyCharged: true, order: orderIdOf(seen[0]!) });
      expect(d.spent()).toBe(1_000_000n);
    }
  });

  it("answers possiblyCharged by its deadline while the desk holds a paid request, through garbage collection", async () => {
    // The real fetch, against a desk that never answers the paid request, with garbage collected all along.
    setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc") as () => void;
    const held: ServerResponse[] = [];
    const server = createServer((request, response) => {
      request.resume();
      if (request.headers["payment-signature"]) return void held.push(response);
      response.writeHead(402, { "payment-required": challenge() }).end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const collect = setInterval(gc, 20);
    try {
      const local = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const d = createDesk({ config: { ...config, desk: local }, signer, approveCommand: "npx -y brainchain-mcp approve", postTimeoutMs: 500 });
      const started = Date.now();
      const reply = (await d.post(task)) as { possiblyCharged?: boolean; error?: string };
      expect(Date.now() - started).toBeLessThan(2_500);
      expect(held).toHaveLength(1);
      expect(reply.possiblyCharged).toBe(true);
      expect(reply.error).toMatch(/do not post the task again/);
    } finally {
      clearInterval(collect);
      for (const response of held) response.destroy();
      server.closeAllConnections();
      server.close();
    }
  });

  it("releases the budget when the desk rejects the request", async () => {
    const { fetchImpl } = fakeDesk(() => new Response(JSON.stringify({ error: "brief must be 1 to 32,000 characters." }), { status: 400 }));
    const d = desk(fetchImpl);
    await expect(d.post(task)).rejects.toThrow(/Nothing was charged/);
    expect(d.spent()).toBe(0n);
  });

  it("reports a task too large to post as the desk's error, before or after signing", async () => {
    const tooLarge = () => new Response(JSON.stringify({ error: "The task is too large to post." }), { status: 400 });
    const { fetchImpl, seen } = fakeDesk(tooLarge);
    const d = desk(fetchImpl);
    await expect(d.post(task)).rejects.toThrow("The task is too large to post. Nothing was charged.");
    expect(seen).toHaveLength(1);
    expect(d.spent()).toBe(0n);
    await expect(desk((async () => tooLarge()) as typeof fetch).post(task)).rejects.toThrow("The task is too large to post. Nothing was charged.");
  });

  it("ends the desk's reason as a sentence before saying nothing was charged", async () => {
    for (const [error, said] of [
      ["brief refused", "brief refused. Nothing was charged."],
      ["The brief is refused.", "The brief is refused. Nothing was charged."],
      ["", "The desk answered 400. Nothing was charged."],
    ]) {
      const refuse = (async () => new Response(JSON.stringify({ error }), { status: 400 })) as typeof fetch;
      await expect(desk(refuse).post(task)).rejects.toThrow(said);
    }
    const { fetchImpl } = fakeDesk(() => new Response(JSON.stringify({ error: "insufficient_funds" }), { status: 402 }));
    await expect(desk(fetchImpl).post(task)).rejects.toThrow("The desk refused the payment: insufficient_funds. Nothing was charged.");
  });

  it("refuses a desk that answers without asking for payment", async () => {
    const free = (async () => new Response("<html>ok</html>", { status: 200 })) as typeof fetch;
    await expect(desk(free).post(task)).rejects.toThrow(`The desk at ${config.desk} answered 200 without asking for payment`);
  });

  it("stops at the budget before signing", async () => {
    const { fetchImpl, seen } = fakeDesk(accepted);
    const d = desk(fetchImpl, { budget: 1_500_000n });
    await d.post(task);
    await expect(d.post({ ...task, brief: "In one paragraph." })).rejects.toThrow(/BRAINCHAIN_BUDGET_UNITS/);
    expect(seen).toHaveLength(1);
    expect(d.spent()).toBe(1_000_000n);
  });

  it("keeps the daily limit across a restart", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "brainchain-mcp-"));
    const { fetchImpl, seen } = fakeDesk(accepted);
    await desk(fetchImpl, { daily: 1_500_000n, stateDir }).post(task);
    const restarted = desk(fetchImpl, { daily: 1_500_000n, stateDir });
    await expect(restarted.post({ ...task, brief: "In one paragraph." })).rejects.toThrow(
      /already signed payments for 1 of its daily limit of 1\.5, counting USDG and USDC together\. The limit resets at 00:00 UTC.*Nothing was charged\.$/,
    );
    expect(seen).toHaveLength(1);
  });

  it("holds the budget and the daily limit for posts made at once", async () => {
    const tasks = ["one", "two", "three"].map((brief) => ({ ...task, brief }));
    const stateDir = await mkdtemp(join(tmpdir(), "brainchain-mcp-"));
    const byBudget = fakeDesk(accepted);
    const d = desk(byBudget.fetchImpl, { budget: 1_000_000n, daily: 5_000_000n, stateDir });
    const replies = await Promise.allSettled(tasks.map((t) => d.post(t)));
    expect(byBudget.seen).toHaveLength(1);
    expect(replies.filter((r) => r.status === "rejected").map((r) => String(r.reason))).toEqual([expect.stringMatching(/BRAINCHAIN_BUDGET_UNITS/), expect.stringMatching(/BRAINCHAIN_BUDGET_UNITS/)]);
    expect(d.spent()).toBe(1_000_000n);
    expect(JSON.parse(await readFile(join(stateDir, `spend-testnet-${signer.address.toLowerCase()}.json`), "utf8"))).toMatchObject({ units: "1000000" });

    const byDay = fakeDesk(accepted);
    const e = desk(byDay.fetchImpl, { daily: 1_000_000n, stateDir: await mkdtemp(join(tmpdir(), "brainchain-mcp-")) });
    const daily = await Promise.allSettled(tasks.map((t) => e.post(t)));
    expect(byDay.seen).toHaveLength(1);
    expect(daily.filter((r) => r.status === "rejected").map((r) => String(r.reason))).toEqual([expect.stringMatching(/daily limit/), expect.stringMatching(/daily limit/)]);
    // A payment the daily limit refused gives its share of the budget back.
    expect(e.spent()).toBe(1_000_000n);
  });

  it("gives the budget back when the daily record cannot be read", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "brainchain-mcp-"));
    await writeFile(join(stateDir, `spend-testnet-${signer.address.toLowerCase()}.json`), "{not json");
    const { fetchImpl, seen } = fakeDesk(accepted);
    const d = desk(fetchImpl, { daily: 5_000_000n, stateDir });
    await expect(d.post(task)).rejects.toThrow(/cannot be read/);
    expect(seen).toHaveLength(0);
    expect(d.spent()).toBe(0n);
  });

  it("returns to the daily limit what the desk refused", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "brainchain-mcp-"));
    let refuse = true;
    const { fetchImpl, seen } = fakeDesk((payment) =>
      refuse ? new Response(JSON.stringify({ error: "brief must be 1 to 32,000 characters." }), { status: 400 }) : accepted(payment),
    );
    const d = desk(fetchImpl, { daily: 1_000_000n, stateDir });
    await expect(d.post(task)).rejects.toThrow(/Nothing was charged/);
    refuse = false;
    await expect(d.post(task)).resolves.toMatchObject({ price: expect.stringMatching(/^1 /) });
    expect(seen).toHaveLength(2);
  });

  it("refuses to pay anyone but the desk, or for longer than 600 seconds", async () => {
    for (const terms of [{ payTo: "0x000000000000000000000000000000000000dEaD" }, { maxTimeoutSeconds: 3_600 }]) {
      const { fetchImpl, seen } = fakeDesk(accepted, terms);
      await expect(desk(fetchImpl).post(task)).rejects.toThrow(/does not accept/);
      expect(seen).toHaveLength(0);
    }
  });

  it("names the price when the desk asks more than the cap", async () => {
    const { fetchImpl, seen } = fakeDesk(accepted, { amount: "2000000" });
    await expect(desk(fetchImpl).post(task)).rejects.toThrow(/asks 2 test USDG per task, above this server's limit of 1/);
    expect(seen).toHaveLength(0);
  });
});

describe("posting the same task again", () => {
  it("signs once for two identical posts in flight", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { fetchImpl, seen } = fakeDesk(async (payment) => {
      await gate;
      return accepted(payment);
    });
    const d = desk(fetchImpl);
    const first = d.post(task);
    const second = d.post({ ...task, levels: [...task.levels] });
    release();
    expect(await second).toEqual({ ...(await first as object), duplicate: true });
    expect(seen).toHaveLength(1);
    expect(d.spent()).toBe(1_000_000n);
  });

  it("returns the first order for an identical post after it completed, and signs again once the window has passed", async () => {
    const { fetchImpl, seen } = fakeDesk(accepted);
    const d = desk(fetchImpl);
    const first = (await d.post(task)) as { order: string };
    expect(await d.post(task)).toEqual({ ...first, duplicate: true });
    expect(seen).toHaveLength(1);

    const later = Date.now() + REPOST_AFTER_MINUTES * 60_000;
    vi.spyOn(Date, "now").mockReturnValue(later);
    try {
      await d.post(task);
    } finally {
      vi.restoreAllMocks();
    }
    expect(seen).toHaveLength(2);
  });

  it("keeps a possiblyCharged reply, so a retry does not pay again", async () => {
    const { fetchImpl, seen } = fakeDesk(() => new Response("{}", { status: 502 }));
    const d = desk(fetchImpl);
    const first = (await d.post(task)) as { possiblyCharged: boolean };
    expect(first.possiblyCharged).toBe(true);
    expect(await d.post(task)).toEqual({ ...first, duplicate: true });
    expect(seen).toHaveLength(1);
  });

  it("signs anew for a different brief, or after a post that charged nothing", async () => {
    let refuse = true;
    const { fetchImpl, seen } = fakeDesk((payment) => (refuse ? new Response(JSON.stringify({ error: "busy" }), { status: 400 }) : accepted(payment)));
    const d = desk(fetchImpl);
    await expect(d.post(task)).rejects.toThrow(/Nothing was charged/);
    refuse = false;
    const retried = (await d.post(task)) as { order: string };
    const other = (await d.post({ ...task, brief: "In one paragraph." })) as { order: string };
    expect(seen).toHaveLength(3);
    expect(other.order).not.toBe(retried.order);
    expect(d.spent()).toBe(2_000_000n);
  });
});

describe("paying on Base", () => {
  const base = resolveConfig({ BRAINCHAIN_NETWORK: "testnet", BRAINCHAIN_PAY_ON: "base" });
  /** The desk's real challenge: USDG on Robinhood Chain first, then USDC on Base. */
  function bothLanes(paid: (payment: { payload: unknown; accepted?: { network?: string } }) => Response) {
    const usdc = { scheme: "exact", network: base.network, amount: "1000000", asset: base.asset, payTo: base.payTo, maxTimeoutSeconds: 300, extra: { name: "USDC", version: "2" } };
    const usdg = { ...usdc, network: config.network, asset: config.asset, extra: { assetTransferMethod: "permit2" } };
    const header = Buffer.from(JSON.stringify({ x402Version: 2, resource: { url: endpoint }, accepts: [usdg, usdc] })).toString("base64");
    const seen: { payload: unknown; accepted?: { network?: string } }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const signature = request.headers.get("payment-signature");
      if (!signature) return new Response(JSON.stringify({ error: "not enough USDC" }), { status: 402, headers: { "payment-required": header } });
      const payment = JSON.parse(Buffer.from(signature, "base64").toString("utf8")) as { payload: unknown; accepted?: { network?: string } };
      seen.push(payment);
      return paid(payment);
    }) as typeof fetch;
    return { fetchImpl, seen };
  }

  it("holds one daily limit for a wallet on either chain, and a separate one per network", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "brainchain-mcp-"));
    const robinhood = fakeDesk(accepted);
    await desk(robinhood.fetchImpl, { daily: 1_500_000n, stateDir }).post(task);
    const onBase = bothLanes(accepted);
    await expect(createDesk({ config: { ...base, daily: 1_500_000n, stateDir }, signer, approveCommand: "unused", fetch: onBase.fetchImpl }).post({ ...task, brief: "On the other chain." })).rejects.toThrow(
      /already signed payments for 1 of its daily limit of 1\.5, counting USDG and USDC together\./,
    );
    expect(onBase.seen).toHaveLength(0);
    expect(await readdir(stateDir)).toEqual([`spend-testnet-${signer.address.toLowerCase()}.json`]);
  });

  it("picks the Base accept and signs a transfer authorization, not a Permit2 transfer", async () => {
    const { fetchImpl, seen } = bothLanes(accepted);
    await createDesk({ config: base, signer, approveCommand: "unused", fetch: fetchImpl }).post(task);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.accepted?.network).toBe("eip155:84532");
    expect(seen[0]!.payload).toHaveProperty("authorization");
    expect(seen[0]!.payload).not.toHaveProperty("permit2Authorization");
  });

  it("never suggests a Permit2 approval when a payment on Base is refused", async () => {
    const { fetchImpl } = bothLanes(() => new Response(JSON.stringify({ error: "insufficient_funds" }), { status: 402 }));
    const d = createDesk({ config: base, signer, approveCommand: "npx -y brainchain-mcp approve", fetch: fetchImpl, funds: async () => ({ balance: 5_000_000n }) });
    const error = await d.post(task).catch((e: Error) => e);
    expect(String(error)).toMatch(/refused the payment/);
    expect(String(error)).not.toMatch(/Permit2|approve/);
  });

  it("says how much to send, and where, when the wallet is short", async () => {
    const { fetchImpl } = bothLanes(() => new Response(JSON.stringify({ error: "insufficient_funds" }), { status: 402 }));
    const d = createDesk({ config: base, signer: () => signer, approveCommand: "unused", fetch: fetchImpl, funds: async () => ({ balance: 400_000n }) });
    await expect(d.post(task)).rejects.toThrow(`Send at least 0.6 test USDC to ${signer.address} on Base Sepolia, then post again.`);
  });
});

describe("input checks", () => {
  const never: Desk = {
    post: async () => {
      throw new Error("should not be called");
    },
    get: async () => ({}),
  };
  it("rejects briefs the desk would refuse, before anything is signed", async () => {
    for (const input of [
      { ...task, title: "   " },
      { ...task, title: "x".repeat(121) },
      { ...task, brief: "" },
      { ...task, brief: "x".repeat(32_001) },
      { ...task, levels: ["only one"] },
      { ...task, levels: ["a", "b", "c", "d"] },
      { ...task, levels: ["a", "x".repeat(201)] },
    ]) {
      const result = await callTool(never, POST_TASK_NAME, input);
      expect(result.isError).toBe(true);
    }
  });

  it("measures what is sent: trimmed, with briefs up to 32,000 characters", () => {
    expect(checkBrief({ ...task, title: ` ${"x".repeat(120)} `, brief: "x".repeat(32_000) })).toMatchObject({ title: "x".repeat(120) });
  });

  it("measures the whole task in bytes as the desk does, with its pass level, as canonical JSON", () => {
    const levels = ["a", "b"];
    const overhead = Buffer.byteLength('{"brief":"","levels":["a","b"],"passIndex":0,"title":"t"}');
    // 21,000 characters at three bytes each, then one-byte characters up to the cap.
    const brief = `${"漢".repeat(21_000)}${"x".repeat(64_000 - 63_000 - overhead)}`;
    expect(checkBrief({ title: "t", brief, levels }).brief).toBe(brief);
    expect(() => checkBrief({ title: "t", brief: `${brief}x`, levels })).toThrow("The task is 64,001 bytes as JSON; the limit is 64,000. Shorten the brief.");
    // A quote is escaped, so it takes two bytes.
    expect(() => checkBrief({ title: "t", brief: `${brief.slice(0, -1)}"`, levels })).toThrow("The task is 64,001 bytes as JSON");
  });
});

describe("reading an order", () => {
  it("stops at an order the desk does not know, unless this server paid for it in the last 15 minutes", async () => {
    const order = `0x${"ab".repeat(32)}`;
    expect(await desk((async () => new Response("{}", { status: 404 })) as typeof fetch).get(order)).toMatchObject({
      done: true,
      error: "The desk has no order with this id.",
      next: expect.stringMatching(/^Check the order id/),
    });

    // The paid request drops, so the desk may not have recorded the order yet.
    let paid = "";
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.method === "GET") return new Response(JSON.stringify({ error: "No order with that id." }), { status: 404 });
      const header = request.headers.get("payment-signature");
      if (!header) return new Response("{}", { status: 402, headers: { "payment-required": challenge() } });
      paid = orderIdOf(JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { payload: unknown });
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const d = desk(fetchImpl);
    expect(await d.post(task)).toMatchObject({ possiblyCharged: true, order: paid });
    const settling = (await d.get(paid)) as { done: boolean; next: string; retryAfterSeconds: number };
    expect(settling).toMatchObject({ done: false, retryAfterSeconds: 60 });
    expect(settling.next).toMatch(/nothing was charged and you can post the task again/);

    vi.spyOn(Date, "now").mockReturnValue(Date.now() + REPOST_AFTER_MINUTES * 60_000);
    try {
      expect(await d.get(paid)).toMatchObject({ done: true, error: "The desk has no order with this id." });
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("guides the caller through an unavailable desk instead of failing", async () => {
    const order = `0x${"ab".repeat(32)}`;
    const reply = (status: number) => (async () => new Response("{}", { status })) as typeof fetch;
    expect(await desk(reply(502)).get(order)).toMatchObject({ done: false, retryAfterSeconds: 30 });
    const offline = (async () => Promise.reject(new TypeError("fetch failed"))) as typeof fetch;
    expect(await desk(offline).get(order)).toMatchObject({ done: false, retryAfterSeconds: 30 });
  });

  it("waits out a busy desk, honouring Retry-After", async () => {
    const order = `0x${"ab".repeat(32)}`;
    const reply = (status: number, headers: Record<string, string> = {}) => (async () => new Response("{}", { status, headers })) as typeof fetch;
    for (const status of [408, 425, 429, 503]) expect(await desk(reply(status)).get(order)).toMatchObject({ done: false, retryAfterSeconds: 30 });
    expect(await desk(reply(429, { "retry-after": "120" })).get(order)).toMatchObject({ done: false, retryAfterSeconds: 120 });
    const at = new Date(Date.now() + 90_000).toUTCString();
    const { retryAfterSeconds } = (await desk(reply(503, { "retry-after": at })).get(order)) as { retryAfterSeconds: number };
    expect(retryAfterSeconds).toBeGreaterThan(80);
    expect(retryAfterSeconds).toBeLessThanOrEqual(91);
  });

  it("reads an order again when a 2xx reply is not JSON", async () => {
    const html = (async () => new Response("<html>maintenance</html>", { status: 200 })) as typeof fetch;
    expect(await desk(html).get(`0x${"ab".repeat(32)}`)).toMatchObject({ done: false, retryAfterSeconds: 30, error: "The desk's reply could not be read." });
  });

  it("cuts a long result and links the full record", async () => {
    const result = `${config.desk}/records/0x${"1".repeat(64)}.txt`;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input) === result) return new Response("y".repeat(25_000));
      return new Response(JSON.stringify({ order: "0x01", state: "posted", task: { status: "graded", accepted: true }, result }));
    }) as typeof fetch;
    const view = (await desk(fetchImpl).get(`0x${"a".repeat(64)}`)) as { resultText: string; done: boolean };
    expect(view.done).toBe(true);
    expect(view.resultText.startsWith("y".repeat(20_000))).toBe(true);
    expect(view.resultText).not.toContain("y".repeat(20_001));
    expect(view.resultText).toContain(`Cut at 20,000 of 25,000 characters. The full result is at ${result}.`);
  });

  it("keeps the order when the result cannot be fetched", async () => {
    const result = `${config.desk}/records/0x${"1".repeat(64)}.txt`;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input) === result) throw new TypeError("fetch failed");
      return new Response(JSON.stringify({ order: "0x01", state: "posted", task: { status: "graded", accepted: true }, result }));
    }) as typeof fetch;
    const view = (await desk(fetchImpl).get(`0x${"a".repeat(64)}`)) as Record<string, unknown>;
    expect(view.resultError).toMatch(/could not be fetched/);
    expect(view.done).toBe(false);
  });

  it("says the task is posted when the order reads posted before the task's status reaches it", () => {
    expect(guidance({ state: "posted" }, config)).toEqual({ done: false, next: "The task is posted; its status shows here shortly.", retryAfterSeconds: 20 });
    expect(guidance({ state: "posted", task: { status: "something-new" } }, config)).toEqual({ done: false, next: "The order is in progress.", retryAfterSeconds: 60 });
  });

  it("says when to stop polling", () => {
    expect(guidance({ resultText: "done", task: { status: "graded", accepted: true } }, config)).toMatchObject({ done: true });
    // A desk that serves results before grading must not read as accepted.
    expect(guidance({ resultText: "draft", state: "posted", task: { status: "delivered" } }, config)).toMatchObject({ done: false, retryAfterSeconds: 30 });
    expect(guidance({ state: "posted", task: { status: "submitted" } }, config)).toMatchObject({ done: false, retryAfterSeconds: 30 });
    for (const state of ["paid-out", "refunded", "refund-failed", "failed"]) expect(guidance({ state }, config).done).toBe(true);
    expect(guidance({ state: "unconfirmed" }, config)).toMatchObject({ done: false, retryAfterSeconds: 30 });
    expect(guidance({ state: "posted", task: { status: "hired" } }, config)).toMatchObject({ done: false, retryAfterSeconds: 60 });
    expect(guidance({ state: "something-new" }, config)).toMatchObject({ done: false });
  });

  it("keeps waiting while a dispute, a ruling or an appeal can still change a rejected grade", () => {
    const by = "2026-11-10T12:00:00.000Z";
    for (const status of ["disputed", "ruled", "appealed"]) {
      expect(guidance({ state: "posted", task: { status, accepted: false, due: { step: status === "ruled" ? "appeal" : "rule", by } } }, config)).toMatchObject({ done: false });
    }
    expect(guidance({ state: "posted", task: { status: "ruled", accepted: false, due: { step: "appeal", by } } }, config).next).toBe(
      `Jev ruled on the dispute. The ruling settles when its appeal window closes at ${by}, unless the side it went against appeals.`,
    );
    expect(guidance({ state: "posted", task: { status: "appealed", accepted: true } }, config).next).toBe("The ruling was appealed; Jev rules again. If no second ruling comes, the first one stands.");
  });

  it("finishes on a settled task even when the result file cannot be read, and claims no verdict it was not given", () => {
    const paid = guidance({ state: "posted", result: "https://desk/records/0xdead", task: { status: "paid", accepted: true } }, config);
    expect(paid).toMatchObject({ done: true, next: "Jev accepted the work and the model was paid. The result is at https://desk/records/0xdead." });
    const overturned = guidance({ state: "posted", task: { status: "paid", accepted: false } }, config);
    expect(overturned).toMatchObject({ done: true, next: "The model was paid." });
    expect(guidance({ state: "posted", task: { status: "graded" } }, config).next).toBe("Jev graded the work; the verdict is being recorded.");
    expect(guidance({ state: "posted", task: { status: "graded", accepted: true } }, config).next).toBe("Jev accepted the work; the result is being prepared.");
  });

  it("names the deadline a step must meet and why an order was refunded", () => {
    const by = "2026-11-02T14:05:31.000Z";
    expect(guidance({ state: "posted", task: { status: "delivered", due: { step: "grade", by } } }, config).next).toBe(
      `The model delivered; Jev is grading the work. If Jev has not graded it by ${by}, the full amount is refunded.`,
    );
    const refunded = guidance({ state: "refunded", refundTx: "0xfeed", refundReason: "Jev did not grade the work within the grading window." }, config);
    expect(refunded.next).toMatch(/^Jev did not grade the work within the grading window\. The full amount was refunded on .* in 0xfeed\.$/);
  });
});

describe("what brainchain_get_task says, for every order state and task status", () => {
  const chain = config.chain;
  const NOW = Date.parse("2026-11-04T12:00:00.000Z");
  const by = "2026-11-04T18:00:00.000Z";
  const closed = "2026-11-04T11:00:00.000Z";
  const STATES = ["paying", "unconfirmed", "failed", "paid", "posted", "paid-out", "refunding", "refunded", "refund-failed"];
  const STATUSES = [undefined, "none", "open", "hired", "delivered", "graded", "disputed", "paid", "refunded", "ruled", "appealed"];
  const read = (state: string, status?: string, accepted?: boolean, extra: Record<string, unknown> = {}) =>
    guidance({ state, ...(status ? { task: { status, ...(accepted === undefined ? {} : { accepted }), ...(extra.due ? { due: { by: extra.due } } : {}) } } : {}), ...extra }, config, NOW);
  const waits = (retryAfterSeconds: number, next: string) => ({ done: false, next, retryAfterSeconds });
  const finished = (next: string) => ({ done: true, next });

  // The order's own state decides, whatever the task's status last read: [state, what the caller is told].
  const BY_STATE: [string, ReturnType<typeof waits> | ReturnType<typeof finished>][] = [
    ["paying", waits(20, "The payment is settling and the task is being posted.")],
    ["paid", waits(20, "The payment is settling and the task is being posted.")],
    ["unconfirmed", waits(30, "The payment may have gone through; BrainChain is checking it against the chain. Do not post the task again.")],
    ["failed", finished("The payment did not settle: nothing was charged and no task was posted. You can post the task again.")],
    ["refund-failed", finished("The refund could not be sent automatically. Write to hello@usebrainchain.com with this order id.")],
  ];
  it.each(BY_STATE)("%s", (state, expected) => {
    for (const status of STATUSES) for (const accepted of [undefined, true, false]) expect(read(state, status, accepted)).toEqual(expected);
  });

  // [state, status, accepted, extra fields, what the caller is told].
  const reject = "Jev did not accept the work, so the result is withheld.";
  const TABLE: [string, string | undefined, boolean | undefined, Record<string, unknown>, ReturnType<typeof waits> | ReturnType<typeof finished>][] = [
    ["posted", undefined, undefined, {}, waits(20, "The task is posted; its status shows here shortly.")],
    ["posted", "none", undefined, {}, waits(60, "The order is in progress.")],
    ["posted", "open", undefined, { due: by }, waits(60, `Waiting for Jev to hire a model. If no model is hired by ${by}, the full amount is refunded.`)],
    ["posted", "hired", undefined, { due: by }, waits(60, `A model is working on the task. If the work is not delivered by ${by}, the full amount is refunded.`)],
    ["posted", "delivered", undefined, { due: by }, waits(30, `The model delivered; Jev is grading the work. If Jev has not graded it by ${by}, the full amount is refunded.`)],
    ["posted", "graded", undefined, { due: by }, waits(60, "Jev graded the work; the verdict is being recorded.")],
    ["posted", "graded", true, { due: by }, waits(60, "Jev accepted the work; the result is being prepared.")],
    ["posted", "graded", true, { due: by, result: "https://desk/r", resultError: "HTTP 500" }, waits(60, "Jev accepted the work, but the result could not be read just now.")],
    ["posted", "graded", true, { due: by, resultText: "R" }, finished(`Jev accepted the work. The result follows this summary. The payment becomes final when the dispute window closes, ${config.terms.finalAfter} after grading.`)],
    ["posted", "graded", true, { due: by, result: "https://elsewhere/r" }, finished(`Jev accepted the work. The result is at https://elsewhere/r. The payment becomes final when the dispute window closes, ${config.terms.finalAfter} after grading.`)],
    // Rejected: the refund is still owed, and the model can still dispute, so the caller is not done. It comes back once the window has closed.
    ["posted", "graded", false, { due: by }, waits(6 * 3600 + 60, `${reject} The full amount is refunded on ${chain} when the dispute window closes at ${by}, unless the model disputes the grade and a ruling pays it. Report this now, then read the order again after that time for the refund transaction.`)],
    ["posted", "graded", false, {}, waits(900, `${reject} The full amount is refunded on ${chain} when the dispute window closes, ${config.terms.finalAfter} after grading, unless the model disputes the grade and a ruling pays it. Report this now, then read the order again after that time for the refund transaction.`)],
    ["posted", "graded", false, { due: closed }, waits(60, `${reject} The dispute window has closed, so the full amount is refunded on ${chain} shortly.`)],
    ["posted", "graded", false, { due: "soon" }, waits(900, `${reject} The full amount is refunded on ${chain} when the dispute window closes, ${config.terms.finalAfter} after grading, unless the model disputes the grade and a ruling pays it. Report this now, then read the order again after that time for the refund transaction.`)],
    ["posted", "disputed", false, { due: by }, waits(600, `The grade is disputed; Jev rules on it by ${by}. If no ruling comes, the grade stands.`)],
    // An accepted grade under dispute can still refund the caller, so a result in hand does not finish it.
    ["posted", "disputed", true, { due: by, resultText: "R" }, waits(600, `The grade is disputed; Jev rules on it by ${by}. If no ruling comes, the grade stands. The result follows this summary.`)],
    ["posted", "ruled", false, { due: by }, waits(900, `Jev ruled on the dispute. The ruling settles when its appeal window closes at ${by}, unless the side it went against appeals.`)],
    ["posted", "ruled", true, { due: by }, waits(900, `Jev ruled on the dispute. The ruling settles when its appeal window closes at ${by}, unless the side it went against appeals.`)],
    ["posted", "appealed", false, { due: by }, waits(600, `The ruling was appealed; Jev rules again by ${by}. If no second ruling comes, the first one stands.`)],
    ["posted", "appealed", true, { due: by }, waits(600, `The ruling was appealed; Jev rules again by ${by}. If no second ruling comes, the first one stands.`)],
    ["posted", "paid", true, { resultText: "R" }, finished("Jev accepted the work and the model was paid. The result follows this summary.")],
    ["posted", "paid", false, {}, finished("The model was paid.")],
    // The board has returned the money to the desk, and the payer's refund transaction has not been sent.
    ["posted", "refunded", false, { refundReason: "Jev did not accept the work." }, waits(60, `Jev did not accept the work. The refund is being sent on ${chain}.`)],
    ["posted", "refunded", undefined, {}, waits(60, `The refund is being sent on ${chain}.`)],
    // Settled days ago: past tense, and accepted only where the grade accepted it. A ruling can pay rejected work.
    ["paid-out", "paid", true, { resultText: "R" }, finished("Jev accepted the work and the model was paid. The result follows this summary.")],
    ["paid-out", "paid", true, { result: "https://desk/r", resultError: "HTTP 500" }, finished("Jev accepted the work and the model was paid.")],
    ["paid-out", "paid", false, { resultText: "R" }, finished("The model was paid. The result follows this summary.")],
    ["paid-out", "paid", false, {}, finished("The model was paid.")],
    ["paid-out", undefined, undefined, {}, finished("The model was paid.")],
    // With no task the desk could not post the order, so no work ever existed.
    ["refunding", undefined, undefined, {}, waits(60, `The task could not be posted. The refund is being sent on ${chain}.`)],
    ["refunding", "refunded", false, { refundReason: "Jev did not accept the work." }, waits(60, `Jev did not accept the work. The refund is being sent on ${chain}.`)],
    ["refunding", "refunded", undefined, { refundReason: "No model was hired before the task's deadline." }, waits(60, `No model was hired before the task's deadline. The refund is being sent on ${chain}.`)],
    ["refunded", undefined, undefined, { refundTx: "0xfeed" }, finished(`The task could not be posted. The full amount was refunded on ${chain} in 0xfeed.`)],
    ["refunded", "refunded", false, { refundReason: "Jev did not accept the work.", refundTx: "0xfeed" }, finished(`Jev did not accept the work. The full amount was refunded on ${chain} in 0xfeed.`)],
    ["refunded", "refunded", true, { refundReason: "The dispute was ruled for the poster.", refundTx: "0xfeed" }, finished(`The dispute was ruled for the poster. The full amount was refunded on ${chain} in 0xfeed.`)],
    ["refunded", "refunded", undefined, { refundReason: "Jev did not grade the work within the grading window." }, finished(`Jev did not grade the work within the grading window. The full amount was refunded on ${chain}.`)],
  ];
  it.each(TABLE)("%s, task %s, accepted %s, %j", (state, status, accepted, extra, expected) => {
    expect(read(state, status, accepted, extra)).toEqual(expected);
  });

  it("covers every status of a posted order", () => {
    for (const status of STATUSES) expect(TABLE.some(([state, listed]) => state === "posted" && listed === status)).toBe(true);
    for (const state of STATES) expect(BY_STATE.some(([listed]) => listed === state) || TABLE.some(([listed]) => listed === state)).toBe(true);
  });

  it("never claims what the order does not show, in any combination", () => {
    for (const state of STATES) {
      for (const status of STATUSES) {
        for (const accepted of [undefined, true, false]) {
          for (const extra of [{}, { resultText: "R" }, { refundReason: "Why." }, { due: by }, { due: closed }, { due: "soon" }]) {
            const { done, next, retryAfterSeconds } = read(state, status, accepted, extra);
            const at = `${state}/${status}/${accepted}/${JSON.stringify(extra)}: ${next}`;
            expect(next.length, at).toBeGreaterThan(0);
            expect(done ? retryAfterSeconds === undefined : retryAfterSeconds! > 0, at).toBe(true);
            if (next.startsWith("Jev accepted")) expect(accepted, at).toBe(true);
            if (next.includes("did not accept")) expect(accepted, at).toBe(false);
            if (/was paid/.test(next)) expect(state === "paid-out" || status === "paid", at).toBe(true);
            if (/was refunded/.test(next)) expect(state, at).toBe("refunded");
            if (next.includes("could not be posted")) expect(status, at).toBeUndefined();
            if (next.includes("result follows")) expect(extra, at).toHaveProperty("resultText");
            // Nothing is finished while a dispute, a ruling or an appeal can still move the money, or a refund is still owed.
            if (state === "posted" && ["disputed", "ruled", "appealed", "refunded"].includes(status ?? "")) expect(done, at).toBe(false);
            if (state === "posted" && status === "graded" && accepted === false) expect(done, at).toBe(false);
          }
        }
      }
    }
  });
});
