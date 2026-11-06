import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");
const json = (path: string) => JSON.parse(read(path)) as Record<string, unknown>;
const { version } = json("package.json") as { version: string };
const PIN = /brainchain-mcp@(\d+\.\d+\.\d+(?:-[\w.]*\w)?)/g;
const pinsIn = (text: string) => [...text.matchAll(PIN)].map(([, pinned]) => pinned);

/** Every file of the repository but what is installed or built, and the tests, which name made-up releases. */
function files(dir = root): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if ([".git", "node_modules", "dist"].includes(entry.name) || entry.name.endsWith(".test.ts")) return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : [relative(root, path).split(sep).join("/")];
  });
}

// Nothing else reads the pins outside the package, such as mcp.json and the Cursor plugin, so a release could leave them behind.
describe("the release each file names", () => {
  const all = files();

  it("is this package's wherever a file pins brainchain-mcp to a version", () => {
    const pins = all.flatMap((file) => pinsIn(read(file)).map((pinned) => ({ file, pinned })));
    expect(pins.filter(({ pinned }) => pinned !== version)).toEqual([]);
    expect(pins.map(({ file }) => file)).toEqual(expect.arrayContaining(["README.md", "mcp.json", "examples/openclaw/brainchain/SKILL.md"]));
  });

  it("is this package's in every manifest", () => {
    const manifests = all.filter((file) => file.endsWith(".json") && file !== "package-lock.json");
    expect(manifests).toEqual(expect.arrayContaining(["server.json", ".cursor-plugin/plugin.json"]));
    for (const file of manifests) expect(json(file).version ?? version, file).toBe(version);
    const server = json("server.json") as { packages: { identifier: string; version: string }[] };
    expect(server.packages.map((listed) => [listed.identifier, listed.version])).toEqual([["brainchain-mcp", version]]);
    const lock = json("package-lock.json") as { version: string; packages: Record<string, { version: string }> };
    expect([lock.version, lock.packages[""]!.version]).toEqual([version, version]);
  });

  it("is this package's inside the install links, whose settings are base64", () => {
    const links = all.flatMap((file) => [...read(file).matchAll(/[?&]config=([\w%+/=-]+)/g)].map(([, config]) => Buffer.from(decodeURIComponent(config!), "base64").toString("utf8")));
    expect(links.length).toBeGreaterThan(0);
    expect(links.map(pinsIn)).toEqual(links.map(() => [version]));
  });
});
