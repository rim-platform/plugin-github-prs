// Tests the GitHub helpers on their own: which requests may carry the token, and
// which repository names reach a request URL at all.
import { describe, expect, it } from "vitest";

import { fetchPulls, normalizeRepo, requestHeaders } from "./github.ts";

const TOKEN = "github_pat_11AAAAAAA0secretvalue";

describe("requestHeaders", () => {
  it("adds the token only to requests to api.github.com", () => {
    expect(requestHeaders("https://API.github.com/repos/a/b/pulls", TOKEN)).toHaveProperty(
      "Authorization",
    );
    expect(requestHeaders("https://api.github.com/repos/a/b/pulls", TOKEN)).toEqual({
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${TOKEN}`,
    });
    for (const url of [
      "https://avatars.githubusercontent.com/u/1?v=4",
      "https://api.github.com.evil.example/repos/a/b/pulls",
      "http://api.github.com/repos/a/b/pulls",
      "https://github.com/a/b",
      "https://api.github.com:8443/repos/a/b/pulls",
      "https://user@api.github.com.evil.example/",
      "not a url",
    ]) {
      expect(requestHeaders(url, TOKEN)).toEqual({ Accept: "application/vnd.github+json" });
    }
  });

  it("adds no Authorization header without a token", () => {
    expect(requestHeaders("https://api.github.com/repos/a/b/pulls", null)).toEqual({
      Accept: "application/vnd.github+json",
    });
  });
});

describe("fetchPulls", () => {
  it("sends the token to the pull requests URL on api.github.com and nowhere else", async () => {
    const calls: Array<[string, Record<string, string>]> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([String(input), init?.headers as Record<string, string>]);
      return Response.json([]);
    }) as typeof fetch;
    await fetchPulls("rust-lang/rust", fetchImpl, TOKEN);
    expect(calls).toEqual([
      [
        "https://api.github.com/repos/rust-lang/rust/pulls?state=open&per_page=30",
        { Accept: "application/vnd.github+json", Authorization: `Bearer ${TOKEN}` },
      ],
    ]);
    expect(new URL(calls[0][0]).origin).toBe("https://api.github.com");
  });
});

describe("normalizeRepo", () => {
  it("takes owner/name and github.com links", () => {
    expect(normalizeRepo(" rust-lang/rust ")).toBe("rust-lang/rust");
    expect(normalizeRepo("https://github.com/acme/.github/")).toBe("acme/.github");
    expect(normalizeRepo("acme/a..b")).toBe("acme/a..b");
  });

  it("refuses names that would change the request's path", () => {
    for (const value of [
      "owner/.",
      "owner/..",
      "https://github.com/owner/..",
      "owner/../",
      "../owner",
      "owner/name/pulls",
      "owner/name.git",
      42,
    ]) {
      expect(normalizeRepo(value)).toBeNull();
    }
  });
});
