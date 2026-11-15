import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import { parseOrder } from "./job.ts";
import type { Seller } from "./seller.ts";

export function honoApp(seller: Seller): Hono {
  const app = new Hono();

  app.post("/orders", bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.json({ error: "The order is too large." }, 413) }), async (c) => {
    const request = parseOrder(await c.req.json().catch(() => undefined));
    if (typeof request === "string") return c.json({ error: request }, 400);
    const order = await seller.order(request);
    return c.json(order, 202, { location: `/orders/${order.order}` });
  });

  app.get("/orders/:id", (c) => {
    const order = seller.view(c.req.param("id"));
    return order ? c.json(order) : c.json({ error: "No order with that id." }, 404);
  });

  return app;
}
