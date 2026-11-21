import { createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request, type RequestOptions } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

/** Addresses a webhook may never reach: private, loopback, link-local (cloud metadata included), shared, reserved and multicast. */
const BLOCKED = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  BLOCKED.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  // Unspecified, loopback and IPv4-compatible, and the translated form. Mapped addresses are read as IPv4 below: a mapped
  // subnet here would match every IPv4 address.
  ["::", 96],
  ["::ffff:0:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["2002::", 16],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const)
  BLOCKED.addSubnet(network, prefix, "ipv6");

/** An IPv6 address as its eight groups, whichever way it was written. */
function groups(address: string): number[] {
  let text = address.toLowerCase();
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const zeros = tail === undefined ? [] : Array<string>(8 - left.length - right.length).fill("0");
  return [...left, ...zeros, ...right].map((group) => parseInt(group, 16));
}

/**
 * The IPv4 address a mapped IPv6 one stands for, in any spelling, which is checked as that address. NAT64 and 6to4, which
 * reach IPv4 through a relay, are refused outright above.
 */
function carried(address: string): string | undefined {
  const g = groups(address);
  if (!g.slice(0, 5).every((group) => group === 0) || g[5] !== 0xffff) return undefined;
  return [g[6]! >> 8, g[6]! & 255, g[7]! >> 8, g[7]! & 255].join(".");
}

export function publicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !BLOCKED.check(address, "ipv4");
  if (family !== 6 || BLOCKED.check(address, "ipv6")) return false;
  const inner = carried(address);
  return inner ? !BLOCKED.check(inner, "ipv4") : true;
}

/** Host names that only ever mean this machine or its network. */
const LOCAL_NAME = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain)$/i;

/** A failure written for whoever set up the watch; it names no address and no part of the URL past the host. */
export class DeliveryError extends Error {}

/** The webhook URL, checked: https on the default port, no user name or password, and a host that is not this network's. */
export function webhookUrl(given: string): URL {
  if (given.length > 2048) throw new DeliveryError("url is longer than 2,048 characters.");
  let url: URL;
  try {
    url = new URL(given);
  } catch {
    throw new DeliveryError("url is not a URL.");
  }
  if (url.protocol !== "https:") throw new DeliveryError("url must start with https://.");
  if (url.username || url.password) throw new DeliveryError("url must not hold a user name or password.");
  if (url.port && url.port !== "443") throw new DeliveryError("url must use the default https port, 443.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host || LOCAL_NAME.test(host) || (!host.includes(".") && !isIP(host))) throw new DeliveryError("url must name a public host.");
  if (isIP(host) && !publicAddress(host)) throw new DeliveryError("url points at a private, loopback or reserved address.");
  return url;
}

export type Resolve = (host: string) => Promise<{ address: string; family: number }[]>;
const resolveAll: Resolve = (host) => lookup(host, { all: true, verbatim: true });

/**
 * Where a host resolves, checked: every address it gives must be public, or none is used, since a name that gives one
 * private address can be made to give it first.
 */
export async function publicTarget(host: string, resolve: Resolve = resolveAll): Promise<{ address: string; family: number }> {
  const bare = host.replace(/^\[|\]$/g, "");
  const family = isIP(bare);
  const found = family ? [{ address: bare, family }] : await resolve(bare).catch(() => []);
  if (found.length === 0) throw new DeliveryError(`${bare} does not resolve.`);
  if (found.some(({ address }) => !publicAddress(address))) throw new DeliveryError(`${bare} resolves to a private, loopback or reserved address.`);
  return found[0]!;
}

export interface Sent {
  status: number;
  /** The start of the answer, for a failure's message. */
  body: string;
  /** The answer's rate-limit and routing headers, lower-cased: `ANSWER_HEADERS` only. */
  headers?: Record<string, string>;
}

/** What is kept of an answer's headers: how long to wait, and enough to tell Discord's own limits from its CDN's. */
const ANSWER_HEADERS = /^(?:retry-after|x-ratelimit-[\w-]+|content-type|server|via|cf-ray|cf-mitigated)$/;

export function answerHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers)
      .filter(([name, value]) => ANSWER_HEADERS.test(name.toLowerCase()) && value !== undefined)
      .map(([name, value]) => [name.toLowerCase(), (Array.isArray(value) ? value.join(", ") : value!).slice(0, 200)]),
  );
}

/** A lookup that answers with the checked address alone, in whichever form the socket asks for it. */
const pinned =
  (target: { address: string; family: number }): LookupFunction =>
  (_host, options, callback) => {
    if (options.all) callback(null, [target]);
    else callback(null, target.address, target.family);
  };

export const SEND_MS = 10_000;
const MAX_ANSWER = 16 * 1024;

export type Post = (url: URL, body: string, headers: Record<string, string>) => Promise<Sent>;

/**
 * Posts `body` to `url` over https at the address `publicTarget` checked, so a name that resolves somewhere else a moment
 * later is never followed. Redirects are not followed: a 3xx is the answer. The answer is read up to 16 KB.
 */
export function pinnedPost(resolve: Resolve = resolveAll): Post {
  return async (url, body, headers) => {
    const target = await publicTarget(url.hostname, resolve);
    return new Promise<Sent>((done, fail) => {
      const host = url.hostname.replace(/^\[|\]$/g, "");
      const options: RequestOptions = {
        host,
        port: 443,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers: { ...headers, "Content-Length": Buffer.byteLength(body).toString() },
        timeout: SEND_MS,
        lookup: pinned(target),
        ...(isIP(host) ? {} : { servername: host }),
      };
      const sent = request(
        options,
        (answer) => {
          const chunks: Buffer[] = [];
          let size = 0;
          answer.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size <= MAX_ANSWER) chunks.push(chunk);
            else answer.destroy();
          });
          const finish = () => done({ status: answer.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8").slice(0, 300), headers: answerHeaders(answer.headers) });
          answer.on("end", finish);
          answer.on("close", finish);
        },
      );
      // The socket's timeout restarts with every byte, so a slow answer is also cut at one deadline for the whole delivery.
      const late = () => sent.destroy(new DeliveryError(`${url.hostname} did not answer within ${SEND_MS / 1000} seconds.`));
      const deadline = setTimeout(late, SEND_MS);
      sent.on("close", () => clearTimeout(deadline));
      sent.on("timeout", late);
      sent.on("error", (error) => fail(error instanceof DeliveryError ? error : new DeliveryError(`${url.hostname} could not be reached.`)));
      sent.end(body);
    });
  };
}

export interface Relay {
  url: URL;
  /** Signs each relayed post; the relay holds the same key and refuses a post it does not sign. */
  key: string;
}

const DISCORD_HOST = /^(?:ptb\.|canary\.)?discord(?:app)?\.com$/i;

/**
 * Sends Discord posts through a relay on another network, for when Discord refuses the watcher's own address. The relay
 * gets the webhook's path and query in `X-Relay-Target`, never in its own URL, and `X-Relay-Signature`: `v1=` and the hex
 * HMAC-SHA256, keyed with the relay's key, of the timestamp, a full stop, the target, a full stop and the body. It answers
 * with Discord's status, rate-limit headers and body. Every other post goes straight.
 */
export function relayed(post: Post, relay: Relay, clock: () => number = Date.now): Post {
  return (url, body, headers) => {
    if (!DISCORD_HOST.test(url.hostname)) return post(url, body, headers);
    const target = `${url.pathname}${url.search}`;
    const timestamp = String(Math.floor(clock() / 1000));
    const signature = createHmac("sha256", relay.key).update(`${timestamp}.${target}.${body}`).digest("hex");
    return post(relay.url, body, { ...headers, "X-Relay-Target": target, "X-Relay-Timestamp": timestamp, "X-Relay-Signature": `v1=${signature}` });
  };
}
