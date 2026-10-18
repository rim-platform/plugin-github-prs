// The GitHub REST API calls of the plugin: open pull requests of a repository,
// with the person's own token when they saved one, and what GitHub's refusals
// mean for a person. No message here ever carries the token.

/** One open pull request, as the panel shows it. */
export interface Pull {
  number: number;
  title: string;
  url: string;
  author: string;
  /** Only ever an avatars.githubusercontent.com URL, the one image origin the plugin lists. */
  avatarUrl: string | null;
  createdAt: string;
  draft: boolean;
}

/**
 * GitHub said no; `rateLimitedUntil` is set when the hourly limit is used up, and
 * `tokenRejected` when GitHub refused the token the request carried.
 */
export class GitHubError extends Error {
  readonly rateLimitedUntil: number | null;
  readonly tokenRejected: boolean;

  constructor(
    message: string,
    options: { rateLimitedUntil?: number | null; tokenRejected?: boolean } = {},
  ) {
    super(message);
    this.name = "GitHubError";
    this.rateLimitedUntil = options.rateLimitedUntil ?? null;
    this.tokenRejected = options.tokenRejected ?? false;
  }
}

const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const AVATARS = "https://avatars.githubusercontent.com/";
/** The one origin a request may carry the token to. */
const API = "https://api.github.com/";

/** `owner/name` trimmed, or null when it is not a repository name. */
export function normalizeRepo(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const repo = value
    .trim()
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/\/+$/, "");
  const name = repo.slice(repo.indexOf("/") + 1);
  // `.` and `..` would make the request URL a different API path.
  if (name === "." || name === "..") return null;
  return REPO.test(repo) && !repo.endsWith(".git") ? repo : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The pull requests in a `GET /repos/{owner}/{repo}/pulls` answer. */
export function parsePulls(body: unknown): Pull[] {
  if (!Array.isArray(body))
    throw new GitHubError("GitHub sent something other than a list of pull requests.");
  return body.filter(isRecord).map((pull) => {
    const user = isRecord(pull.user) ? pull.user : {};
    const avatar =
      typeof user.avatar_url === "string" && user.avatar_url.startsWith(AVATARS)
        ? user.avatar_url
        : null;
    return {
      number: typeof pull.number === "number" ? pull.number : 0,
      title: typeof pull.title === "string" ? pull.title : "(untitled)",
      url: typeof pull.html_url === "string" ? pull.html_url : "",
      author: typeof user.login === "string" ? user.login : "unknown",
      avatarUrl: avatar,
      createdAt: typeof pull.created_at === "string" ? pull.created_at : "",
      draft: pull.draft === true,
    };
  });
}

function clock(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * The headers of a request to `url`: `Accept`, and `token` as a bearer token only when
 * there is one and `url` is on api.github.com.
 */
export function requestHeaders(url: string, token: string | null): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  if (token !== null && url.startsWith(API)) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** Fetch the open pull requests of `repo`, with `token` when it is not null. */
export async function fetchPulls(
  repo: string,
  fetchImpl: typeof fetch,
  token: string | null = null,
): Promise<Pull[]> {
  const url = `${API}repos/${repo}/pulls?state=open&per_page=30`;
  let response: Response;
  try {
    response = await fetchImpl(url, { headers: requestHeaders(url, token) });
  } catch {
    throw new GitHubError("GitHub could not be reached.");
  }
  if (response.ok) return parsePulls(await response.json());
  const remaining = response.headers.get("x-ratelimit-remaining");
  if (
    (response.status === 403 || response.status === 429) &&
    (remaining === "0" || response.status === 429)
  ) {
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    const until = Number.isFinite(reset) && reset > 0 ? reset * 1000 : Date.now() + 60 * 60 * 1000;
    const limit =
      token === null
        ? "the 60 requests an hour it allows without a token are used up"
        : "the requests an hour it allows your token are used up";
    throw new GitHubError(`GitHub refused: ${limit}. Try again after ${clock(until)}.`, {
      rateLimitedUntil: until,
    });
  }
  if (response.status === 401 && token !== null) {
    throw new GitHubError(
      "GitHub rejected the token in this plugin's settings: it may have expired or been revoked. Replace or clear it there.",
      { tokenRejected: true },
    );
  }
  if (response.status === 404) {
    throw new GitHubError(
      token === null
        ? `${repo} was not found, or it is private.`
        : `${repo} was not found, or your token cannot read it.`,
    );
  }
  throw new GitHubError(`GitHub answered ${response.status} for ${repo}.`);
}
