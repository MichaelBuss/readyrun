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

const knownLinearKeys = new Set([
  "ready",
  "state",
  "label",
  "project",
  "parent",
  "ids",
]);

/**
 * The Linear Tracker Adapter's options: the Frontier selector — exactly one
 * of `state`, `label`, or `project`, always plus `ready: "unblocked"` — and
 * the optional Root, a `parent` or an explicit `ids` list, never both.
 */
export type LinearTrackerOptions = {
  /** The readiness half of the Frontier selector; `"unblocked"` today. */
  ready: "unblocked";
  /** The Linear state the Frontier selector requires. */
  state?: string;
  /** The Linear label the Frontier selector requires. */
  label?: string;
  /** The Linear project the Frontier selector requires. */
  project?: string;
  /** The parent Ticket whose children become the Frontier. */
  parent?: string;
  /** The explicit Ticket list; bypasses the selector, never `unblocked`. */
  ids?: string[];
};

export type LinearRuntime = {
  fetch?: typeof fetch;
  token?: string;
  env?: Record<string, string | undefined>;
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

const commentCreateMutation = `mutation CommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) {
    success
    comment { id }
  }
}`;

type SchemaProbeData = {
  __type: { fields: { name: string }[] | null } | null;
};

type IssueLabelsData = {
  issueLabels: TrackerPage<LabelNode>;
};

type WorkflowStatesData = {
  workflowStates: TrackerPage<StateNode>;
};

type ProjectsData = {
  projects: TrackerPage<ProjectNode>;
};

type FrontierData = {
  issues: TrackerPage<IssueNode>;
};

type IssueStatesData = {
  issue: {
    team: { states: { nodes: (StateNode | null)[] } };
  } | null;
};

/**
 * The Linear Tracker Adapter: talks to Linear's GraphQL API, with auth from
 * `LINEAR_API_KEY` (or `runtime.token`). Linear calls the work "issues";
 * this Adapter is where that word stays, mapping each onto a Ticket, and
 * its default `leaveFrontier` moves a finished Ticket to In Review, not
 * Done. Its `frontier`, `waiting`, and `tree` are thin partitions over the
 * Tracker Adapter floor's one rooted candidates read: the floor owns the
 * paging loop, the root policy, pick order, the GraphQL transport, and the
 * blocking probe; this Adapter owns Linear's own facts — the selector's
 * state, label, or project, the open candidates read, and the lie refusal.
 *
 * @param options The Frontier selector and the optional Root.
 * @param runtime The seams tests inject: fetch, token, env.
 */
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
  // Linear hands each Issue a suggested Branch name; the Frontier is what
  // seeds the Adapter's suggestion with its own Tickets' names (#142), so
  // the tree answers read-only. Each frontier read starts the suggestion
  // over.
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
      return await graphqlRead<T>({
        http,
        endpoint: "https://api.linear.app/graphql",
        headers: {
          Authorization: await token(),
          "Content-Type": "application/json",
        },
        operationName,
        query,
        variables,
        errors: {
          auth: () => new LinearAuthError(),
          unreachable: (detail) =>
            new LinearUnreachableError(`Linear GraphQL ${detail}`),
        },
      });
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

  // The blocking-expression probe is a schema fact, not a per-call one: the
  // floor reads it once per transport and scope per process, so frontier,
  // waiting, tree, and inspect share the first answer. The token is the
  // scope: it names the one workspace this Adapter talks to.
  function canExpressBlocking(): Promise<boolean> {
    return token().then((scope) =>
      blockingProbeOnce(http, scope, async () => {
        const data = await graphql<SchemaProbeData>(
          "SchemaProbe",
          schemaProbeQuery,
        );
        return data.__type?.fields?.some((field) =>
          field.name === "inverseRelations"
        ) ?? false;
      }),
    );
  }

  async function refuseWhenBlockingUnexpressable(): Promise<void> {
    if (!(await canExpressBlocking())) {
      throw new Error("Linear cannot express blocking");
    }
  }

  // One page of the open candidates read: every Issue the API answers with,
  // minus the ones that have left the Frontier — a Ticket whose work already
  // landed, or was canceled, is not an open candidate, so a root naming one
  // is refused as a lie (ADR 0038). The floor owns the paging loop, the root
  // policy, and the mapping onto Tickets. Each read starts at no cursor, so
  // the first page resets what the read has seen, and a lie is named from
  // this read's own answers.
  const fetched = new Map<string, IssueNode>();

  async function readCandidatesPage(
    cursor: string | null,
  ): Promise<TrackerPage<IssueNode>> {
    if (cursor === null) {
      fetched.clear();
    }
    const data: FrontierData = await graphql<FrontierData>(
      "Frontier",
      frontierQuery,
      { cursor },
    );
    const page = data.issues;
    for (const node of page.nodes) {
      if (node !== null) {
        fetched.set(node.identifier, node);
      }
    }
    return {
      pageInfo: page.pageInfo,
      nodes: page.nodes.flatMap((node) =>
        node !== null && !hasLeftFrontier(node.state) ? [node] : []
      ),
    };
  }

  // The Frontier query answers every Ticket regardless of state, so a named
  // Ticket's absence or state is a lie the Adapter can see directly, in
  // Linear's own words.
  async function refuseTicketLie(
    id: string,
    node: IssueNode | undefined,
  ): Promise<void> {
    if (node === undefined) {
      throw new Error(`Ticket ${id} does not exist on Linear`);
    }
    if (node.state.type === "completed" || node.state.type === "canceled") {
      throw new Error(`Ticket ${id} is closed on Linear`);
    }
    if (hasLeftFrontier(node.state)) {
      throw new Error(
        `Ticket ${id} has left the Frontier (${node.state.name})`,
      );
    }
  }

  async function inspect() {
    const [labels, states, projects, blocking] = await Promise.all([
      paginate<LabelNode>(async (cursor) => {
        const data: IssueLabelsData = await graphql<IssueLabelsData>(
          "IssueLabels",
          issueLabelsQuery,
          { cursor },
        );
        return data.issueLabels;
      }),
      paginate<StateNode>(async (cursor) => {
        const data: WorkflowStatesData = await graphql<WorkflowStatesData>(
          "WorkflowStates",
          workflowStatesQuery,
          { cursor },
        );
        return data.workflowStates;
      }),
      paginate<ProjectNode>(async (cursor) => {
        const data: ProjectsData = await graphql<ProjectsData>(
          "Projects",
          projectsQuery,
          { cursor },
        );
        return data.projects;
      }),
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

  // The rooted read answers all three rooted methods (ADR 0038): frontier
  // and waiting are its halves, tree is the whole answer (ADR 0039). The
  // selector's own match is state, label, or project — Linear's vocabulary
  // (ADR 0016); the root policy stays in the floor.
  const read = rootedRead<IssueNode>(
    {
      refuseWhenBlockingUnexpressable,
      readCandidatesPage,
      refuseLie: (id) => refuseTicketLie(id, fetched.get(id)),
      toTicket,
    },
    {
      matches: (node) => matchesSelector(node, options),
      parent: options.parent,
      ids: options.ids,
    },
  );

  return Object.assign(
    createTrackerAdapter({
      async frontier(root) {
        suggestedBranches.clear();
        const answer = await read(root);
        for (const ticket of answer.frontier) {
          const branch = fetched.get(ticket.id)?.branchName;
          if (branch !== undefined && branch !== null && branch.length > 0) {
            suggestedBranches.set(ticket.id, branch);
          }
        }
        return [...answer.frontier];
      },
      waiting: (root) => read(root).then((answer) => [...answer.waiting]),
      tree: read,
      branchName(ticket) {
        return suggestedBranches.get(ticket.id) ?? `readyrun/${ticket.id}`;
      },
      async leaveFrontier(ticket, landing) {
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
        await graphql("CommentCreate", commentCreateMutation, {
          input: { issueId: ticket.id, body: landingComment(landing) },
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

// The selector's own facts — state, label, or project (ADR 0016). Open
// candidates only reach it: whether a Ticket has left the Frontier is the
// candidates read's fact, not the selector's.
function matchesSelector(
  node: IssueNode,
  options: LinearTrackerOptions,
): boolean {
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
  return true;
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
