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
/** Cursor's install links carry their settings as base64 JSON, VS Code's as URL-encoded JSON. */
const settingsOf = (config: string) => {
  const raw = decodeURIComponent(config);
  return raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
};

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

  it("is this package's, or the newest release, inside the install links", () => {
    const links = all.flatMap((file) => [...read(file).matchAll(/[?&]config=([\w%+/=.-]+)/g)].map(([, config]) => settingsOf(config!)));
    expect(links.filter((settings) => settings.startsWith("{")).length).toBeGreaterThan(2);
    for (const settings of links) {
      expect(JSON.parse(settings)).toMatchObject({ command: "npx", args: expect.arrayContaining([expect.stringMatching(/^brainchain-mcp(@|$)/)]) });
      expect(pinsIn(settings).filter((pinned) => pinned !== version)).toEqual([]);
    }
  });

  it("moves with npm version: scripts/pin.mjs leaves nothing pinned elsewhere, inside links too", async () => {
    const { pin } = (await import("../scripts/pin.mjs")) as { pin: (text: string, version: string) => string };
    expect((json("package.json").scripts as Record<string, string>).version).toBe("node scripts/pin.mjs");
    const cursor = (config: string) => `https://cursor.com/en/install-mcp?name=brainchain&config=${encodeURIComponent(Buffer.from(config).toString("base64"))}`;
    const code = (config: string) => `https://vscode.dev/redirect/mcp/install?name=brainchain&config=${encodeURIComponent(config)}`;
    const old = '{"command":"npx","args":["-y","brainchain-mcp@0.1.0"]}';
    const latest = '{"command":"npx","args":["-y","brainchain-mcp"]}';
    const text = [`npx -y brainchain-mcp@0.1.0`, cursor(old), code(old), cursor(latest), code(latest)].join("\n");
    const moved = pin(text, "9.8.7").split("\n");
    expect(moved.slice(0, 3).map((line) => pinsIn(line.includes("config=") ? settingsOf(line.split("config=")[1]!) : line))).toEqual([["9.8.7"], ["9.8.7"], ["9.8.7"]]);
    expect(moved.slice(3)).toEqual([cursor(latest), code(latest)]);
    for (const file of all) expect(pin(read(file), version), file).toBe(read(file));
  });
});

describe("the settings each file lists", () => {
  it("are the same in the README's table, in server.json and in --help", () => {
    const table = read("README.md").split("\n## Configuration\n")[1]!.split("\n## ")[0]!;
    const setting = /BRAINCHAIN_[A-Z_]+|GITHUB_TOKEN/g;
    const documented = table.split("\n").flatMap((row) => (/^\| `(BRAINCHAIN_|GITHUB_TOKEN)/.test(row) ? (row.split(" | ")[0]!.match(setting) ?? []) : []));
    const server = json("server.json") as { packages: { environmentVariables: { name: string }[] }[] };
    const listed = server.packages[0]!.environmentVariables.map((variable) => variable.name);
    const usage = read("src/index.ts").split("\nEnvironment:\n")[1]!.split("`;")[0]!;
    const helped = usage.split("\n").flatMap((line) => (/^ {2}(BRAINCHAIN_|GITHUB_TOKEN)/.test(line) ? (line.match(setting) ?? []) : []));
    expect(documented).toHaveLength(18);
    expect([...listed].sort()).toEqual([...documented].sort());
    expect([...helped].sort()).toEqual([...documented].sort());
  });
});
