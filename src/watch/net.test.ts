import { describe, expect, it } from "vitest";

import { DeliveryError, pinnedPost, publicAddress, publicTarget, webhookUrl, type Resolve } from "./net.js";

describe("an address a webhook may reach", () => {
  it("is public, never private, loopback, link-local, metadata, shared, reserved or multicast", () => {
    for (const address of ["10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "127.0.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1"])
      expect(publicAddress(address), address).toBe(false);
    for (const address of ["::1", "::", "fe80::1", "fd00:ec2::254", "fc00::1", "ff02::1", "2001:db8::1"]) expect(publicAddress(address), address).toBe(false);
    // An IPv6 address that carries an IPv4 one reaches it, so it is weighed as that address.
    for (const address of ["::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::10.0.0.1", "2002:a00:1::1", "::ffff:169.254.169.254"]) expect(publicAddress(address), address).toBe(false);
    for (const address of ["8.8.8.8", "162.159.135.232", "2606:4700::6810:84e5", "::ffff:8.8.8.8"]) expect(publicAddress(address), address).toBe(true);
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
