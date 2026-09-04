import {
  createTrackerAdapter,
  type TrackerAdapter,
} from "../tracker-adapter.ts";
import type { Ticket } from "../ticket.ts";
import { assertKnownKeys } from "../unknown-keys.ts";

const knownLinearKeys = new Set([
  "ready",
  "state",
  "label",
  "project",
  "parent",
  "ids",
]);

export type LinearTrackerOptions = {
  ready: "unblocked";
  state?: string;
  label?: string;
  project?: string;
  parent?: string;
  ids?: string[];
};

export type LinearRuntime = {
  fetch?: typeof fetch;
  token?: string;
  env?: Record<string, string | undefined>;
};

type PageInfo = {
  hasNextPage: boolean;
  endCursor: string | null;
};

type LabelNode = { name: string };
type ProjectNode = { name: string };
type StateNode = {
  id: string;
  name: string;
  type: string;
};

type IssueNode = {
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  branchName: string | null;
  state: StateNode;
  labels: { nodes: (LabelNode | null)[] };
  project: ProjectNode | null;
  parent: { identifier: string } | null;
  inverseRelations?: {
    nodes: ({
      type: string;
      issue: {
        identifier: string;
        state: { name: string; type: string };
      };
    } | null)[];
  };
};

const schemaProbeQuery = `query SchemaProbe {
  __type(name: "Issue") {
    fields { name }
  }
}`;

const issueLabelsQuery = `query IssueLabels($cursor: String) {
  issueLabels(first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes { name }
  }
}`;

const workflowStatesQuery = `query WorkflowStates($cursor: String) {
  workflowStates(first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes { id name type }
  }
}`;

const projectsQuery = `query Projects($cursor: String) {
  projects(first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes { name }
  }
}`;

const frontierQuery = `query Frontier($cursor: String) {
  issues(first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      identifier
      title
      description
      url
      branchName
      state { id name type }
      labels(first: 50) { nodes { name } }
      project { name }
      parent { identifier }
      inverseRelations(first: 50) {
        nodes {
          type
          issue {
            identifier
            state { name type }
          }
        }
      }
    }
  }
}`;

const issueStatesQuery = `query IssueStates($id: String!) {
  issue(id: $id) {
    id
    team {
      states {
        nodes { id name type }
      }
    }
  }
}`;

const leaveFrontierMutation = `mutation LeaveFrontier($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) {
    success
    issue { identifier state { name type } }
  }
}`;

type SchemaProbeData = {
  __type: { fields: { name: string }[] | null } | null;
};

type IssueLabelsData = {
  issueLabels: { pageInfo: PageInfo; nodes: (LabelNode | null)[] };
};

type WorkflowStatesData = {
  workflowStates: { pageInfo: PageInfo; nodes: (StateNode | null)[] };
};

type ProjectsData = {
  projects: { pageInfo: PageInfo; nodes: (ProjectNode | null)[] };
};

type FrontierData = {
  issues: { pageInfo: PageInfo; nodes: (IssueNode | null)[] };
};

type IssueStatesData = {
  issue: {
    team: { states: { nodes: (StateNode | null)[] } };
  } | null;
};

export function linear(
  options: LinearTrackerOptions,
  runtime: LinearRuntime = {},
): TrackerAdapter {
  assertKnownKeys(options, knownLinearKeys);
  if (
    options.state === undefined &&
    options.label === undefined &&
    options.project === undefined
  ) {
    throw new Error("Linear Frontier needs a state, label, or project");
  }
  const http = runtime.fetch ?? fetch;
  const suggestedBranches = new Map<string, string>();

  async function token(): Promise<string> {
    if (runtime.token !== undefined && runtime.token.length > 0) {
      return runtime.token;
    }
    const env = runtime.env ?? process.env;
    const fromEnv = env.LINEAR_API_KEY;
    if (fromEnv !== undefined && fromEnv.length > 0) {
      return fromEnv;
    }
    throw new LinearAuthError();
  }

  async function graphql<T>(
    operationName: string,
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<T> {
    try {
      return await linearGraphql<T>(
        http,
        await token(),
        operationName,
        query,
        variables,
      );
    } catch (error) {
      if (
        error instanceof LinearUnreachableError ||
        error instanceof LinearAuthError
      ) {
        throw error;
      }
      const vendor = error instanceof Error ? error.message : String(error);
      throw new LinearUnreachableError(vendor);
    }
  }

  async function canExpressBlocking(): Promise<boolean> {
    const data = await graphql<SchemaProbeData>("SchemaProbe", schemaProbeQuery);
    return data.__type?.fields?.some((field) => field.name === "inverseRelations") ??
      false;
  }

  async function paginate<T, N>(
    operationName: string,
    query: string,
    connection: (data: T) => { pageInfo: PageInfo; nodes: (N | null)[] },
  ): Promise<N[]> {
    const nodes: N[] = [];
    let cursor: string | null = null;
    while (true) {
      const data: T = await graphql<T>(operationName, query, { cursor });
      const page = connection(data);
      for (const node of page.nodes) {
        if (node !== null) {
          nodes.push(node);
        }
      }
      if (!page.pageInfo.hasNextPage) {
        break;
      }
      cursor = page.pageInfo.endCursor;
    }
    return nodes;
  }

  async function inspect() {
    const [labels, states, projects, blocking] = await Promise.all([
      paginate<IssueLabelsData, LabelNode>(
        "IssueLabels",
        issueLabelsQuery,
        (data) => data.issueLabels,
      ),
      paginate<WorkflowStatesData, StateNode>(
        "WorkflowStates",
        workflowStatesQuery,
        (data) => data.workflowStates,
      ),
      paginate<ProjectsData, ProjectNode>(
        "Projects",
        projectsQuery,
        (data) => data.projects,
      ),
      canExpressBlocking(),
    ]);
    return {
      existingLabels: labels.map((label) => label.name),
      selectorLabels: options.label === undefined ? [] : [options.label],
      existingStates: states.map((state) => state.name),
      selectorState: options.state,
      existingProjects: projects.map((project) => project.name),
      selectorProject: options.project,
      canExpressBlocking: blocking,
    };
  }

  return Object.assign(
    createTrackerAdapter({
      async frontier() {
        const blocking = await canExpressBlocking();
        if (!blocking) {
          throw new Error("Linear cannot express blocking");
        }
        suggestedBranches.clear();
        const issues = await paginate<FrontierData, IssueNode>(
          "Frontier",
          frontierQuery,
          (data) => data.issues,
        );
        const tickets: Ticket[] = [];
        for (const node of issues) {
          if (!matchesFrontier(node, options)) {
            continue;
          }
          const ticket = toTicket(node);
          tickets.push(ticket);
          if (node.branchName !== null && node.branchName.length > 0) {
            suggestedBranches.set(ticket.id, node.branchName);
          }
        }
        return tickets.sort((a, b) =>
          a.id.localeCompare(b.id, undefined, { numeric: true }),
        );
      },
      branchName(ticket) {
        return suggestedBranches.get(ticket.id) ?? `readyrun/${ticket.id}`;
      },
      async leaveFrontier(ticket) {
        const data = await graphql<IssueStatesData>(
          "IssueStates",
          issueStatesQuery,
          { id: ticket.id },
        );
        const states = data.issue?.team.states.nodes ?? [];
        const inReview = states.find((state): state is StateNode =>
          state !== null && state.name === "In Review" &&
          state.type !== "completed"
        );
        if (inReview === undefined) {
          throw new Error(
            `Linear has no In Review state for Ticket ${ticket.id}`,
          );
        }
        await graphql("LeaveFrontier", leaveFrontierMutation, {
          id: ticket.id,
          input: { stateId: inReview.id },
        });
      },
      promptCopy(ticket) {
        return `This Ticket is Linear ${ticket.id}.\nTitle: ${ticket.title}\n\n${ticket.body}\n\n${ticket.url}`;
      },
      inspect,
    }),
    { options },
  );
}

function matchesFrontier(
  node: IssueNode,
  options: LinearTrackerOptions,
): boolean {
  if (options.state === undefined && hasLeftFrontier(node.state)) {
    return false;
  }
  if (
    options.label !== undefined &&
    !names(node.labels.nodes).includes(options.label)
  ) {
    return false;
  }
  if (options.state !== undefined && node.state.name !== options.state) {
    return false;
  }
  if (
    options.project !== undefined &&
    (node.project === null || node.project.name !== options.project)
  ) {
    return false;
  }
  if (
    options.parent !== undefined &&
    (node.parent === null || node.parent.identifier !== options.parent)
  ) {
    return false;
  }
  if (options.ids !== undefined && !options.ids.includes(node.identifier)) {
    return false;
  }
  return blockedBy(node).length === 0;
}

function blockedBy(node: IssueNode): string[] {
  return (node.inverseRelations?.nodes ?? []).flatMap((relation) => {
    if (relation === null || relation.type !== "blocks") {
      return [];
    }
    const blocker = relation.issue;
    if (hasLeftFrontier(blocker.state)) {
      return [];
    }
    return [blocker.identifier];
  });
}

function toTicket(node: IssueNode): Ticket {
  return {
    id: node.identifier,
    title: node.title,
    body: node.description ?? "",
    url: node.url,
    labels: names(node.labels.nodes),
    blockedBy: blockedBy(node),
    parent: node.parent === null ? undefined : node.parent.identifier,
  };
}

function hasLeftFrontier(state: { name: string; type: string }): boolean {
  return state.name === "In Review" ||
    state.type === "completed" ||
    state.type === "canceled";
}

function names(nodes: (LabelNode | null)[]): string[] {
  return nodes.flatMap((node) => node === null ? [] : [node.name]);
}

class LinearUnreachableError extends Error {
  constructor(vendor: string) {
    super(
      `ReadyRun could not reach Linear. Check Tracker auth and network. ${vendor}`,
    );
    this.name = "LinearUnreachableError";
  }
}

class LinearAuthError extends Error {
  constructor() {
    super(
      "ReadyRun could not authenticate to Linear. Check the Linear token.",
    );
    this.name = "LinearAuthError";
  }
}

async function linearGraphql<T>(
  http: typeof fetch,
  token: string,
  operationName: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const response = await http("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables, operationName }),
  });
  const payload = await response.json() as {
    data?: T;
    errors?: { message: string }[];
  };
  if (!response.ok) {
    if (response.status === 401) {
      throw new LinearAuthError();
    }
    throw new LinearUnreachableError(`Linear GraphQL HTTP ${response.status}`);
  }
  if (payload.errors !== undefined && payload.errors.length > 0) {
    throw new LinearUnreachableError(payload.errors[0]?.message ?? "Linear GraphQL error");
  }
  if (payload.data === undefined) {
    throw new LinearUnreachableError("Linear GraphQL returned no data");
  }
  return payload.data;
}
