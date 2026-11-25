import { describe, expect, it } from "vitest";

import { callTool, checkBrief, checkGrade, GRADE_NAME, POST_TASK_NAME, type Desk } from "./tools.js";

// Joined at run time so no scanner reads these fixtures as live credentials.
const word = (...parts: string[]) => parts.join("");
const CREDENTIALS: [string, string][] = [
  ["a private key", word("-----BEGIN ", "RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----")],
  ["a private key", word("-----BEGIN ", "PRIVATE KEY-----")],
  ["an AWS access key id", word("AKIA", "IOSFODNN7EXAMPLE")],
  ["an AWS access key id", word("ASIA", "Y34FZKBOKMUTVV7A")],
  ["a GitHub token", word("ghp", "_", "a".repeat(36))],
  ["a GitHub token", word("github", "_pat_", "11AAAAAAA0", "b".repeat(30))],
  ["an OpenAI or Anthropic API key", word("sk-", "proj-", "Ab1_".repeat(10))],
  ["an OpenAI or Anthropic API key", word("sk-", "ant-api03-", "c".repeat(40))],
  ["a Slack token", word("xox", "b-", "1234567890-abcdef")],
  ["a Stripe live key", word("sk", "_live_", "d".repeat(24))],
  ["a Stripe live key", word("rk", "_live_", "e".repeat(24))],
];
const NEAR_MISSES = [
  "-----BEGIN PUBLIC KEY-----",
  "-----BEGIN CERTIFICATE-----",
  "AWS access key ids start with AKIA and run to 20 characters.",
  word("AKIA", "SHORT"),
  word("X", "AKIA", "IOSFODNN7EXAMPLE"),
  "Store it in a ghp_ token, never in the brief.",
  word("ghp", "_short"),
  "pip install scikit-learn, imported as sklearn; see sk-learn.",
  "a risk-free-and-fully-documented-migration-plan",
  word("xox", "b-short"),
  word("sk", "_test_", "4eC39HqLyjWDarjtT1zdp7dc"),
  word("sk", "_live_", "short"),
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
];
const refusal = (field: string, kind: string) =>
  `${field} contains ${kind}. Briefs and results are published and cannot be withdrawn, so nothing was sent: nothing was paid and no free check was used. Remove or replace it, then send again.`;

describe("a request that carries a credential", () => {
  it("is refused in the brief and in the result, naming the field and the kind but not the credential", () => {
    for (const [kind, credential] of CREDENTIALS) {
      for (const field of ["brief", "result"] as const) {
        const request = { brief: "Summarise the config.", result: "Done.", [field]: `The config:\n${credential}\nThat is all.` };
        expect(() => checkGrade(request)).toThrow(refusal(field, kind));
        try {
          checkGrade(request);
        } catch (error) {
          expect((error as Error).message).not.toContain(credential);
        }
      }
    }
  });

  it("is refused in a task's title, brief or levels, and in a grade's title or levels", () => {
    const key = word("AKIA", "IOSFODNN7EXAMPLE");
    const task = { title: "Rotate keys", brief: "Rotate the keys.", levels: ["All rotated", "Some missed"] };
    expect(() => checkBrief({ ...task, title: `Rotate ${key}` })).toThrow(refusal("title", "an AWS access key id"));
    expect(() => checkBrief({ ...task, brief: `Rotate ${key}.` })).toThrow(refusal("brief", "an AWS access key id"));
    expect(() => checkBrief({ ...task, levels: ["All rotated", `Kept ${key}`] })).toThrow(refusal("levels[1]", "an AWS access key id"));
    expect(() => checkGrade({ brief: "b", result: "r", title: key })).toThrow(refusal("title", "an AWS access key id"));
    expect(() => checkGrade({ brief: "b", result: "r", levels: [key, "Wrong"] })).toThrow(refusal("levels[0]", "an AWS access key id"));
  });

  it("passes when the text only resembles one", () => {
    for (const text of NEAR_MISSES) expect(checkGrade({ brief: text, result: text }).result).toBe(text);
  });

  it("is refused before the desk is asked to pay, for a grade and for a task", async () => {
    const paid: string[] = [];
    const desk = {
      grade: async () => paid.push("grade"),
      post: async () => paid.push("task"),
    } as unknown as Desk;
    const key = word("sk-", "proj-", "Ab1_".repeat(10));
    const grade = await callTool(desk, GRADE_NAME, { brief: `Use ${key}.`, result: "Done." });
    const task = await callTool(desk, POST_TASK_NAME, { title: "Use the key", brief: `Use ${key}.`, levels: ["Used", "Not used"] });
    for (const result of [grade, task]) {
      expect(result.isError).toBe(true);
      expect((result.content as { text: string }[])[0]!.text).toContain("Briefs and results are published and cannot be withdrawn");
    }
    expect(paid).toEqual([]);
  });
});
