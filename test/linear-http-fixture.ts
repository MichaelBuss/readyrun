import { linear, type LinearTrackerOptions } from "../src/mod.ts";
import type { MemoryTrackerOptions } from "../src/testing/memory-tracker.ts";

export type LinearRecordedRequest = {
  method: string;
  url: string;
  body: string | undefined;
};

type FixtureState = {
  id: string;
  name: string;
  type: "backlog" | "unstarted" | "started" | "completed" | "canceled";
};

type FixtureIssue = {
  identifier: string;
  title: string;
  description: string;
  url: string;
  labels: string[];
  blockedBy: string[];
  parent: string | undefined;
  project: string | undefined;
  state: string;
  branchName: string;
};

export type LinearWorld = MemoryTrackerOptions & {
  state?: string;
  project?: string;
  existingStates?: string[];
  existingProjects?: string[];
  suggestedBranchNames?: Record<string, string>;
  ticketStates?: Record<string, string>;
  ticketProjects?: Record<string, string>;
};

export type LinearHttpFixture = {
  fetch: typeof fetch;
  requests: readonly LinearRecordedRequest[];
};

const todoState: FixtureState = {
  id: "state-todo",
  name: "Todo",
  type: "unstarted",
};
const inReviewState: FixtureState = {
  id: "state-in-review",
  name: "In Review",
  type: "started",
};
const doneState: FixtureState = {
  id: "state-done",
  name: "Done",
  type: "completed",
};

export const linearInReviewStateId = inReviewState.id;
export const linearDoneStateId = doneState.id;

export function linearFromWorld(
  world: LinearWorld,
): { adapter: ReturnType<typeof linear>; fixture: LinearHttpFixture } {
  const fixture = linearHttpFixture(world);
  const label = world.labels[0];
  const options: LinearTrackerOptions = {
    ready: world.ready,
    state: world.state,
    label,
    project: world.project,
    parent: world.parent,
    ids: world.ids,
  };
  return {
    fixture,
    adapter: linear(options, { token: "test-token", fetch: fixture.fetch }),
  };
}

export function linearHttpFixture(world: LinearWorld): LinearHttpFixture {
  const issues: FixtureIssue[] = world.tickets.map((ticket) => ({
    identifier: ticket.id,
    title: ticket.title,
    description: ticket.body,
    url: ticket.url,
    labels: [...ticket.labels],
    blockedBy: [...ticket.blockedBy],
    parent: ticket.parent,
    project: world.ticketProjects?.[ticket.id],
    state: world.ticketStates?.[ticket.id] ?? "Todo",
    branchName: world.suggestedBranchNames?.[ticket.id] ?? "",
  }));
  const existingLabels = world.existingLabels ?? [
    ...new Set([
      ...world.labels,
      ...world.tickets.flatMap((ticket) => ticket.labels),
    ]),
  ];
  const existingStates = world.existingStates ?? [
    todoState.name,
    inReviewState.name,
    doneState.name,
  ];
  const existingProjects = world.existingProjects ??
    (world.project === undefined ? [] : [world.project]);
  const canExpressBlocking = world.canExpressBlocking ?? true;
  const requests: LinearRecordedRequest[] = [];

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = requestUrl(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : undefined;
    requests.push({ method, url, body });

    const headers = headerMap(init?.headers);
    if (headers.authorization !== "test-token") {
      return jsonResponse({ errors: [{ message: "Authentication required" }] }, 401);
    }

    if (url !== "https://api.linear.app/graphql") {
      return jsonResponse({ errors: [{ message: "Not Found" }] }, 404);
    }

    return graphqlResponse(
      body,
      issues,
      existingLabels,
      existingStates,
      existingProjects,
      canExpressBlocking,
    );
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

function statesFromNames(names: readonly string[]): FixtureState[] {
  return names.map((name) => {
    if (name === inReviewState.name) {
      return inReviewState;
    }
    if (name === doneState.name) {
      return doneState;
    }
    if (name === todoState.name) {
      return todoState;
    }
    return { id: `state-${name}`, name, type: "started" };
  });
}

function graphqlResponse(
  body: string | undefined,
  issues: FixtureIssue[],
  existingLabels: readonly string[],
  existingStates: readonly string[],
  existingProjects: readonly string[],
  canExpressBlocking: boolean,
): Response {
  const parsed = body === undefined
    ? { operationName: "", variables: {} }
    : JSON.parse(body) as {
      operationName?: string;
      variables?: {
        id?: string;
        cursor?: string;
        input?: { stateId?: string };
      };
    };
  const operation = parsed.operationName ?? "";
  const variables = parsed.variables ?? {};
  const states = statesFromNames(existingStates);

  if (operation === "SchemaProbe") {
    const fields = canExpressBlocking
      ? [{ name: "inverseRelations" }, { name: "title" }]
      : [{ name: "title" }];
    return jsonResponse({ data: { __type: { fields } } }, 200);
  }

  if (operation === "IssueLabels") {
    return jsonResponse({
      data: {
        issueLabels: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: existingLabels.map((name) => ({ name })),
        },
      },
    }, 200);
  }

  if (operation === "WorkflowStates") {
    return jsonResponse({
      data: {
        workflowStates: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: states,
        },
      },
    }, 200);
  }

  if (operation === "Projects") {
    return jsonResponse({
      data: {
        projects: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: existingProjects.map((name) => ({ name })),
        },
      },
    }, 200);
  }

  if (operation === "Frontier") {
    const nodes = issues.map((issue) => toFrontierNode(issue, issues));
    return jsonResponse({
      data: {
        issues: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes,
        },
      },
    }, 200);
  }

  if (operation === "IssueStates") {
    const issue = issues.find((candidate) => candidate.identifier === variables.id);
    if (issue === undefined) {
      return jsonResponse({ data: { issue: null } }, 200);
    }
    return jsonResponse({
      data: {
        issue: {
          id: issue.identifier,
          team: {
            states: { nodes: states },
          },
        },
      },
    }, 200);
  }

  if (operation === "LeaveFrontier") {
    const issue = issues.find((candidate) => candidate.identifier === variables.id);
    const stateId = variables.input?.stateId;
    const next = states.find((state) => state.id === stateId);
    if (issue !== undefined && next !== undefined) {
      issue.state = next.name;
    }
    return jsonResponse({
      data: {
        issueUpdate: {
          success: true,
          issue: issue === undefined
            ? null
            : {
              identifier: issue.identifier,
              state: {
                name: issue.state,
                type: states.find((state) => state.name === issue.state)?.type ??
                  "started",
              },
            },
        },
      },
    }, 200);
  }

  return jsonResponse({
    errors: [{ message: `Unknown GraphQL operation ${operation}` }],
  }, 200);
}

function toFrontierNode(issue: FixtureIssue, issues: FixtureIssue[]) {
  const state = statesFromNames([issue.state])[0] ?? todoState;
  return {
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    url: issue.url,
    branchName: issue.branchName,
    state: { id: state.id, name: state.name, type: state.type },
    labels: { nodes: issue.labels.map((name) => ({ name })) },
    project: issue.project === undefined ? null : { name: issue.project },
    parent: issue.parent === undefined ? null : { identifier: issue.parent },
    inverseRelations: {
      nodes: issue.blockedBy.map((identifier) => {
        const blocker = issues.find((candidate) => candidate.identifier === identifier);
        const blockerState = statesFromNames([blocker?.state ?? "Todo"])[0] ??
          todoState;
        return {
          type: "blocks",
          issue: {
            identifier,
            state: { name: blockerState.name, type: blockerState.type },
            labels: {
              nodes: (blocker?.labels ?? []).map((name) => ({ name })),
            },
            project: blocker?.project === undefined
              ? null
              : { name: blocker.project },
          },
        };
      }),
    },
  };
}
