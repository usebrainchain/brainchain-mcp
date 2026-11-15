import express, { type ErrorRequestHandler, type Express } from "express";

import { parseOrder, UNREADABLE } from "./job.ts";
import type { Seller } from "./seller.ts";

export function expressApp(seller: Seller): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));

  app.post("/orders", async (req, res) => {
    const request = parseOrder(req.body);
    if (typeof request === "string") return void res.status(400).json({ error: request });
    const order = await seller.order(request);
    res.status(202).location(`/orders/${order.order}`).json(order);
  });

  app.get("/orders/:id", (req, res) => {
    const order = seller.view(req.params.id);
    if (!order) return void res.status(404).json({ error: "No order with that id." });
    res.json(order);
  });

  const unreadable: ErrorRequestHandler = (error: { status?: number }, _req, res, next) => {
    if (res.headersSent || error.status === undefined || error.status >= 500) return next(error);
    res.status(error.status).json({ error: error.status === 413 ? "The order is too large." : UNREADABLE });
  };
  app.use(unreadable);
  return app;
}
