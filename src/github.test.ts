import { afterEach, describe, expect, it } from "vitest";

import { gitHubAuth, hasGitHubToken, useGitHubToken } from "./github.js";

describe("useGitHubToken", () => {
  afterEach(() => useGitHubToken(undefined));

  it("takes a classic or a fine-grained token, and an empty setting as none", () => {
    for (const token of [`ghp_${"a".repeat(36)}`, `github_pat_${"B2_".repeat(27)}`, `ghs_${"c".repeat(36)}`]) {
      expect(useGitHubToken(token)).toBeUndefined();
      expect(gitHubAuth("https://api.github.com/repos/BitGo/BitGoJS/activity")).toEqual({ Authorization: `Bearer ${token}` });
    }
    expect(useGitHubToken("")).toBeUndefined();
    expect(hasGitHubToken()).toBe(false);
  });

  it("refuses what is not a token, uses none, and never repeats the value", () => {
    useGitHubToken(`ghp_${"a".repeat(36)}`);
    for (const value of ["short", `ghp_${"a".repeat(36)} `, `Bearer ghp_${"a".repeat(36)}`, `ghp_${"a".repeat(36)}\r\nX: y`]) {
      const problem = useGitHubToken(value);
      expect(problem).toMatch(/^GITHUB_TOKEN is not a GitHub token/);
      expect(problem).not.toContain(value.trim());
      expect(hasGitHubToken()).toBe(false);
      expect(gitHubAuth("https://api.github.com/")).toEqual({});
    }
  });

  it("sends the token to GitHub's API only", () => {
    useGitHubToken(`ghp_${"a".repeat(36)}`);
    for (const url of ["https://raw.githubusercontent.com/BitGo/BitGoJS/master/x", "https://github.com/trustwallet/assets/commits/master/x.atom", "https://api.github.com.evil.example/", "https://li.quest/v1/tokens"]) {
      expect(gitHubAuth(url), url).toEqual({});
    }
  });
});
