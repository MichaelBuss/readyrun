import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { originRepository } from "./git.ts";
import type { TrackerAdapter } from "./tracker-adapter.ts";

const exec = promisify(execFile);

/** One pull request as the forge answers it, reduced to what reconcile reads. */
export type ForgePullRequest = {
  number: number;
  url: string;
  head: string;
  base: string;
  draft: boolean;
  state: "open" | "closed";
};

/** What creating one pull request names: its identity and its birth options. */
export type ForgeCreateInput = {
  /** The head branch, already pushed to the remote. */
  head: string;
  /** The base branch the pull request opens against. */
  base: string;
  title: string;
  body: string;
  /** A birth option (ADR 0048): applied once at creation, never revisited. */
  draft: boolean;
  /** Birth options, applied once at creation and never revisited. */
  labels: readonly string[];
};

/**
 * The forge port deliver drives (ADR 0048): the one writer to forge
 * artifacts, held by deliver alone — Tracker Adapters never gain forge
 * powers. Refs are pushed with the checkout's git; this port owns what git
 * cannot do: ask for a pull request by its head branch, create one, and
 * report the repository's merge methods.
 */
export type ForgePort = {
  /** The repository on the forge, `owner/name`. */
  readonly repository: string;
  /**
   * The open pull request whose head branch is this one, or none. Existence
   * by head branch is the reconcile check — body search has indexing lag and
   * no exact match (ADR 0048).
   */
  findPullRequest(head: string): Promise<ForgePullRequest | undefined>;
  /** Create one pull request, with its birth options applied. */
  createPullRequest(input: ForgeCreateInput): Promise<ForgePullRequest>;
  /**
   * The merge methods the repository allows, or none when the forge does not
   * say. The Delivery's Plan warns on squash, never refuses (ADR 0048).
   */
  mergeMethods(): Promise<readonly string[]>;
};

export type GitHubForgeRuntime = {
  fetch?: typeof fetch;
  token?: string;
  env?: Record<string, string | undefined>;
  ghAuthToken?: () => Promise<string | undefined>;
};

class GitHubForgeAuthError extends Error {
  constructor() {
    super(
      "ReadyRun could not authenticate to GitHub for the delivery. Check the GitHub token.",
    );
    this.name = "GitHubForgeAuthError";
  }
}

class GitHubForgeUnreachableError extends Error {
  constructor(detail: string) {
    super(`ReadyRun could not reach GitHub for the delivery. ${detail}`);
    this.name = "GitHubForgeUnreachableError";
  }
}

type RestPullRequest = {
  number: number;
  html_url: string;
  state: "open" | "closed";
  draft: boolean;
  head: { ref: string };
  base: { ref: string };
};

function toForgePullRequest(node: RestPullRequest): ForgePullRequest {
  return {
    number: node.number,
    url: node.html_url,
    head: node.head.ref,
    base: node.base.ref,
    draft: node.draft,
    state: node.state,
  };
}

/**
 * The GitHub forge port: the repository's REST API, with the token from the
 * environment's existing credentials — `GH_TOKEN`/`GITHUB_TOKEN`, else
 * `gh auth token` (ADR 0048). Nothing new is stored.
 *
 * @param options The repository, `owner/name`.
 * @param runtime The seams tests inject: fetch, token, env.
 */
export function githubForge(
  options: { repository: string },
  runtime: GitHubForgeRuntime = {},
): ForgePort {
  const http = runtime.fetch ?? fetch;
  const [owner, name] = options.repository.split("/");
  if (owner === undefined || name === undefined || name.includes("/")) {
    throw new Error(
      `GitHub forge repository must be owner/name, got ${options.repository}`,
    );
  }

  async function token(): Promise<string> {
    if (runtime.token !== undefined && runtime.token.length > 0) {
      return runtime.token;
    }
    const env = runtime.env ?? process.env;
    const fromEnv = env.GH_TOKEN ?? env.GITHUB_TOKEN;
    if (fromEnv !== undefined && fromEnv.length > 0) {
      return fromEnv;
    }
    const fromGh = await (runtime.ghAuthToken ?? ghAuthToken)();
    if (fromGh !== undefined && fromGh.length > 0) {
      return fromGh;
    }
    throw new GitHubForgeAuthError();
  }

  async function api<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const response = await http(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await token()}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "readyrun",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 401 || response.status === 403) {
      throw new GitHubForgeAuthError();
    }
    if (!response.ok) {
      throw new GitHubForgeUnreachableError(
        `GitHub REST HTTP ${response.status} for ${method} ${path}`,
      );
    }
    return await response.json() as T;
  }

  return {
    repository: options.repository,
    async findPullRequest(head) {
      const pulls = await api<RestPullRequest[]>(
        "GET",
        `/repos/${owner}/${name}/pulls?head=${encodeURIComponent(`${owner}:${head}`)}&state=open`,
      );
      const found = pulls[0];
      return found === undefined ? undefined : toForgePullRequest(found);
    },
    async createPullRequest(input) {
      const created = await api<RestPullRequest>(
        "POST",
        `/repos/${owner}/${name}/pulls`,
        {
          title: input.title,
          head: input.head,
          base: input.base,
          body: input.body,
          draft: input.draft,
        },
      );
      if (input.labels.length > 0) {
        // Pull requests label through the issues endpoint, the way GitHub
        // exposes one artifact twice.
        await api(
          "POST",
          `/repos/${owner}/${name}/issues/${created.number}/labels`,
          { labels: [...input.labels] },
        );
      }
      return toForgePullRequest(created);
    },
    async mergeMethods() {
      const repo = await api<{
        allow_squash_merge?: boolean;
        allow_merge_commit?: boolean;
        allow_rebase_merge?: boolean;
      }>("GET", `/repos/${owner}/${name}`);
      const methods: string[] = [];
      if (repo.allow_merge_commit === true) {
        methods.push("merge");
      }
      if (repo.allow_squash_merge === true) {
        methods.push("squash");
      }
      if (repo.allow_rebase_merge === true) {
        methods.push("rebase");
      }
      return methods;
    },
  };
}

async function ghAuthToken(): Promise<string | undefined> {
  try {
    const { stdout } = await exec("gh", ["auth", "token"], {
      encoding: "utf8",
    });
    const token = stdout.trim();
    return token.length === 0 ? undefined : token;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the forge port from the Tracker's own forge fact (ADR 0048): a
 * Tracker backed by a forge deliver can drive answers the port; a forgeless
 * Tracker — or one backed by a forge deliver does not know — answers none,
 * and the Delivery's Doctor refuses forge-requiring modes with that named
 * cause. The fact comes from `inspect()`; the port is deliver's, so the
 * Adapter never holds it.
 */
export async function resolveForge(
  cwd: string,
  tracker: TrackerAdapter,
): Promise<ForgePort | undefined> {
  let inspect;
  try {
    inspect = await tracker.inspect();
  } catch {
    return undefined;
  }
  if (inspect.forge !== "github") {
    return undefined;
  }
  const repository = inspect.repository ?? await originRepository(cwd);
  if (repository === undefined) {
    return undefined;
  }
  return githubForge({ repository });
}
