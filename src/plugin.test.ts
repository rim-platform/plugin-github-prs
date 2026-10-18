// Tests the pull request plugin over a MessageChannel, as its frame runs, with
// a pretend GitHub and the host's store: no RIM app and no network needed.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { startTestHost, validateManifest } from "@rim-platform/plugin-sdk/testing";

import {
  createPlugin,
  DEFAULT_REPOS,
  INVALID_TOKEN_NOTICE,
  MAX_REPOS,
  PANEL_ID,
  REFRESH_FLOOR_MS,
  type PanelState,
} from "./plugin.ts";

const MANIFEST = `${import.meta.dirname}/../rim-plugin.json`;
const T0 = Date.parse("2026-10-09T12:00:00Z");

/** The token GitHub accepts in these tests; any other one gets 401. */
const TOKEN = "github_pat_11AAAAAAA0secretvalue";
const OTHER_TOKEN = "ghp_othersecretvalue0000";
const LIMIT_MESSAGE =
  /^GitHub refused: the 60 requests an hour it allows without a token are used up\. Try again after \d\d:\d\d\./;

interface FakeGitHub {
  fetch: typeof fetch;
  requests: string[];
  /** The headers of each request, in order. */
  headers: Array<Record<string, string>>;
  /** Answer the next requests with GitHub's hourly-limit refusal, or stop. */
  limit: (on?: boolean) => void;
}

function fakeGitHub(): FakeGitHub {
  const requests: string[] = [];
  const headers: Array<Record<string, string>> = [];
  let limited = false;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    const sent = { ...(init?.headers as Record<string, string>) };
    headers.push(sent);
    const auth = sent.Authorization;
    if (auth !== undefined && auth !== `Bearer ${TOKEN}`) {
      return Response.json({ message: "Bad credentials" }, { status: 401 });
    }
    if (limited) {
      return new Response("{}", {
        status: 403,
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String((T0 + 3_600_000) / 1000),
        },
      });
    }
    const repo = /repos\/([^/]+\/[^/]+)\/pulls/.exec(url)?.[1] ?? "";
    if (repo === "acme/private") return new Response("{}", { status: 404 });
    return Response.json([
      {
        number: 7,
        title: `Fix ${repo}`,
        html_url: `https://github.com/${repo}/pull/7`,
        created_at: "2026-10-09T10:00:00Z",
        draft: repo.endsWith("-draft"),
        user: { login: "ada", avatar_url: "https://avatars.githubusercontent.com/u/1?v=4" },
      },
      {
        number: 8,
        title: "Sneaky",
        user: { login: "eve", avatar_url: "https://evil.example/x.png" },
      },
    ]);
  }) as typeof fetch;
  return {
    fetch: fetchImpl,
    requests,
    headers,
    limit: (on = true) => {
      limited = on;
    },
  };
}

interface StartOptions {
  principal?: null;
  /** What `rim.settings.get` answers; without it, `METHOD_NOT_FOUND` as from an older host. */
  settings?: Record<string, unknown>;
  /** A `wire.Error` that `rim.settings.get` fails with, while it is set. */
  settingsError?: { code: number; message: string; data?: unknown };
}

function start(stored: unknown = null, options: StartOptions = {}) {
  const github = fakeGitHub();
  const clock = { now: T0 };
  const store = new Map<string, unknown>([["repos", stored]]);
  const panels: PanelState[] = [];
  const settings = { error: options.settingsError };
  const host = startTestHost(createPlugin({ fetch: github.fetch, now: () => clock.now }), {
    transport: "port",
    manifestPath: MANIFEST,
    grantedCapabilities: ["ui.panel", "network.fetch"],
    ...(options.principal === null ? { principal: null } : {}),
    ...(options.settings !== undefined && options.settingsError === undefined
      ? { settings: options.settings }
      : {}),
    onRequest(method, params) {
      const p = params as { key: string; value?: unknown; panel_id: string; state: PanelState };
      if (method === "rim.settings.get") {
        if (settings.error !== undefined) throw settings.error;
        if (options.settings !== undefined) return { values: options.settings };
        throw { code: -32601, message: "method not found: rim.settings.get" };
      }
      if (method === "rim.storage.get") return { value: store.get(p.key) ?? null };
      if (method === "rim.storage.set") {
        store.set(p.key, p.value);
        return { ok: true };
      }
      if (method === "rim.ui.update_panel" && p.panel_id === PANEL_ID) panels.push(p.state);
      return { ok: true };
    },
  });
  return {
    host,
    github,
    clock,
    store,
    panels,
    settings,
    panel: () => panels.at(-1) as PanelState,
  };
}

/** Everything the plugin sent the host, and every state of its panel, as text. */
function everythingSent(t: ReturnType<typeof start>): string {
  return JSON.stringify([t.host.frames, t.host.logs, t.panels]);
}

const loaded = (t: ReturnType<typeof start>) => () =>
  t.panels.some((p) => !p.loading && p.fetchedAt !== null);

async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((done) => setTimeout(done, 5));
  expect(check()).toBe(true);
}

describe("github-prs plugin", () => {
  it("has a manifest the host installs once bundled", () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
    expect(() =>
      validateManifest(manifest, { forbiddenOrigins: ["https://rim.example"] }),
    ).not.toThrow();
  });

  it("loads the saved repositories and lists their open pull requests on start", async () => {
    const t = start(["rust-lang/rust", "acme/private"]);
    expect((await t.host.handshake()).accepted).toBe(true);
    await until(() => t.panels.some((p) => !p.loading && p.fetchedAt !== null));
    const state = t.panel();
    expect(state.repos.map((r) => [r.repo, r.pulls.length, r.error])).toEqual([
      ["rust-lang/rust", 2, null],
      ["acme/private", 0, "acme/private was not found, or it is private."],
    ]);
    expect(state.repos[0].pulls[0]).toEqual({
      number: 7,
      title: "Fix rust-lang/rust",
      url: "https://github.com/rust-lang/rust/pull/7",
      author: "ada",
      avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
      createdAt: "2026-10-09T10:00:00Z",
      draft: false,
    });
    // An avatar from anywhere but the listed image origin is dropped.
    expect(state.repos[0].pulls[1].avatarUrl).toBeNull();
    expect(t.github.requests).toEqual([
      "https://api.github.com/repos/rust-lang/rust/pulls?state=open&per_page=30",
      "https://api.github.com/repos/acme/private/pulls?state=open&per_page=30",
    ]);
    await t.host.shutdown();
  });

  it("refreshes at most every 2 minutes", async () => {
    const t = start(["rust-lang/rust"]);
    await t.host.handshake();
    await until(() => t.github.requests.length === 1 && !t.panel()?.loading);
    const early = await t.host.execute("refresh");
    expect(early.result?.message).toBe(
      "Fetched less than 2 minutes ago. GitHub allows 60 requests an hour without a token.",
    );
    expect(t.github.requests).toHaveLength(1);
    t.clock.now += REFRESH_FLOOR_MS;
    expect((await t.host.execute("refresh")).result?.message).toBe(
      "2 open pull requests in 1 repository",
    );
    expect(t.github.requests).toHaveLength(2);
    await t.host.shutdown();
  });

  it("says when GitHub refuses and stops asking until the limit resets", async () => {
    const t = start(["rust-lang/rust", "tokio-rs/tokio"]);
    t.github.limit();
    await t.host.handshake();
    await until(() => t.panel()?.notice !== null && t.panel()?.notice !== undefined);
    expect(t.panel().notice).toMatch(
      /^GitHub refused: the 60 requests an hour it allows without a token are used up\./,
    );
    expect(t.github.requests).toHaveLength(1);
    t.clock.now += REFRESH_FLOOR_MS;
    expect((await t.host.execute("refresh")).result?.message).toMatch(/^GitHub refused/);
    expect(t.github.requests).toHaveLength(1);
    await t.host.shutdown();
  });

  it("starts with the project's repositories until a list is saved, and keeps an emptied one", async () => {
    const t = start();
    await t.host.handshake();
    await until(() => t.panels.some((p) => !p.loading && p.fetchedAt !== null));
    expect(t.panel().repos.map((r) => r.repo)).toEqual([
      "rim-platform/rim-ui",
      "rim-platform/rim-server",
    ]);
    for (const repo of DEFAULT_REPOS) await t.host.execute("remove_repo", { repo });
    expect(t.store.get("repos")).toEqual([]);
    await t.host.shutdown();

    const emptied = start([]);
    await emptied.host.handshake();
    await until(() => emptied.panels.length > 0);
    expect(emptied.panel().repos).toEqual([]);
    expect(emptied.github.requests).toHaveLength(0);
    await emptied.host.shutdown();
  });

  it("adds and removes repositories, keeps them in the store, and holds at most 10", async () => {
    const t = start([]);
    await t.host.handshake();
    const added = await t.host.execute("add_repo", { repo: "https://github.com/rust-lang/rust/" });
    expect(added.result?.message).toBe("Added rust-lang/rust");
    expect(t.store.get("repos")).toEqual(["rust-lang/rust"]);
    expect(t.panel().repos[0].pulls).toHaveLength(2);
    expect((await t.host.execute("add_repo", { repo: "rust-lang/rust" })).result?.message).toBe(
      "rust-lang/rust is already in the list",
    );
    expect((await t.host.execute("add_repo", { repo: "not a repo" })).error).toMatchObject({
      code: -32602,
    });

    for (let i = 1; i < MAX_REPOS; i++)
      await t.host.execute("add_repo", { repo: `acme/repo-${i}` });
    expect(t.store.get("repos")).toHaveLength(MAX_REPOS);
    expect((await t.host.execute("add_repo", { repo: "acme/one-too-many" })).error?.message).toBe(
      "The list holds at most 10 repositories; remove one first.",
    );

    expect((await t.host.execute("remove_repo", { repo: "RUST-LANG/rust" })).result?.message).toBe(
      "Removed RUST-LANG/rust",
    );
    expect(t.store.get("repos")).not.toContain("rust-lang/rust");
    await t.host.shutdown();
  });

  it("keeps no list while nobody is signed in", async () => {
    const t = start(["rust-lang/rust"], { principal: null });
    await t.host.handshake();
    await until(() => t.panels.length > 0);
    expect(t.panel()).toMatchObject({ signedIn: false, repos: [] });
    expect((await t.host.execute("add_repo", { repo: "rust-lang/rust" })).error?.message).toBe(
      "Sign in to keep a list of repositories.",
    );
    expect(t.github.requests).toHaveLength(0);
    await t.host.shutdown();
  });
});

describe("the GitHub token setting", () => {
  it("is a secret string with no default in the manifest", () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
    expect(manifest.settings_schema).toEqual([
      expect.objectContaining({
        key: "github_token",
        value_type: "string",
        is_secret: true,
      }),
    ]);
    expect(manifest.settings_schema[0]).not.toHaveProperty("default");
  });

  it("sends no Authorization header while no token is saved", async () => {
    const t = start(["rust-lang/rust"], { settings: {} });
    await t.host.handshake();
    await until(loaded(t));
    expect(t.host.frames).toContainEqual(expect.objectContaining({ method: "rim.settings.get" }));
    expect(t.github.headers).toEqual([{ Accept: "application/vnd.github+json" }]);
    await t.host.shutdown();
  });

  it("sends the saved token, trimmed, as a bearer token on every request", async () => {
    const t = start(["rust-lang/rust", "tokio-rs/tokio"], {
      settings: { github_token: `  ${TOKEN}\n` },
    });
    await t.host.handshake();
    await until(loaded(t));
    expect(t.github.headers).toEqual([
      { Accept: "application/vnd.github+json", Authorization: `Bearer ${TOKEN}` },
      { Accept: "application/vnd.github+json", Authorization: `Bearer ${TOKEN}` },
    ]);
    t.clock.now += REFRESH_FLOOR_MS / 2;
    expect((await t.host.execute("refresh")).result?.message).toBe(
      "Fetched less than 2 minutes ago.",
    );
    await t.host.shutdown();
  });

  it("follows a changed token, and goes back to no header once it is cleared", async () => {
    const t = start(["rust-lang/rust"], { settings: { github_token: TOKEN } });
    await t.host.handshake();
    await until(loaded(t));
    t.host.changeSettings({ github_token: OTHER_TOKEN, unknown_key: 3 });
    t.clock.now += REFRESH_FLOOR_MS;
    await t.host.execute("refresh");
    expect(t.github.headers.at(-1)?.Authorization).toBe(`Bearer ${OTHER_TOKEN}`);
    t.host.changeSettings({});
    t.clock.now += REFRESH_FLOOR_MS;
    await t.host.execute("refresh");
    expect(t.github.headers.at(-1)).toEqual({ Accept: "application/vnd.github+json" });
    // A value saved under another type, or one no token can be, is not sent.
    t.host.changeSettings({ github_token: 42 });
    t.clock.now += REFRESH_FLOOR_MS;
    await t.host.execute("refresh");
    t.host.changeSettings({ github_token: "two words" });
    await until(() => t.panel().notice === INVALID_TOKEN_NOTICE);
    t.clock.now += REFRESH_FLOOR_MS;
    await t.host.execute("refresh");
    expect(t.github.headers.slice(-2)).toEqual([
      { Accept: "application/vnd.github+json" },
      { Accept: "application/vnd.github+json" },
    ]);
    await t.host.shutdown();
  });

  it("suggests adding a token once the limit is used up, and fetches with one at once", async () => {
    const t = start(["rust-lang/rust", "tokio-rs/tokio"], { settings: {} });
    t.github.limit();
    await t.host.handshake();
    await until(() => typeof t.panel()?.notice === "string");
    expect(t.panel().notice).toMatch(LIMIT_MESSAGE);
    expect(t.panel().notice).toMatch(
      /To raise it, add a GitHub token in this plugin's settings in the RIM desktop app: the side rail's Plugins menu, or Settings → Plugins\.$/,
    );
    expect(t.github.requests).toHaveLength(1);

    t.github.limit(false);
    t.host.changeSettings({ github_token: TOKEN });
    await until(() => t.github.requests.length === 3 && !t.panel().loading);
    expect(t.github.headers.slice(1).map((h) => h.Authorization)).toEqual([
      `Bearer ${TOKEN}`,
      `Bearer ${TOKEN}`,
    ]);
    expect(t.panel().notice).toBeNull();
    expect(t.panel().repos.map((r) => r.pulls.length)).toEqual([2, 2]);
    await t.host.shutdown();
  });

  it("says the token's own limit is used up, without suggesting one", async () => {
    const t = start(["rust-lang/rust"], { settings: { github_token: TOKEN } });
    t.github.limit();
    await t.host.handshake();
    await until(() => typeof t.panel()?.notice === "string");
    expect(t.panel().notice).toMatch(
      /^GitHub refused: the requests an hour it allows your token are used up\. Try again after \d\d:\d\d\.$/,
    );
    await t.host.shutdown();
  });

  it("says GitHub rejected the token, and fetches again once it is replaced", async () => {
    const t = start(["rust-lang/rust", "acme/private"], {
      settings: { github_token: OTHER_TOKEN },
    });
    await t.host.handshake();
    await until(() => typeof t.panel()?.notice === "string");
    expect(t.panel().notice).toBe(
      "GitHub rejected the token in this plugin's settings: it may have expired or been revoked. Replace or clear it there.",
    );
    // Every request would be refused the same way, so it stops at the first.
    expect(t.github.requests).toHaveLength(1);

    t.host.changeSettings({ github_token: TOKEN });
    await until(() => t.github.requests.length === 3 && !t.panel().loading);
    expect(t.panel().notice).toBeNull();
    expect(t.panel().repos.map((r) => r.error)).toEqual([
      null,
      "acme/private was not found, or your token cannot read it.",
    ]);
    await t.host.shutdown();
  });

  it("goes on without the token while the vault is locked, says so, and reads it again later", async () => {
    const t = start(["rust-lang/rust"], {
      settings: { github_token: TOKEN },
      settingsError: { code: -32603, message: "secrets locked", data: { reason: "secretsLocked" } },
    });
    t.github.limit();
    await t.host.handshake();
    await until(() => typeof t.panel()?.notice === "string");
    expect(t.github.headers).toEqual([{ Accept: "application/vnd.github+json" }]);
    expect(t.panel().notice).toMatch(LIMIT_MESSAGE);
    expect(t.panel().notice).toMatch(
      /The token in this plugin's settings could not be read because the desktop's secret vault is locked; unlock it and refresh\.$/,
    );
    expect(t.panel().notice).not.toMatch(/add a GitHub token/);
    expect(t.host.logs.filter((l) => l.level === "warn")).toHaveLength(1);

    // Once the vault opens, the next refresh reads the token and fetches with it.
    t.settings.error = undefined;
    t.github.limit(false);
    expect((await t.host.execute("refresh")).result?.message).toBe(
      "2 open pull requests in 1 repository",
    );
    expect(t.github.headers.at(-1)?.Authorization).toBe(`Bearer ${TOKEN}`);
    await t.host.shutdown();
  });

  it("says the settings could not be read when another read failure meets the limit", async () => {
    const t = start(["rust-lang/rust"], {
      settings: {},
      settingsError: { code: -32603, message: "the host did not answer" },
    });
    t.github.limit();
    await t.host.handshake();
    await until(() => typeof t.panel()?.notice === "string");
    expect(t.panel().notice).toMatch(
      /The plugin's settings could not be read, so the token in them was not used\.$/,
    );
    await t.host.shutdown();
  });

  it("works as before on a host from before settings", async () => {
    const t = start(["rust-lang/rust"]);
    t.github.limit();
    await t.host.handshake();
    await until(() => typeof t.panel()?.notice === "string");
    expect(t.github.headers).toEqual([{ Accept: "application/vnd.github+json" }]);
    expect(t.panel().notice).toMatch(/^GitHub refused: .* Try again after \d\d:\d\d\.$/);
    expect(t.host.logs).toEqual([]);
    await t.host.shutdown();
  });

  it("does not send a token no header can carry, and says to paste it again", async () => {
    const broken = "ghp_abc\ndef\u00e9secretvalue";
    const t = start(["rust-lang/rust"], { settings: { github_token: broken } });
    await t.host.handshake();
    await until(loaded(t));
    expect(t.github.headers).toEqual([{ Accept: "application/vnd.github+json" }]);
    expect(t.panel().notice).toBe(INVALID_TOKEN_NOTICE);
    expect(t.panel().repos[0].pulls).toHaveLength(2);
    t.clock.now += REFRESH_FLOOR_MS;
    expect((await t.host.execute("refresh")).result?.message).toBe(INVALID_TOKEN_NOTICE);

    // With the hourly limit used up, the refusal names the token as the reason.
    t.github.limit();
    t.clock.now += REFRESH_FLOOR_MS;
    const limited = (await t.host.execute("refresh")).result?.message ?? "";
    expect(limited).toMatch(LIMIT_MESSAGE);
    expect(limited.endsWith(` ${INVALID_TOKEN_NOTICE}`)).toBe(true);
    expect(everythingSent(t)).not.toContain("secretvalue");

    // A valid token replaces it: the notice goes and the next fetch carries it.
    t.github.limit(false);
    t.host.changeSettings({ github_token: TOKEN });
    await until(() => t.github.headers.at(-1)?.Authorization === `Bearer ${TOKEN}`);
    await until(() => !t.panel().loading);
    expect(t.panel().notice).toBeNull();
    await t.host.shutdown();
  });

  it("shows a token that cannot be sent as soon as it is saved, and drops the notice once cleared", async () => {
    const t = start(["rust-lang/rust"], { settings: {} });
    await t.host.handshake();
    await until(loaded(t));
    t.host.changeSettings({ github_token: "github_pat_ with a space" });
    await until(() => t.panel().notice === INVALID_TOKEN_NOTICE);
    t.host.changeSettings({});
    await until(() => t.panel().notice === null);
    expect(t.github.headers.every((h) => h.Authorization === undefined)).toBe(true);
    await t.host.shutdown();
  });

  it("keeps the token out of the store", async () => {
    const t = start(["rust-lang/rust"], { settings: { github_token: TOKEN } });
    await t.host.handshake();
    await until(loaded(t));
    await t.host.execute("add_repo", { repo: "tokio-rs/tokio" });
    await t.host.execute("remove_repo", { repo: "rust-lang/rust" });
    expect(t.store.get("repos")).toEqual(["tokio-rs/tokio"]);
    expect(JSON.stringify([...t.store])).not.toContain(TOKEN);
    const writes = t.host.frames.filter(
      (f) => (f as { method?: string }).method === "rim.storage.set",
    );
    expect(writes).toHaveLength(2);
    expect(JSON.stringify(writes)).not.toContain(TOKEN);
    await t.host.shutdown();
  });

  it("refuses owner/. and owner/.. as repositories, so no request goes elsewhere", async () => {
    const t = start([], { settings: { github_token: TOKEN } });
    await t.host.handshake();
    for (const repo of ["owner/..", "owner/.", "https://github.com/owner/.."]) {
      expect((await t.host.execute("add_repo", { repo })).error).toMatchObject({ code: -32602 });
    }
    expect(t.github.requests).toEqual([]);
    await t.host.shutdown();

    // A stored list is checked the same way when it is loaded.
    const stored = start(["owner/..", "rust-lang/rust"], { settings: { github_token: TOKEN } });
    await stored.host.handshake();
    await until(loaded(stored));
    expect(stored.panel().repos.map((r) => r.repo)).toEqual(["rust-lang/rust"]);
    expect(stored.github.requests).toEqual([
      "https://api.github.com/repos/rust-lang/rust/pulls?state=open&per_page=30",
    ]);
    await stored.host.shutdown();
  });

  it("never puts the token in a message, a log line, the panel or a command answer", async () => {
    const rejected = start(["rust-lang/rust"], { settings: { github_token: OTHER_TOKEN } });
    await rejected.host.handshake();
    await until(() => typeof rejected.panel()?.notice === "string");
    rejected.clock.now += REFRESH_FLOOR_MS;
    await rejected.host.execute("refresh");
    await rejected.host.execute("add_repo", { repo: "acme/private" });
    expect(everythingSent(rejected)).not.toContain(OTHER_TOKEN);
    await rejected.host.shutdown();

    const accepted = start(["rust-lang/rust"], { settings: { github_token: TOKEN } });
    await accepted.host.handshake();
    await until(loaded(accepted));
    await accepted.host.execute("add_repo", { repo: "acme/private" });
    accepted.github.limit();
    accepted.clock.now += REFRESH_FLOOR_MS;
    await accepted.host.execute("refresh");
    accepted.host.changeSettings({ github_token: OTHER_TOKEN });
    accepted.clock.now += 2 * 60 * 60 * 1000;
    await accepted.host.execute("refresh");
    const sent = everythingSent(accepted);
    expect(sent).not.toContain(TOKEN);
    expect(sent).not.toContain(OTHER_TOKEN);
    expect(sent).not.toContain("secretvalue");
    await accepted.host.shutdown();
  });
});
