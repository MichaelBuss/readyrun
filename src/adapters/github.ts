import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  createTrackerAdapter,
  type Landing,
  type TrackerAdapter,
} from "../tracker-adapter.ts";
import { shortCommit } from "../git.ts";
import type { Ticket } from "../ticket.ts";
import { assertKnownKeys } from "../unknown-keys.ts";

const exec = promisify(execFile);

const knownGitHubKeys = new Set([
  "repo",
  "ready",
  "labels",
  "parent",
  "ids",
  "account",
]);

export type GitHubTrackerOptions = {
  repo: string;
  ready: "unblocked";
  labels: string[];
  parent?: string;
  ids?: string[];
  account?: string;
};

export type GitHubRuntime = {
  fetch?: typeof fetch;
  token?: string;
  env?: Record<string, string | undefined>;
  cwd?: string;
  ghAuthToken?: (account?: string) => Promise<string | undefined>;
};

type PageInfo = {
  hasNextPage: boolean;
  endCursor: string | null;
};

type LabelNode = { name: string };

type IssueNode = {
  number: number;
  title: string;
  body: string | null;
  url: string;
  labels: { nodes: (LabelNode | null)[] };
  parent: { number: number } | null;
  blockedBy?: {
    nodes: ({
      number: number;
      state: "OPEN" | "CLOSED";
      labels: { nodes: (LabelNode | null)[] };
    } | null)[];
  };
};

const schemaProbeQuery = `query SchemaProbe {
  __type(name: "Issue") {
    fields { name }
  }
}`;

const labelsQuery = `query Labels($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    labels(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { name }
    }
  }
}`;

const frontierQuery = `query Frontier($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    issues(first: 100, after: $cursor, states: [OPEN]) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        title
        body
        url
        labels(first: 50) { nodes { name } }
        parent { number }
        blockedBy(first: 50) {
          nodes {
            number
            state
            labels(first: 50) { nodes { name } }
          }
        }
      }
    }
  }
}`;

type SchemaProbeData = {
  __type: { fields: { name: string }[] | null } | null;
};

type LabelsData = {
  repository: {
    labels: { pageInfo: PageInfo; nodes: (LabelNode | null)[] };
  } | null;
};

type FrontierData = {
  repository: {
    issues: { pageInfo: PageInfo; nodes: (IssueNode | null)[] };
  } | null;
};

export function github(
  options: GitHubTrackerOptions,
  runtime: GitHubRuntime = {},
): TrackerAdapter {
  assertKnownKeys(options, knownGitHubKeys);
  const { owner, name } = splitRepo(options.repo);
  const http = runtime.fetch ?? fetch;

  async function token(): Promise<string> {
    if (runtime.token !== undefined && runtime.token.length > 0) {
      return runtime.token;
    }
    const account = firstNonEmpty(options.account) ??
      await gitConfigGitHubAccount(runtime);
    if (account !== undefined) {
      const fromGh = await (runtime.ghAuthToken ?? ghAuthToken)(account);
      if (fromGh !== undefined && fromGh.length > 0) {
        return fromGh;
      }
      throw new GitHubAuthError();
    }
    const env = runtime.env ?? process.env;
    const fromEnv = firstNonEmpty(env.GH_TOKEN, env.GITHUB_TOKEN);
    if (fromEnv !== undefined) {
      return fromEnv;
    }
    const fromGh = await (runtime.ghAuthToken ?? ghAuthToken)();
    if (fromGh !== undefined && fromGh.length > 0) {
      return fromGh;
    }
    throw new GitHubAuthError();
  }

  async function graphql<T>(
    operationName: string,
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<T> {
    try {
      return await githubGraphql<T>(
        http,
        await token(),
        operationName,
        query,
        variables,
      );
    } catch (error) {
      if (
        error instanceof Error &&
        /could not resolve to a repository/i.test(error.message)
      ) {
        throw new GitHubCannotSeeError(options.repo);
      }
      if (
        error instanceof GitHubUnreachableError ||
        error instanceof GitHubAuthError ||
        error instanceof GitHubCannotSeeError
      ) {
        throw error;
      }
      const vendor = error instanceof Error ? error.message : String(error);
      throw new GitHubUnreachableError(vendor);
    }
  }

  async function rest(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<void> {
    await githubRest(http, await token(), method, path, body);
  }

  async function canExpressBlocking(): Promise<boolean> {
    const data = await graphql<SchemaProbeData>("SchemaProbe", schemaProbeQuery);
    return data.__type?.fields?.some((field) => field.name === "blockedBy") ??
      false;
  }

  async function existingLabels(): Promise<string[]> {
    const names: string[] = [];
    let cursor: string | null = null;
    while (true) {
      const data: LabelsData = await graphql<LabelsData>("Labels", labelsQuery, {
        owner,
        name,
        cursor,
      });
      const connection = data.repository?.labels;
      if (connection === undefined) {
        throw new Error(`GitHub repository ${options.repo} was not found`);
      }
      for (const node of connection.nodes) {
        if (node !== null) {
          names.push(node.name);
        }
      }
      if (!connection.pageInfo.hasNextPage) {
        break;
      }
      cursor = connection.pageInfo.endCursor;
    }
    return names;
  }

  async function inspect() {
    const [labels, blocking] = await Promise.all([
      existingLabels(),
      canExpressBlocking(),
    ]);
    return {
      existingLabels: labels,
      selectorLabels: options.labels,
      repository: options.repo,
      canExpressBlocking: blocking,
    };
  }

  return Object.assign(
    createTrackerAdapter({
      async frontier() {
        const blocking = await canExpressBlocking();
        if (!blocking) {
          throw new Error("GitHub cannot express blocking");
        }
        const tickets: Ticket[] = [];
        let cursor: string | null = null;
        while (true) {
          const data: FrontierData = await graphql<FrontierData>(
            "Frontier",
            frontierQuery,
            { owner, name, cursor },
          );
          const connection = data.repository?.issues;
          if (connection === undefined) {
            throw new Error(`GitHub repository ${options.repo} was not found`);
          }
          for (const node of connection.nodes) {
            if (node !== null) {
              tickets.push(toTicket(node, options.labels));
            }
          }
          if (!connection.pageInfo.hasNextPage) {
            break;
          }
          cursor = connection.pageInfo.endCursor;
        }
        return tickets
          .filter((ticket) => matchesFrontier(ticket, options))
          .sort((a, b) =>
            a.id.localeCompare(b.id, undefined, { numeric: true }),
          );
      },
      branchName(ticket) {
        return `readyrun/${ticket.id}`;
      },
      async leaveFrontier(ticket, landing) {
        for (const label of options.labels) {
          await rest(
            "DELETE",
            `/repos/${owner}/${name}/issues/${ticket.id}/labels/${encodeURIComponent(label)}`,
          );
        }
        await rest(
          "POST",
          `/repos/${owner}/${name}/issues/${ticket.id}/comments`,
          { body: landingComment(landing) },
        );
      },
      promptCopy(ticket) {
        return `This Ticket is GitHub #${ticket.id}.\nTitle: ${ticket.title}\n\n${ticket.body}\n\n${ticket.url}`;
      },
      inspect,
    }),
    { options },
  );
}

// The Ticket's own Branch is gone by the time this is written (ADR 0028), so
// the Run Branch and the merge commit are the only pointers a reviewer has —
// and the ref is disclosed as local, because ReadyRun never pushes and a Ticket
// naming an unfetchable ref as though it were shared is a lie (ADR 0033).
function landingComment(landing: Landing): string {
  return [
    "ReadyRun: this Ticket left the Frontier after a successful Worker.",
    "",
    `The work landed on the Run Branch \`${landing.runBranch}\` as merge commit \`${
      shortCommit(landing.mergeCommit)
    }\`. That ref is local to the machine that ran the Run — ReadyRun never pushes, so it cannot be fetched from anywhere else.`,
  ].join("\n");
}

function matchesFrontier(
  ticket: Ticket,
  options: GitHubTrackerOptions,
): boolean {
  if (!options.labels.every((label) => ticket.labels.includes(label))) {
    return false;
  }
  if (options.parent !== undefined && ticket.parent !== options.parent) {
    return false;
  }
  if (options.ids !== undefined && !options.ids.includes(ticket.id)) {
    return false;
  }
  return ticket.blockedBy.length === 0;
}

function toTicket(node: IssueNode, selectorLabels: readonly string[]): Ticket {
  const labels = names(node.labels.nodes);
  const blockedBy = (node.blockedBy?.nodes ?? []).flatMap((blocker) => {
    if (blocker === null) {
      return [];
    }
    // Success drops labels and does not close, so an open blocker only still
    // blocks while it matches the selector.
    const stillBlocking = blocker.state === "OPEN" &&
      selectorLabels.every((label) => names(blocker.labels.nodes).includes(label));
    return stillBlocking ? [String(blocker.number)] : [];
  });
  return {
    id: String(node.number),
    title: node.title,
    body: node.body ?? "",
    url: node.url,
    labels,
    blockedBy,
    parent: node.parent === null ? undefined : String(node.parent.number),
  };
}

function names(nodes: (LabelNode | null)[]): string[] {
  return nodes.flatMap((node) => node === null ? [] : [node.name]);
}

function splitRepo(repo: string): { owner: string; name: string } {
  const trimmed = repo.trim().replace(/\/+$/, "").replace(/\.git$/i, "");
  const [owner, name, ...rest] = trimmed.split("/");
  if (owner === undefined || name === undefined || rest.length > 0) {
    throw new Error(`GitHub repo must be owner/name, got ${repo}`);
  }
  return { owner, name };
}

function firstNonEmpty(
  ...values: (string | undefined)[]
): string | undefined {
  return values.find((value) => value !== undefined && value.length > 0);
}

const githubHeaders = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "Content-Type": "application/json",
  "User-Agent": "readyrun",
  "X-GitHub-Api-Version": "2022-11-28",
});

class GitHubUnreachableError extends Error {
  constructor(vendor: string) {
    super(
      `ReadyRun could not reach GitHub. Check Tracker auth and network. ${vendor}`,
    );
    this.name = "GitHubUnreachableError";
  }
}

class GitHubAuthError extends Error {
  constructor() {
    super(
      "ReadyRun could not authenticate to GitHub. Check the GitHub token.",
    );
    this.name = "GitHubAuthError";
  }
}

class GitHubCannotSeeError extends Error {
  constructor(repo: string) {
    super(
      `this token cannot see GitHub repository ${repo}. Check the token's access to that repository.`,
    );
    this.name = "GitHubCannotSeeError";
  }
}

async function githubGraphql<T>(
  http: typeof fetch,
  token: string,
  operationName: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const response = await http("https://api.github.com/graphql", {
    method: "POST",
    headers: githubHeaders(token),
    body: JSON.stringify({ query, variables, operationName }),
  });
  const payload = await response.json() as {
    data?: T;
    errors?: { message: string }[];
  };
  if (!response.ok) {
    if (response.status === 401) {
      throw new GitHubAuthError();
    }
    throw new GitHubUnreachableError(`GitHub GraphQL HTTP ${response.status}`);
  }
  if (payload.errors !== undefined && payload.errors.length > 0) {
    throw new Error(payload.errors[0]?.message ?? "GitHub GraphQL error");
  }
  if (payload.data === undefined) {
    throw new GitHubUnreachableError("GitHub GraphQL returned no data");
  }
  return payload.data;
}

async function githubRest(
  http: typeof fetch,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<void> {
  const response = await http(`https://api.github.com${path}`, {
    method,
    headers: githubHeaders(token),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    if (response.status === 401) {
      throw new GitHubAuthError();
    }
    throw new GitHubUnreachableError(`GitHub REST HTTP ${response.status}`);
  }
}

async function gitConfigGitHubAccount(
  runtime: GitHubRuntime,
): Promise<string | undefined> {
  try {
    const { stdout } = await exec(
      "git",
      ["-C", runtime.cwd ?? process.cwd(), "config", "github.account"],
      {
        encoding: "utf8",
        env: { ...process.env, ...runtime.env },
      },
    );
    const account = stdout.trim();
    return account.length === 0 ? undefined : account;
  } catch {
    return undefined;
  }
}

async function ghAuthToken(account?: string): Promise<string | undefined> {
  try {
    const args = account === undefined
      ? ["auth", "token"]
      : ["auth", "token", "--hostname", "github.com", "--user", account];
    const { stdout } = await exec("gh", args, { encoding: "utf8" });
    const token = stdout.trim();
    return token.length === 0 ? undefined : token;
  } catch {
    return undefined;
  }
}
