import { expect, vi } from "vitest";

import { GRADE_PAYMENT, gradeId } from "../src/desk.ts";

export const base = { scheme: "exact", network: GRADE_PAYMENT.network, amount: "250000", asset: GRADE_PAYMENT.asset, payTo: GRADE_PAYMENT.payTo, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } };

export const offer = (desk: string, accept: Record<string, unknown> = base) =>
  new Response("{}", { status: 402, headers: { "payment-required": Buffer.from(JSON.stringify({ x402Version: 2, resource: { url: `${desk}/x402/grades` }, accepts: [accept] })).toString("base64") } });

export const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

/**
 * A desk that offers a grade, answers the paid request with `paid`, each read of the grade with the next of `reads`,
 * and any other URL with `other`.
 */
export function mockDesk(desk: string, paid: (id: string) => Response | Error, reads: ((id: string) => Response)[] = [], other?: (url: string) => Promise<Response>) {
  let id = "";
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const header = (init.headers as Record<string, string>)["PAYMENT-SIGNATURE"];
      if (!header) return offer(desk);
      id = gradeId(JSON.parse(Buffer.from(header, "base64").toString("utf8")).payload);
      const reply = paid(id);
      if (reply instanceof Error) throw reply;
      return reply;
    }
    if (other && !url.startsWith(`${desk}/x402/grades/`)) return other(url);
    expect(url).toBe(`${desk}/x402/grades/${id}`);
    return (reads.shift() ?? (() => answer(404, { error: "No grade with that id." })))(id);
  });
}
