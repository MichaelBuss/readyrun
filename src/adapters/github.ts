import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { landingComment } from "../landing-comment.ts";
import {
  blockingProbeOnce,
  graphqlRead,
  paginate,
  rootedRead,
  type TrackerPage,
  type TrackerPageInfo,
} from "../tracker-adapter-floor.ts";
import {
  createTrackerAdapter,
  type TrackerAdapter,
} from "../tracker-adapter.ts";
import type { Ticket } from "../ticket.ts";
import { assertKnownKeys } from "../unknown-keys.ts";
import { stripRepoDecorations } from "../repository.ts";

const exec = promisify(execFile);

const knownGitHubKeys = new Set([
  "repo",
  "ready",
  "labels",
  "parent",
  "ids",
  "account",
]);

/**
 * The GitHub Tracker Adapter's options: the repository, the Frontier
 * selector, and the optional Root. The selector is `ready: "unblocked"`
 * plus `labels`; the Root is a `parent` — whose children become the
 * Frontier — or an explicit `ids` list, never both.
 */
export type GitHubTrackerOptions = {
  /** The repository, `owner/name`; must be the checkout's git remote. */
  repo: string;
  /** The readiness half of the Frontier selector; `"unblocked"` today. */
  ready: "unblocked";
  /** The labels the Frontier selector requires. */
  labels: string[];
  /** The parent Ticket whose children become the Frontier. */
  parent?: string;
  /** The explicit Ticket list; bypasses the selector, never `unblocked`. */
  ids?: string[];
  /** The `gh` account to authenticate as, when the checkout has several. */
  account?: string;
};

export type GitHubRuntime = {
  fetch?: typeof fetch;
  token?: string;
  env?: Record<string, string | undefined>;
  cwd?: string;
  ghAuthToken?: (account?: string) => Promise<string | undefined>;
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

const ticketQuery = `query Ticket($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) { number state }
  }
}`;

type SchemaProbeData = {
  __type: { fields: { name: string }[] | null } | null;
};

type LabelsData = {
  repository: {
    labels: TrackerPage<LabelNode>;
  } | null;
};

type FrontierData = {
  repository: {
    issues: TrackerPage<IssueNode>;
  } | null;
};

type TicketData = {
  repository: {
    issue: { number: number; state: "OPEN" | "CLOSED" } | null;
  } | null;
};

/**
 * The GitHub Tracker Adapter: talks to one repository's GraphQL API, with
 * auth from `gh` (or `runtime.token`). GitHub calls the work "issues"; this
 * Adapter is where that word stays, mapping each onto a Ticket. Pick order
 * is issue number ascending.
 *
 * @param options The repository, the Frontier selector, and the optional Root.
 * @param runtime The seams tests inject: fetch, token, env, working directory.
 */
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
      return await graphqlRead<T>({
        http,
        endpoint: "https://api.github.com/graphql",
        headers: githubHeaders(await token()),
        operationName,
        query,
        variables,
        errors: {
          auth: () => new GitHubAuthError(),
          unreachable: (detail) =>
            new GitHubUnreachableError(`GitHub GraphQL ${detail}`),
        },
      });
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

  // The blocking-expression probe is a schema fact, not a per-call one: the
  // floor reads it once per process, so frontier, waiting, tree, and inspect
  // share the first answer.
  function canExpressBlocking(): Promise<boolean> {
    return blockingProbeOnce(http, options.repo, async () => {
      const data = await graphql<SchemaProbeData>("SchemaProbe", schemaProbeQuery);
      return data.__type?.fields?.some((field) => field.name === "blockedBy") ??
        false;
    });
  }

  async function refuseWhenBlockingUnexpressable(): Promise<void> {
    if (!(await canExpressBlocking())) {
      throw new Error("GitHub cannot express blocking");
    }
  }

  async function existingLabels(): Promise<string[]> {
    const nodes = await paginate<LabelNode>(async (cursor) => {
      const data: LabelsData = await graphql<LabelsData>("Labels", labelsQuery, {
        owner,
        name,
        cursor,
      });
      const connection = data.repository?.labels;
      if (connection === undefined) {
        throw new Error(`GitHub repository ${options.repo} was not found`);
      }
      return connection;
    });
    return nodes.map((node) => node.name);
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
      // The fact deliver reads to resolve its forge port (ADR 0048); the
      // Adapter itself stays forgeless by the single-writer rule.
      forge: "github",
    };
  }

  async function probeTicket(id: string): Promise<"OPEN" | "CLOSED" | null> {
    const number = Number(id);
    if (!Number.isInteger(number)) {
      return null;
    }
    const data = await graphql<TicketData>("Ticket", ticketQuery, {
      owner,
      name,
      number,
    });
    return data.repository?.issue?.state ?? null;
  }

  // The Frontier query only answers open issues, so a named Ticket missing
  // from it is probed: a closed Ticket is a lie, and so is a nonexistent one.
  // An open probe result stands — a parent may simply have no open children.
  async function refuseClosedOrMissing(id: string): Promise<void> {
    const probed = await probeTicket(id);
    if (probed === "OPEN") {
      return;
    }
    if (probed === "CLOSED") {
      throw new Error(
        `Ticket ${id} is closed on GitHub repository ${options.repo}`,
      );
    }
    throw new Error(
      `Ticket ${id} does not exist on GitHub repository ${options.repo}`,
    );
  }

  // One page of the open candidates read, every open Issue as the API
  // answers it; the floor owns the paging loop, the root policy, and the
  // mapping onto Tickets (ADR 0038). A list root reads with the selector
  // off, so a bypassed selector does not judge its own blockers.
  async function readCandidatesPage(
    cursor: string | null,
  ): Promise<TrackerPage<IssueNode>> {
    const data: FrontierData = await graphql<FrontierData>(
      "Frontier",
      frontierQuery,
      { owner, name, cursor },
    );
    const connection = data.repository?.issues;
    if (connection === undefined) {
      throw new Error(`GitHub repository ${options.repo} was not found`);
    }
    return connection;
  }

  // The rooted read answers all three rooted methods (ADR 0038): frontier and
  // waiting are its halves, tree is the whole answer (ADR 0039). The
  // selector's own match is labels — GitHub's vocabulary (ADR 0016); the
  // root policy stays in the floor.
  const read = rootedRead<IssueNode>(
    {
      refuseWhenBlockingUnexpressable,
      readCandidatesPage,
      refuseLie: refuseClosedOrMissing,
      toTicket: (node, selectorApplies) =>
        toTicket(node, selectorApplies ? options.labels : []),
    },
    {
      matches: (node) => {
        const labels = names(node.labels.nodes);
        return options.labels.every((label) => labels.includes(label));
      },
      parent: options.parent,
      ids: options.ids,
    },
  );

  return Object.assign(
    createTrackerAdapter({
      frontier: (root) => read(root).then((answer) => [...answer.frontier]),
      waiting: (root) => read(root).then((answer) => [...answer.waiting]),
      tree: read,
      async tickets(ids) {
        // One paged read of the open candidates, so a family of Tickets is
        // one network read, then each named id answered with its Tracker
        // facts (ADR 0048). The candidates read answers open Issues only, so
        // a named id absent from it is probed: a closed Ticket is a lie, and
        // so is a nonexistent one — refused, never answered absent.
        const nodes = await paginate<IssueNode>((cursor) =>
          readCandidatesPage(cursor)
        );
        const byNumber = new Map(nodes.map((node) => [String(node.number), node]));
        for (const id of ids) {
          if (!byNumber.has(id)) {
            await refuseClosedOrMissing(id);
          }
        }
        return ids.map((id) => toTicket(byNumber.get(id)!, []));
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

function toTicket(node: IssueNode, selectorLabels: readonly string[]): Ticket {
  const labels = names(node.labels.nodes);
  // The blocking relation's two halves, judged by the same test: an open
  // blocker only still blocks while it matches the selector (success drops
  // labels and does not close). The blockers that no longer block are the
  // ones that left the Frontier — kept on the Ticket so the Plan can walk
  // their merge markers against the base (ADR 0050).
  const blockedBy: string[] = [];
  const leftFrontierBlockers: string[] = [];
  for (const blocker of node.blockedBy?.nodes ?? []) {
    if (blocker === null) {
      continue;
    }
    const stillBlocking = blocker.state === "OPEN" &&
      selectorLabels.every((label) => names(blocker.labels.nodes).includes(label));
    (stillBlocking ? blockedBy : leftFrontierBlockers).push(
      String(blocker.number),
    );
  }
  return {
    id: String(node.number),
    title: node.title,
    body: node.body ?? "",
    url: node.url,
    labels,
    blockedBy,
    ...(leftFrontierBlockers.length > 0 ? { leftFrontierBlockers } : {}),
    parent: node.parent === null ? undefined : String(node.parent.number),
  };
}

function names(nodes: (LabelNode | null)[]): string[] {
  return nodes.flatMap((node) => node === null ? [] : [node.name]);
}

function splitRepo(repo: string): { owner: string; name: string } {
  const [owner, name, ...rest] = stripRepoDecorations(repo).split("/");
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
