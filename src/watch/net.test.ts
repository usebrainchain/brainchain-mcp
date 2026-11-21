import { describe, expect, it } from "vitest";

import { createHmac } from "node:crypto";

import { answerHeaders, DeliveryError, pinnedPost, publicAddress, publicTarget, relayed, webhookUrl, type Post, type Resolve } from "./net.js";

describe("an address a webhook may reach", () => {
  it("is public, never private, loopback, link-local, metadata, shared, reserved or multicast", () => {
    for (const address of ["10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "127.0.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1"])
      expect(publicAddress(address), address).toBe(false);
    for (const address of ["::1", "::", "fe80::1", "fd00:ec2::254", "fc00::1", "ff02::1", "2001:db8::1"]) expect(publicAddress(address), address).toBe(false);
    // A mapped IPv6 address is weighed as the IPv4 address it stands for, however it is written; IPv4-compatible, NAT64 and 6to4 ones are refused.
    for (const address of ["::ffff:127.0.0.1", "::ffff:7f00:1", "0:0:0:0:0:ffff:7f00:1", "::ffff:169.254.169.254", "::127.0.0.1", "64:ff9b::10.0.0.1", "64:ff9b::808:808", "64:ff9b:1::1", "2002:a00:1::1", "2002:808:808::", "::ffff:0:7f00:1"])
      expect(publicAddress(address), address).toBe(false);
    for (const address of ["8.8.8.8", "162.159.135.232", "2606:4700::6810:84e5", "::ffff:8.8.8.8", "0:0:0:0:0:ffff:808:808"]) expect(publicAddress(address), address).toBe(true);
    expect(publicAddress("not an address")).toBe(false);
  });
});

describe("a webhook url", () => {
  it("is https on the default port, on a public host, with no user name or password", () => {
    expect(webhookUrl("https://hooks.example.com/brainchain?x=1").href).toBe("https://hooks.example.com/brainchain?x=1");
    for (const [url, error] of [
      ["http://hooks.example.com/x", "url must start with https://."],
      ["ftp://hooks.example.com/x", "url must start with https://."],
      ["https://user:pass@hooks.example.com/x", "url must not hold a user name or password."],
      ["https://hooks.example.com:8443/x", "url must use the default https port, 443."],
      ["https://localhost/x", "url must name a public host."],
      ["https://metadata.google.internal/x", "url must name a public host."],
      ["https://intranet/x", "url must name a public host."],
      ["https://192.168.0.10/x", "url points at a private, loopback or reserved address."],
      ["https://[::1]/x", "url points at a private, loopback or reserved address."],
      ["https://169.254.169.254/latest/meta-data", "url points at a private, loopback or reserved address."],
      ["not a url", "url is not a URL."],
    ])
      expect(() => webhookUrl(url!), url).toThrow(error);
  });
});

const resolving =
  (table: Record<string, string[]>): Resolve =>
  async (host) =>
    (table[host] ?? []).map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

describe("a webhook's host", () => {
  it("resolves only to public addresses, or is refused before anything is sent", async () => {
    const resolve = resolving({ "hooks.example.com": ["93.184.215.14"], "rebind.example.com": ["93.184.215.14", "10.0.0.5"], "v6.example.com": ["fd12::1"] });
    expect(await publicTarget("hooks.example.com", resolve)).toEqual({ address: "93.184.215.14", family: 4 });
    // One private address among public ones is enough to refuse it: a resolver can be made to give it first.
    await expect(publicTarget("rebind.example.com", resolve)).rejects.toThrow("rebind.example.com resolves to a private, loopback or reserved address.");
    await expect(publicTarget("v6.example.com", resolve)).rejects.toThrow(DeliveryError);
    await expect(publicTarget("nowhere.example.com", resolve)).rejects.toThrow("nowhere.example.com does not resolve.");
  });

  it("is checked again at each delivery, so a name that now resolves somewhere private is not posted to", async () => {
    const post = pinnedPost(resolving({ "hooks.example.com": ["127.0.0.1"] }));
    await expect(post(new URL("https://hooks.example.com/x"), "{}", {})).rejects.toThrow("hooks.example.com resolves to a private, loopback or reserved address.");
  });
});

describe("an answer's headers", () => {
  it("keep the rate limit and where the answer came from, and nothing else", () => {
    expect(answerHeaders({ "Retry-After": "2", "X-RateLimit-Reset-After": "1.5", "x-ratelimit-global": "true", "set-cookie": ["a=b"], "cf-ray": "a5e1-CMH", authorization: "x" })).toEqual({ "retry-after": "2", "x-ratelimit-reset-after": "1.5", "x-ratelimit-global": "true", "cf-ray": "a5e1-CMH" });
  });
});

describe("a Discord relay", () => {
  const key = "k".repeat(40);
  const sent: { url: string; headers: Record<string, string> }[] = [];
  const post: Post = async (url, _body, headers) => (sent.push({ url: url.href, headers }), { status: 204, body: "" });
  const via = relayed(post, { url: new URL("https://relay.example.workers.dev/"), key }, () => 1_795_000_000_000);

  it("takes Discord posts, signed, with the webhook's path in a header and never in the relay's URL", async () => {
    await via(new URL("https://discord.com/api/webhooks/123/abc?thread_id=9"), '{"content":"x"}', { "Content-Type": "application/json" });
    const [one] = sent.splice(0);
    expect(one!.url).toBe("https://relay.example.workers.dev/");
    expect(one!.headers).toMatchObject({ "Content-Type": "application/json", "X-Relay-Target": "/api/webhooks/123/abc?thread_id=9", "X-Relay-Timestamp": "1795000000" });
    expect(one!.headers["X-Relay-Signature"]).toBe(`v1=${createHmac("sha256", key).update('1795000000./api/webhooks/123/abc?thread_id=9.{"content":"x"}').digest("hex")}`);
  });

  it("leaves every other post alone", async () => {
    await via(new URL("https://hooks.slack.com/services/T/B/X"), "{}", {});
    expect(sent.splice(0)).toEqual([{ url: "https://hooks.slack.com/services/T/B/X", headers: {} }]);
  });
});
