import type { Ticket } from "./ticket.ts";
import {
  optionalRoot,
  type FrontierRoot,
  type TreeAnswer,
} from "./tracker-adapter.ts";

/** One page of a Tracker's paged connection: the relay shape GitHub and Linear both answer. */
export type TrackerPageInfo = {
  hasNextPage: boolean;
  endCursor: string | null;
};

/** One page's nodes, some of which the Tracker may answer as null. */
export type TrackerPage<Node> = {
  pageInfo: TrackerPageInfo;
  nodes: (Node | null)[];
};

/**
 * Pick order is the Tracker Adapter's stable order (ADR 0017): the Ticket's
 * numeric identifier ascending, so naming Tickets never sequences them.
 */
export function pickOrder(a: Ticket, b: Ticket): number {
  return a.id.localeCompare(b.id, undefined, { numeric: true });
}

/**
 * One paged read, however many pages the Tracker answers. The loop lives here
 * once, so no Tracker Adapter carries its own.
 *
 * @param readPage Reads one page at a cursor; the first read gets no cursor.
 */
export async function paginate<Node>(
  readPage: (cursor: string | null) => Promise<TrackerPage<Node>>,
): Promise<Node[]> {
  const nodes: Node[] = [];
  let cursor: string | null = null;
  while (true) {
    const page = await readPage(cursor);
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

// The blocking-expression probe is a fact of the Tracker's schema, not of the
// call: it is read once per transport and scope per process, so frontier,
// waiting, tree, and inspect share the first answer instead of each paying for
// their own. A failed read is not an answer; it is not remembered, so the next
// call reads again.
const blockingProbes = new WeakMap<object, Map<string, Promise<boolean>>>();

/**
 * The blocking-expression probe, read once per transport and scope per
 * process; a failed read is not remembered, so the next call reads again.
 *
 * @param transport The Adapter's HTTP seam, standing in for the process.
 * @param scope What varies within one Tracker, e.g. the repository.
 * @param probe The Tracker-specific schema read.
 */
export function blockingProbeOnce(
  transport: object,
  scope: string,
  probe: () => Promise<boolean>,
): Promise<boolean> {
  let byScope = blockingProbes.get(transport);
  if (byScope === undefined) {
    byScope = new Map();
    blockingProbes.set(transport, byScope);
  }
  const cached = byScope.get(scope);
  if (cached !== undefined) {
    return cached;
  }
  const pending = probe();
  byScope.set(scope, pending);
  void pending.catch(() => {
    if (byScope.get(scope) === pending) {
      byScope.delete(scope);
    }
  });
  return pending;
}

/**
 * The GraphQL transport, with one error shape: an auth failure, an unreachable
 * Tracker, or the vendor's own message — nothing else leaks. The Tracker-
 * specific errors are injected, so every Adapter surfaces the same three cases
 * under its own names.
 */
export type GraphqlErrors = {
  auth: () => Error;
  unreachable: (detail: string) => Error;
};

/**
 * One GraphQL read: POST, then one of the three error cases or the data.
 * A vendor message in the `errors` array surfaces as the vendor's own words
 * in a plain `Error`, for the Adapter to shape.
 */
export async function graphqlRead<T>(call: {
  http: typeof fetch;
  endpoint: string;
  headers: Record<string, string>;
  operationName: string;
  query: string;
  variables?: Record<string, unknown>;
  errors: GraphqlErrors;
}): Promise<T> {
  const response = await call.http(call.endpoint, {
    method: "POST",
    headers: call.headers,
    body: JSON.stringify({
      query: call.query,
      variables: call.variables ?? {},
      operationName: call.operationName,
    }),
  });
  const payload = await response.json() as {
    data?: T;
    errors?: { message: string }[];
  };
  if (!response.ok) {
    if (response.status === 401) {
      throw call.errors.auth();
    }
    throw call.errors.unreachable(`HTTP ${response.status}`);
  }
  if (payload.errors !== undefined && payload.errors.length > 0) {
    const message = payload.errors[0]?.message;
    if (!message) {
      throw call.errors.unreachable("answered errors with no message");
    }
    throw new Error(message);
  }
  if (payload.data === undefined) {
    throw call.errors.unreachable("returned no data");
  }
  return payload.data;
}

/**
 * What the floor asks of the Tracker Adapter standing on it, in the Adapter's
 * own vocabulary: the blocking refusal, one page of the open candidates read,
 * each candidate's mapping onto a Ticket, and the lie refusal for a named
 * root Ticket that is closed or missing (ADR 0038). The Adapter's page type
 * is its own: raw Tracker nodes route through the floor, but the floor never
 * interprets them — it only asks for Tickets and Ticket ids.
 */
export type RootedReadPorts<Node> = {
  refuseWhenBlockingUnexpressable(): Promise<void>;
  /** One page of the open candidates read, as the Tracker answers it. */
  readCandidatesPage(cursor: string | null): Promise<TrackerPage<Node>>;
  /**
   * The candidate's Ticket. `selectorApplies` says whether the Frontier
   * selector's own judgment may: a list root bypasses it, so a bypassed
   * selector does not judge its own blockers (ADR 0038).
   */
  toTicket(node: Node, selectorApplies: boolean): Ticket;
  /**
   * The named root Ticket is closed or missing: refused as a lie. Asked only
   * once the whole candidates read has answered, so the Adapter may name a
   * lie from what this read saw.
   */
  refuseLie(id: string): Promise<void>;
};

/**
 * The Consumer selector the Adapter's options name (ADR 0016): which
 * candidates are the selector's own, in the Adapter's vocabulary, plus the
 * optional config-level root a root named on the call replaces.
 */
export type RootedReadSelector<Node> = {
  matches(node: Node): boolean;
  parent?: string;
  ids?: string[];
};

// A list root naming one Ticket twice is the duplicate lie ADR 0038 refuses;
// the command line catches its own duplicates, and this catches the rest.
function refuseDuplicateNames(ids: readonly string[]): void {
  const named = new Set<string>();
  for (const id of ids) {
    if (named.has(id)) {
      throw new Error(
        `Ticket ${id} is named more than once in the root; name each Ticket once.`,
      );
    }
    named.add(id);
  }
}

/**
 * The one rooted candidates read (ADR 0038). The root named on the call wins
 * over the selector's own; a list bypasses the selector but never
 * `ready: "unblocked"`, and a parent narrows the selector and is never worked
 * itself. One scan answers every shape, lies refused, and the candidates split
 * into the two halves `frontier` and `waiting` are — which `tree` returns
 * together (ADR 0039) — each half in pick order.
 *
 * @param ports The Adapter's refusals, its candidates read, and its mapping
 *   onto Tickets.
 * @param selector The Adapter's own Frontier selector.
 */
export function rootedRead<Node>(
  ports: RootedReadPorts<Node>,
  selector: RootedReadSelector<Node>,
): (root?: FrontierRoot) => Promise<TreeAnswer> {
  return async (root) => {
    await ports.refuseWhenBlockingUnexpressable();
    const effective = root ?? optionalRoot(selector.parent, selector.ids);
    if (effective?.kind === "list") {
      refuseDuplicateNames(effective.ids);
    }
    // A bypassed selector must not judge its own blockers, so a list's
    // candidates are mapped with the selector off.
    const selectorApplies = effective?.kind !== "list";
    const nodes = await paginate<Node>((cursor) =>
      ports.readCandidatesPage(cursor)
    );
    const mapped = new Map<string, { node: Node; ticket: Ticket }>();
    for (const node of nodes) {
      const ticket = ports.toTicket(node, selectorApplies);
      mapped.set(ticket.id, { node, ticket });
    }
    let candidates: Ticket[];
    let parent: Ticket | undefined;
    if (effective?.kind === "list") {
      const named = new Set(effective.ids);
      candidates = [...mapped.values()]
        .filter(({ ticket }) => named.has(ticket.id))
        .map(({ ticket }) => ticket);
      for (const id of effective.ids) {
        if (!candidates.some((ticket) => ticket.id === id)) {
          await ports.refuseLie(id);
        }
      }
    } else if (effective?.kind === "parent") {
      // The parent narrows the selector's candidates, so its children are
      // still selector Tickets: the selector applies, unblocked does not —
      // and a root named on the call replaces the selector's own root
      // entirely.
      candidates = [...mapped.values()]
        .filter(({ node, ticket }) =>
          ticket.parent === effective.id && selector.matches(node)
        )
        .map(({ ticket }) => ticket);
      // A closed parent can still hold open children, so the parent is
      // probed even when children answered.
      await ports.refuseLie(effective.id);
      parent = mapped.get(effective.id)?.ticket;
    } else {
      candidates = [...mapped.values()]
        .filter(({ node }) => selector.matches(node))
        .map(({ ticket }) => ticket);
    }
    return {
      parent,
      frontier: candidates.filter((ticket) => ticket.blockedBy.length === 0)
        .sort(pickOrder),
      waiting: candidates.filter((ticket) => ticket.blockedBy.length > 0)
        .sort(pickOrder),
    };
  };
}
