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
  ["::", 128],
  ["::1", 128],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const)
  BLOCKED.addSubnet(network, prefix, "ipv6");

/** The IPv4 address an IPv6 one carries: mapped, NAT64 or 6to4. Each reaches that IPv4 address, so it is checked as one. */
function carried(address: string): string | undefined {
  const lower = address.toLowerCase();
  const dotted = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower)?.[1];
  if (dotted) return dotted;
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  const sixToFour = /^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/.exec(lower);
  const parts = hex ?? sixToFour;
  if (!parts) return undefined;
  const [high, low] = [parseInt(parts[1]!, 16), parseInt(parts[2]!, 16)];
  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}

export function publicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !BLOCKED.check(address, "ipv4");
  if (family !== 6) return false;
  const inner = carried(address);
  if (inner) return !BLOCKED.check(inner, "ipv4");
  return !BLOCKED.check(address, "ipv6");
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
          const finish = () => done({ status: answer.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8").slice(0, 300) });
          answer.on("end", finish);
          answer.on("close", finish);
        },
      );
      sent.on("timeout", () => sent.destroy(new DeliveryError(`${url.hostname} did not answer within ${SEND_MS / 1000} seconds.`)));
      sent.on("error", (error) => fail(error instanceof DeliveryError ? error : new DeliveryError(`${url.hostname} could not be reached.`)));
      sent.end(body);
    });
  };
}
