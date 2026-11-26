import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage, ServerResponse } from "node:http";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { BUILDER_NAME } from "./builder.js";
import { CALLS_NAME } from "./calls.js";
import { CHANGES_NAME, UNWATCH_NAME, WATCH_NAME } from "./changes.js";
import { CUSTODY_NAME } from "./custody.js";
import { MAKERS_NAME } from "./makers.js";
import { MARKET_CAP_NAME } from "./marketcap.js";
import { TRACE_OUTCOMES_NAME } from "./outcomes.js";
import { PREMIUMS_NAME } from "./premiums.js";
import { READINESS_NAME } from "./readiness.js";
import { wire } from "./server.js";
import { SIGHTINGS_NAME } from "./sightings.js";
import { TIMELINE_NAME } from "./timeline.js";
import { AGENT_RECORD_NAME, EXAM_INFO_NAME, GET_GRADE_NAME, GET_TASK_NAME, LICENCES_NAME, reply } from "./tools.js";

/**
 * The tools that need no wallet and no file on the machine: public reads, reading a task or grade by its id, and watches.
 * Every tool that pays or signs is left out, and so are bond_status and exam_status, which read this wallet's own.
 */
export const HOSTED_TOOLS: ReadonlySet<string> = new Set([
  GET_TASK_NAME,
  GET_GRADE_NAME,
  PREMIUMS_NAME,
  CUSTODY_NAME,
  MAKERS_NAME,
  READINESS_NAME,
  SIGHTINGS_NAME,
  TIMELINE_NAME,
  MARKET_CAP_NAME,
  BUILDER_NAME,
  TRACE_OUTCOMES_NAME,
  CALLS_NAME,
  CHANGES_NAME,
  WATCH_NAME,
  UNWATCH_NAME,
  EXAM_INFO_NAME,
  LICENCES_NAME,
  AGENT_RECORD_NAME,
]);

export const hostedInstructions = (version: string) =>
  `This is the hosted BrainChain MCP: it reads public data on Robinhood Chain tokens and BrainChain's tasks, grades and agent records, and sets up watches, with no key. ` +
  `Hiring a model and grading work pay from a wallet that the local package keeps on your operator's machine, set up with \`npx -y brainchain-mcp@${version} init\`. ` +
  `For two free grades without a wallet, your operator runs \`npx -y brainchain-mcp@${version} login\` and adds the local server with the line it prints.`;

/** Each upstream request a hosted tool makes ends after this long. */
export const UPSTREAM_MS = 30_000;
/** A tool call that has not answered by then is answered with an error, whatever is still in flight. */
export const CALL_MS = 50_000;

/** The watcher's own address over loopback for the tools' reads of it, and the headers that count each read against the caller. */
export interface Via {
  url: URL;
  headers: Record<string, string>;
}

export type McpHandler = (request: IncomingMessage, response: ServerResponse, body: unknown, via: Via) => Promise<void>;

/**
 * The hosted endpoint at `POST /mcp`, stateless: each request gets its own server and transport, and answers in JSON.
 * The tools are wired once, with no key, no sign-in and no setting of the watcher's, so none can reach the sponsor,
 * the free-check counts, the watcher's RPC or its tokens. `publicUrl` is the address replies give for the watcher, such
 * as https://watch.usebrainchain.com behind a proxy; the tools' reads of it still go over loopback.
 */
export function hostedMcp(version: string, options: { fetch?: typeof fetch; log?: (line: string) => void; publicUrl?: URL } = {}): McpHandler {
  const caller = new AsyncLocalStorage<Via>();
  const base = options.fetch ?? fetch;
  let local: URL | undefined;
  // Reads of the watcher go to it over loopback with the caller's headers, so its per-address limits count the caller.
  const reach = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const signal = init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(UPSTREAM_MS)]) : AbortSignal.timeout(UPSTREAM_MS);
    const shown = options.publicUrl ?? local;
    if (!local || !shown || url.origin !== shown.origin) return base(input, { ...init, signal });
    const target = new URL(`${url.pathname}${url.search}`, local);
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
    for (const [name, value] of Object.entries(caller.getStore()?.headers ?? {})) headers.set(name, value);
    return base(input instanceof Request ? new Request(target, input) : target, { ...init, headers, signal });
  }) as typeof fetch;

  let wired: ReturnType<typeof wire> | undefined;
  let tools: ReturnType<typeof wire>["tools"] = [];
  const log = options.log ?? (() => {});
  return async (incoming, response, body, via) => {
    if (!wired) {
      local = via.url;
      wired = wire({ BRAINCHAIN_WATCH_URL: (options.publicUrl ?? via.url).href }, version, { fetch: reach, login: () => undefined, walletSaved: () => false, log }, true);
      tools = wired.tools.filter((tool) => HOSTED_TOOLS.has(tool.name));
    }
    const { call } = wired;
    const server = new Server({ name: "brainchain", title: "BrainChain", version }, { capabilities: { tools: {} }, instructions: hostedInstructions(version) });
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      if (!HOSTED_TOOLS.has(name)) return reply({ error: `Unknown tool: ${name}. The hosted BrainChain MCP has no tool that pays or signs; those need the local package, brainchain-mcp.` }, true);
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<CallToolResult>((resolve) => {
        timer = setTimeout(() => resolve(reply({ error: `${name} took longer than ${CALL_MS / 1000} seconds to answer. Try again in a minute.` }, true)), CALL_MS);
      });
      try {
        return await Promise.race([call(name, args), late]);
      } finally {
        clearTimeout(timer);
      }
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await caller.run(via, () => transport.handleRequest(incoming, response, body));
  };
}
