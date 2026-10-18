// The GitHub Pull Requests plugin: a WebSandboxed plugin that keeps up to 10
// repositories in the host's store and shows their open pull requests in its
// panel. It talks only to api.github.com, with the GitHub token the person saved
// in its settings or else without one, refreshes at most every 2 minutes and
// says when GitHub refuses.

import {
  definePlugin,
  ErrorCode,
  HostRequestError,
  PluginError,
  type Host,
} from "@rim-platform/plugin-sdk";

import { fetchPulls, GitHubError, normalizeRepo, type Pull } from "./github.ts";

export const PLUGIN_ID = "chat.rim.github-prs";
export const PANEL_ID = "prs";
export const MAX_REPOS = 10;
/** The shortest time between two fetches of the list, to stay under GitHub's hourly limit. */
export const REFRESH_FLOOR_MS = 2 * 60 * 1000;
/** How often the plugin refreshes on its own while it runs. */
export const AUTO_REFRESH_MS = 5 * 60 * 1000;
const STORAGE_KEY = "repos";
/** The key of the GitHub token in the manifest's `settings_schema`. */
export const TOKEN_SETTING = "github_token";
/** What a token sent in a header can hold: printable ASCII without spaces. */
const TOKEN_CHARS = /^[\x21-\x7e]+$/;
/** The notice while the saved token cannot be sent; it never repeats the value. */
export const INVALID_TOKEN_NOTICE =
  "The GitHub token in this plugin's settings is not valid, so it was not sent; paste it again.";
/** The list a person starts with until they save one of their own: the project's repositories. */
export const DEFAULT_REPOS: readonly string[] = ["rim-platform/rim-ui", "rim-platform/rim-server"];

/**
 * Where the token stands: none saved, `set` and sent, `locked` while the desktop's
 * secret vault cannot be read, `unreadable` when reading the settings failed otherwise,
 * `unsupported` on a host from before settings, and `unusable` when the saved value
 * cannot be a token.
 */
type TokenStatus = "none" | "set" | "locked" | "unreadable" | "unsupported" | "unusable";

/** One repository in the panel. */
export interface RepoState {
  repo: string;
  pulls: Pull[];
  error: string | null;
}

/** What the panel shows; the plugin publishes it whole with `rim.ui.update_panel`. */
export interface PanelState {
  repos: RepoState[];
  maxRepos: number;
  fetchedAt: string | null;
  loading: boolean;
  /** A line for the person: GitHub refused, or the list was fetched a moment ago. */
  notice: string | null;
  signedIn: boolean;
}

export interface PluginOptions {
  fetch?: typeof fetch;
  now?: () => number;
}

/** A fresh plugin. Tests pass a fake `fetch` and clock. */
export function createPlugin(options: PluginOptions = {}) {
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? Date.now;
  let repos: RepoState[] = [];
  let signedIn = false;
  let fetchedAt: number | null = null;
  let rateLimitedUntil = 0;
  let loading = false;
  let notice: string | null = null;
  let panelDenied = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let token: string | null = null;
  let tokenStatus: TokenStatus = "none";
  let tokenRejected = false;
  // Commands wait for the saved list and settings, so one that arrives right
  // after the handshake or a sign-in does not race with loading them.
  let loaded: Promise<void> = Promise.resolve();

  const state = (): PanelState => ({
    repos,
    maxRepos: MAX_REPOS,
    fetchedAt: fetchedAt === null ? null : new Date(fetchedAt).toISOString(),
    loading,
    notice,
    signedIn,
  });

  async function publish(host: Host): Promise<void> {
    if (panelDenied) return;
    try {
      await host.panels.set(PANEL_ID, state());
    } catch (error) {
      if (error instanceof HostRequestError && error.code === ErrorCode.CAPABILITY_DENIED) {
        panelDenied = true;
        host.log.warn("the panel needs the ui.panel permission");
        return;
      }
      host.log.warn(`could not update the panel: ${(error as Error).message}`);
    }
  }

  /**
   * The signed-in user's repositories from the host's store, or {@link DEFAULT_REPOS} when
   * they never saved a list; none when nobody is signed in.
   */
  async function load(host: Host): Promise<void> {
    signedIn = host.principal !== null;
    fetchedAt = null;
    notice = null;
    if (!signedIn) {
      repos = [];
      return;
    }
    try {
      const stored = await host.storage.get(STORAGE_KEY);
      const names = Array.isArray(stored)
        ? stored.map(normalizeRepo).filter((r): r is string => r !== null)
        : [...DEFAULT_REPOS];
      repos = names.slice(0, MAX_REPOS).map((repo) => ({ repo, pulls: [], error: null }));
    } catch (error) {
      repos = [];
      host.log.warn(`could not read the saved repositories: ${(error as Error).message}`);
    }
  }

  /**
   * Take a new token, or none. GitHub's refusals were about the old one, so they are
   * forgotten; answers whether one of them was holding the list back.
   */
  function setToken(next: string | null, status: TokenStatus): boolean {
    if (next === token && status === tokenStatus) return false;
    token = next;
    tokenStatus = status;
    const blocked = now() < rateLimitedUntil || tokenRejected;
    rateLimitedUntil = 0;
    tokenRejected = false;
    if (blocked) {
      notice = null;
      fetchedAt = null;
    }
    return blocked;
  }

  // A value saved under an older version may not fit, so it is checked.
  function applySettings(values: Readonly<Record<string, unknown>>): boolean {
    const saved = values[TOKEN_SETTING];
    const value = typeof saved === "string" ? saved.trim() : "";
    if (value === "") return setToken(null, "none");
    return TOKEN_CHARS.test(value) ? setToken(value, "set") : setToken(null, "unusable");
  }

  /** Read the settings; a failed read leaves the plugin without a token and says why. */
  async function readSettings(host: Host): Promise<void> {
    try {
      applySettings(await host.settings.get());
    } catch (error) {
      let status: TokenStatus = "unsupported";
      if (!(error instanceof HostRequestError && error.code === ErrorCode.METHOD_NOT_FOUND)) {
        const data = error instanceof HostRequestError ? error.data : undefined;
        const locked =
          typeof data === "object" &&
          data !== null &&
          (data as { reason?: unknown }).reason === "secretsLocked";
        status = locked ? "locked" : "unreadable";
        if (status !== tokenStatus) {
          host.log.warn(`settings not read: ${(error as Error).message}`);
        }
      }
      setToken(null, status);
    }
  }

  /** What the person can do about the token when GitHub's limit is used up. */
  function tokenHint(): string {
    switch (tokenStatus) {
      case "none":
        return " To raise it, add a GitHub token in this plugin's settings in the RIM desktop app: the side rail's Plugins menu, or Settings → Plugins.";
      case "locked":
        return " The token in this plugin's settings could not be read because the desktop's secret vault is locked; unlock it and refresh.";
      case "unreadable":
        return " The plugin's settings could not be read, so the token in them was not used.";
      case "unusable":
        return ` ${INVALID_TOKEN_NOTICE}`;
      default:
        return "";
    }
  }

  async function save(host: Host): Promise<void> {
    await host.storage.set(
      STORAGE_KEY,
      repos.map((r) => r.repo),
    );
  }

  /** Fetch `targets`, stopping at the first refusal of the hourly limit. */
  async function fetchRepos(host: Host, targets: RepoState[]): Promise<void> {
    if (now() < rateLimitedUntil) return;
    loading = true;
    await publish(host);
    for (const target of targets) {
      try {
        target.pulls = await fetchPulls(target.repo, fetchImpl, token);
        target.error = null;
      } catch (error) {
        const refusal =
          error instanceof GitHubError
            ? error
            : new GitHubError("The pull requests could not be read.");
        if (refusal.rateLimitedUntil !== null) {
          rateLimitedUntil = refusal.rateLimitedUntil;
          notice = refusal.message + tokenHint();
          break;
        }
        if (refusal.tokenRejected) {
          tokenRejected = true;
          notice = refusal.message;
          break;
        }
        target.error = refusal.message;
      }
    }
    loading = false;
  }

  /** Fetch every repository, unless the list was fetched under 2 minutes ago or GitHub said wait. */
  async function refresh(host: Host): Promise<string> {
    // The host sends no change once a locked vault opens, so the plugin asks again.
    if (tokenStatus === "locked" || tokenStatus === "unreadable") await readSettings(host);
    if (repos.length === 0) {
      await publish(host);
      return "No repositories yet: add one in the panel.";
    }
    if (now() < rateLimitedUntil) {
      await publish(host);
      return notice ?? "GitHub refused; try again later.";
    }
    if (fetchedAt !== null && now() - fetchedAt < REFRESH_FLOOR_MS) {
      notice =
        token === null
          ? "Fetched less than 2 minutes ago. GitHub allows 60 requests an hour without a token."
          : "Fetched less than 2 minutes ago.";
      await publish(host);
      return notice;
    }
    notice = null;
    fetchedAt = now();
    await fetchRepos(host, repos);
    if (tokenStatus === "unusable") notice ??= INVALID_TOKEN_NOTICE;
    await publish(host);
    const open = repos.reduce((sum, r) => sum + r.pulls.length, 0);
    return (
      notice ??
      `${open} open pull request${open === 1 ? "" : "s"} in ${repos.length} repositor${repos.length === 1 ? "y" : "ies"}`
    );
  }

  /** Load the signed-in user's list and the settings, which belong to them too. */
  async function prepare(host: Host): Promise<void> {
    await Promise.all([load(host), readSettings(host)]);
  }

  function repoArgument(args: Readonly<Record<string, unknown>>): string {
    const repo = normalizeRepo(args.repo);
    if (!repo) {
      throw new PluginError("repo must be a repository as owner/name, such as rust-lang/rust", {
        code: ErrorCode.INVALID_PARAMS,
      });
    }
    return repo;
  }

  function requireSignIn(): void {
    if (!signedIn) throw new PluginError("Sign in to keep a list of repositories.");
  }

  return definePlugin({
    id: PLUGIN_ID,
    commands: {
      refresh: {
        async run({ host }) {
          await loaded;
          const message = await refresh(host);
          return { payload: state(), message };
        },
      },
      add_repo: {
        async run({ host, args }) {
          await loaded;
          requireSignIn();
          const repo = repoArgument(args);
          if (repos.some((r) => r.repo.toLowerCase() === repo.toLowerCase())) {
            return { payload: state(), message: `${repo} is already in the list` };
          }
          if (repos.length >= MAX_REPOS) {
            throw new PluginError(
              `The list holds at most ${MAX_REPOS} repositories; remove one first.`,
            );
          }
          const added: RepoState = { repo, pulls: [], error: null };
          repos = [...repos, added];
          await save(host);
          await fetchRepos(host, [added]);
          await publish(host);
          return { payload: state(), message: added.error ?? notice ?? `Added ${repo}` };
        },
      },
      remove_repo: {
        async run({ host, args }) {
          await loaded;
          requireSignIn();
          const repo = repoArgument(args);
          repos = repos.filter((r) => r.repo.toLowerCase() !== repo.toLowerCase());
          await save(host);
          await publish(host);
          return { payload: state(), message: `Removed ${repo}` };
        },
      },
    },
    async onReady(host) {
      loaded = prepare(host);
      await loaded;
      await refresh(host);
      timer = setInterval(() => void refresh(host), AUTO_REFRESH_MS);
    },
    async onPrincipalChanged(_principal, host) {
      loaded = prepare(host);
      await loaded;
      await refresh(host);
    },
    // A save, or another account signing in: the whole set. A new token fetches
    // again at once when GitHub had refused the old one; one that cannot be sent
    // says so at once.
    async onSettingsChanged(values, host) {
      const blocked = applySettings(values);
      await loaded;
      if (blocked) {
        await refresh(host);
      } else if (tokenStatus === "unusable" && notice === null) {
        notice = INVALID_TOKEN_NOTICE;
        await publish(host);
      } else if (tokenStatus !== "unusable" && notice === INVALID_TOKEN_NOTICE) {
        notice = null;
        await publish(host);
      }
    },
    onShutdown() {
      if (timer !== null) clearInterval(timer);
    },
  });
}
