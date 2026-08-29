import { github, type GitHubTrackerOptions } from "../src/mod.ts";
import type { MemoryTrackerOptions } from "../src/testing/memory-tracker.ts";

export type GitHubRecordedRequest = {
  method: string;
  url: string;
  body: string | undefined;
};

type FixtureIssue = {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
  blockedBy: number[];
  parent: number | undefined;
  state: "OPEN" | "CLOSED";
  comments: string[];
};

export type GitHubHttpFixture = {
  fetch: typeof fetch;
  requests: readonly GitHubRecordedRequest[];
};

export function githubFromWorld(
  world: MemoryTrackerOptions,
  repo = "acme/widgets",
): { adapter: ReturnType<typeof github>; fixture: GitHubHttpFixture } {
  const fixture = githubHttpFixture({ repo, ...world });
  const options: GitHubTrackerOptions = {
    repo,
    ready: world.ready,
    labels: world.labels,
    parent: world.parent,
    ids: world.ids,
  };
  return {
    fixture,
    adapter: github(options, { token: "test-token", fetch: fixture.fetch }),
  };
}

export function githubHttpFixture(
  world: MemoryTrackerOptions & { repo: string },
): GitHubHttpFixture {
  const issues: FixtureIssue[] = world.tickets.map((ticket) => ({
    number: Number(ticket.id),
    title: ticket.title,
    body: ticket.body,
    url: ticket.url,
    labels: [...ticket.labels],
    blockedBy: ticket.blockedBy.map((id) => Number(id)),
    parent: ticket.parent === undefined ? undefined : Number(ticket.parent),
    state: "OPEN",
    comments: [],
  }));
  const existingLabels = world.existingLabels ?? [
    ...new Set([
      ...world.labels,
      ...world.tickets.flatMap((ticket) => ticket.labels),
    ]),
  ];
  const canExpressBlocking = world.canExpressBlocking ?? true;
  const requests: GitHubRecordedRequest[] = [];
  const [owner, name] = world.repo.split("/");

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = requestUrl(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : undefined;
    requests.push({ method, url, body });

    const headers = headerMap(init?.headers);
    if (headers.authorization !== "Bearer test-token") {
      return jsonResponse({ message: "Bad credentials" }, 401);
    }

    if (url === "https://api.github.com/graphql") {
      return graphqlResponse(
        body,
        issues,
        existingLabels,
        canExpressBlocking,
        owner,
        name,
      );
    }

    const deleted = url.match(
      /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/labels\/(.+)$/,
    );
    if (method === "DELETE" && deleted !== null) {
      const issue = issues.find((issue) => String(issue.number) === deleted[3]);
      const label = decodeURIComponent(deleted[4] ?? "");
      if (issue !== undefined) {
        issue.labels = issue.labels.filter((name) => name !== label);
      }
      return jsonResponse({}, 200);
    }

    const commented = url.match(
      /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/,
    );
    if (method === "POST" && commented !== null) {
      const issue = issues.find((issue) => String(issue.number) === commented[3]);
      const parsed = body === undefined ? {} : JSON.parse(body) as { body?: string };
      if (issue !== undefined && parsed.body !== undefined) {
        issue.comments.push(parsed.body);
      }
      return jsonResponse({ id: 1 }, 201);
    }

    return jsonResponse({ message: "Not Found" }, 404);
  };

  return { fetch: fetchImpl, requests };
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

function headerMap(headers: RequestInit["headers"]): Record<string, string> {
  const result: Record<string, string> = {};
  if (headers === undefined) {
    return result;
  }
  if (headers instanceof Headers) {
    for (const [key, value] of headers.entries()) {
      result[key.toLowerCase()] = value;
    }
    return result;
  }
  if (Array.isArray(headers)) {
    for (const pair of headers) {
      result[pair[0].toLowerCase()] = pair[1];
    }
    return result;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      result[key.toLowerCase()] = value;
    }
  }
  return result;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function graphqlResponse(
  body: string | undefined,
  issues: FixtureIssue[],
  existingLabels: readonly string[],
  canExpressBlocking: boolean,
  owner: string | undefined,
  name: string | undefined,
): Response {
  const parsed = body === undefined
    ? { operationName: "", variables: {} }
    : JSON.parse(body) as {
      operationName?: string;
      query?: string;
      variables?: { owner?: string; name?: string };
    };
  const operation = parsed.operationName ?? "";
  const variables = parsed.variables ?? {};
  if (
    variables.owner !== undefined &&
    variables.name !== undefined &&
    (variables.owner !== owner || variables.name !== name)
  ) {
    return jsonResponse({ data: { repository: null } }, 200);
  }

  if (operation === "SchemaProbe") {
    const fields = canExpressBlocking
      ? [{ name: "blockedBy" }, { name: "title" }]
      : [{ name: "title" }];
    return jsonResponse({ data: { __type: { fields } } }, 200);
  }

  if (operation === "Labels") {
    return jsonResponse({
      data: {
        repository: {
          labels: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: existingLabels.map((labelName) => ({ name: labelName })),
          },
        },
      },
    }, 200);
  }

  if (operation === "Frontier") {
    const nodes = issues
      .filter((issue) => issue.state === "OPEN")
      .map((issue) => ({
        number: issue.number,
        title: issue.title,
        body: issue.body,
        url: issue.url,
        labels: { nodes: issue.labels.map((labelName) => ({ name: labelName })) },
        parent: issue.parent === undefined ? null : { number: issue.parent },
        blockedBy: {
          nodes: issue.blockedBy.map((number) => {
            const blocker = issues.find((candidate) => candidate.number === number);
            return {
              number,
              state: blocker?.state ?? "OPEN",
              labels: {
                nodes: (blocker?.labels ?? []).map((labelName) => ({ name: labelName })),
              },
            };
          }),
        },
      }));
    return jsonResponse({
      data: {
        repository: {
          issues: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes,
          },
        },
      },
    }, 200);
  }

  return jsonResponse({
    errors: [{ message: `Unknown GraphQL operation ${operation}` }],
  }, 200);
}
