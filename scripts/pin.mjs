// Moves every pinned brainchain-mcp in the repository to package.json's version, the pins inside install links too.
// `npm version <new>` runs it once package.json and package-lock.json hold the new version; src/pins.test.ts fails on
// any pin it would still change.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PIN = /brainchain-mcp@\d+\.\d+\.\d+(?:-[\w.]*\w)?/g;

/** Cursor's links carry their settings as base64 JSON, VS Code's as URL-encoded JSON. */
function pinLinks(text, version) {
  return text.replace(/([?&]config=)([\w%+/=.-]+)/g, (whole, key, value) => {
    const raw = decodeURIComponent(value);
    if (raw.startsWith("{")) return key + encodeURIComponent(raw.replace(PIN, `brainchain-mcp@${version}`));
    const settings = Buffer.from(raw, "base64").toString("utf8");
    if (!settings.startsWith("{")) return whole;
    const pinned = Buffer.from(settings.replace(PIN, `brainchain-mcp@${version}`)).toString("base64");
    return key + (value.includes("%") ? encodeURIComponent(pinned) : pinned);
  });
}

export function pin(text, version) {
  return pinLinks(text.replace(PIN, `brainchain-mcp@${version}`), version);
}

/** server.json names the version twice, for itself and for the npm package; the Cursor plugin once. */
const MANIFESTS = ["server.json", ".cursor-plugin/plugin.json"];

function files(root, dir = root) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if ([".git", "node_modules", "dist"].includes(entry.name) || entry.name.endsWith(".test.ts") || entry.name === "package-lock.json") return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(root, path) : [relative(root, path).split(sep).join("/")];
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  for (const file of files(root)) {
    const path = join(root, file);
    const text = readFileSync(path, "utf8");
    let next = pin(text, version);
    if (MANIFESTS.includes(file)) next = next.replace(/("version":\s*")[^"]+"/g, `$1${version}"`);
    if (next === text) continue;
    writeFileSync(path, next);
    console.log(`pinned ${file} to ${version}`);
  }
}
