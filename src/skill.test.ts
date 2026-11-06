import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const skill = read("examples/openclaw/brainchain/SKILL.md");
const readme = read("README.md");
const { version } = JSON.parse(read("package.json")) as { version: string };
const [, front = "", body = ""] = skill.split(/^---$/m);
// The frontmatter's metadata is JSON5: JSON with trailing commas.
const metadata = (JSON.parse(front.slice(front.indexOf("{")).replace(/,(\s*[}\]])/g, "$1")) as { openclaw: unknown }).openclaw as {
  primaryEnv?: string;
  requires: { bins: string[]; config: string[]; env?: string[] };
  envVars: { name: string; required: boolean; description: string }[];
};
const server = /openclaw mcp set brainchain '(\{.*\})'/.exec(body)?.[1];

// `clawhub scan <dir>` is gone and `skill publish --dry-run` validates nothing, so what a scan compares is checked here before publishing.
describe("the OpenClaw skill", () => {
  it("declares every environment variable it names, and only ones the server reads", () => {
    const named = new Set(skill.match(/BRAINCHAIN_[A-Z]+[A-Z_]*/g));
    expect(new Set(metadata.envVars.map((v) => v.name))).toEqual(named);
    for (const { name, description } of metadata.envVars) {
      expect(description.length, name).toBeGreaterThan(0);
      expect(readme, name).toContain(`\`${name}\``);
    }
  });

  it("declares every program it runs", () => {
    const run = new Set(body.match(/(?<![./\w-])(npx|node|python3|openclaw|clawhub|curl|cast|jq|docker)(?= )/g));
    expect(new Set(metadata.requires.bins)).toEqual(run);
  });

  it("reads Ready only once the server is registered with a key file, and never steers the key into skills.entries", () => {
    expect(metadata.primaryEnv).toBeUndefined();
    expect(metadata.requires.env).toBeUndefined();
    expect(metadata.requires.config).toEqual(["mcp.servers.brainchain.env.BRAINCHAIN_PAYER_KEY_FILE"]);
    expect((JSON.parse(server!) as { env: Record<string, string> }).env).toHaveProperty("BRAINCHAIN_PAYER_KEY_FILE");
    expect(server).not.toContain("BRAINCHAIN_PAYER_KEY\"");
  });

  it("checks the wallet on the chain the server is registered to pay on", () => {
    const { BRAINCHAIN_PAY_ON: payOn, BRAINCHAIN_PAYER_KEY_FILE: keyFile } = (JSON.parse(server!) as { env: Record<string, string> }).env;
    expect(payOn).toBe("base");
    expect(body).toContain(`BRAINCHAIN_PAY_ON=${payOn} BRAINCHAIN_PAYER_KEY_FILE=${keyFile} npx -y brainchain-mcp@${version} wallet`);
  });

  it("fences as bash every block that reads a key without echo, which plain sh cannot do", () => {
    for (const text of [skill, readme]) {
      const blocks = [...text.matchAll(/```(\w*)\n([\s\S]*?)```/g)].filter(([, , code]) => code!.includes("read -rs"));
      expect(blocks.length).toBeGreaterThan(0);
      expect(blocks.map(([, fence]) => fence)).toEqual(blocks.map(() => "bash"));
    }
  });

  it("tells the agent to stop when its tools are missing, and to leave the key alone", () => {
    expect(body).toContain("is not among your tools");
    expect(body).toContain("Never open the key file");
  });

  it("says the paying wallet cannot dispute", () => {
    for (const text of [body, readme]) expect(text).toContain("The wallet that paid cannot dispute a grade.");
    expect(body).not.toMatch(/poster can dispute|grade can be disputed/i);
  });

  it("installs the release this package is", () => {
    for (const text of [skill, readme]) for (const [, pinned] of text.matchAll(/brainchain-mcp@(\d+\.\d+\.\d+)/g)) expect(pinned).toBe(version);
  });
});
