import { Issue, LinearClient } from "@linear/sdk";
import {
  Data,
  Effect,
  ParseResult,
  Redacted,
  Schedule,
  Schema,
  type RateLimiter,
} from "effect";
import type { Config } from "./config.js";

// VA-360: schemas covering only the fields runway actually reads
// off the Linear SDK. Validation runs at the gateway boundary so an
// upstream API drift (renamed field, removed field, type change)
// surfaces as a typed `LinearSchemaError` rather than a `Cannot read
// property 'nodes' of undefined` deep in the call stack.
const IssueNodeSchema = Schema.Struct({
  id: Schema.String,
  identifier: Schema.String,
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  // VA-420: drain order is `priority ASC (Urgent=1 → Low=4, No-priority=0
  // sorted last), then createdAt ASC`. The sort reads this off the raw
  // SDK node; the schema entry narrows the field at the seam so a Linear
  // API drift surfaces as `LinearSchemaError` instead of a silent NaN
  // comparison.
  priority: Schema.Number,
});
const TeamNodeSchema = Schema.Struct({
  id: Schema.String,
  key: Schema.String,
});
const IssueLabelNodeSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
});
const ProjectNodeSchema = Schema.Struct({
  id: Schema.String,
});
// VA-394: minimal shape needed to ask "is this blocker still active?"
// — we only read the relation's `type` (filtering for `blocks`) and
// the related issue's workflow state `type`. Schemas stay narrow so
// the validation cost per candidate stays small.
const IssueRelationNodeSchema = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
});
const WorkflowStateTypeNodeSchema = Schema.Struct({
  type: Schema.String,
});
// VA-383: comments fetched for surfacing prior-attempt review feedback
// to the implementer. `user` is nullable on Linear's side (system /
// integration comments can lack an author); we map a missing user to
// the empty string so downstream filters can match by name without a
// null-guard at every call site.
//
// VA-415: `user` can also be *absent from the payload entirely* (vs.
// present-and-null) on some system / deleted-user comments. The
// optional + nullable shape below accepts all three forms: missing,
// null, and full struct. Downstream code already null-coalesces via
// `comment.user?.name ?? ""`.
const CommentNodeSchema = Schema.Struct({
  id: Schema.String,
  body: Schema.String,
  createdAt: Schema.Union(Schema.String, Schema.DateFromSelf),
  user: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String,
      }),
    ),
  ),
});
const ViewerSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
});

const decodeIssueNode = Schema.decodeUnknownSync(IssueNodeSchema);
const decodeTeamNode = Schema.decodeUnknownSync(TeamNodeSchema);
const decodeIssueLabelNode = Schema.decodeUnknownSync(IssueLabelNodeSchema);
const decodeProjectNode = Schema.decodeUnknownSync(ProjectNodeSchema);
const decodeCommentNode = Schema.decodeUnknownSync(CommentNodeSchema);
const decodeViewer = Schema.decodeUnknownSync(ViewerSchema);
const decodeIssueRelationNode = Schema.decodeUnknownSync(IssueRelationNodeSchema);
const decodeWorkflowStateTypeNode = Schema.decodeUnknownSync(
  WorkflowStateTypeNodeSchema,
);

// VA-394: Linear workflow state `type` values that mean "the blocker
// has resolved." Anything else (`triage`, `backlog`, `unstarted`,
// `started`) still gates the blocked issue from runway pickup.
const TERMINAL_STATE_TYPES = new Set(["completed", "canceled"]);
const isTerminalStateType = (type: string): boolean =>
  TERMINAL_STATE_TYPES.has(type);

/**
 * VA-394: returns true when `issue` carries `hitlLabel`. Runway writes
 * this label on HITL escapes, and triage may apply it to flag
 * human-only work — either way the contract is "do not pick up." Uses
 * the SDK's chained `labels()` call rather than asking for labels
 * inline at the candidate-fetch site so the schema for `IssueNode`
 * stays narrow.
 *
 * VA-387: pulls all label names so callers that need the full list
 * (the dashboard's `runway.issue.labels` attribute) don't have to
 * re-issue the SDK call.
 */
async function fetchIssueLabelNames(issue: Issue): Promise<readonly string[]> {
  const labels = await issue.labels();
  return labels.nodes.map((raw) => decodeIssueLabelNode(raw).name);
}

/**
 * VA-425: returns true when `issue` has one or more child sub-issues.
 * Parent PRDs / umbrella tickets describe scope across multiple
 * deliverables; the right unit of agent work is the child, not the
 * parent. Skipping parents keeps the agent from latching onto a
 * single user story and falsely closing the umbrella issue.
 *
 * "Non-trivial" in the name means simply "has any child" — Linear
 * doesn't model "draft" or "abandoned" children separately, so
 * `nodes.length > 0` is the signal. Children themselves remain
 * drain-eligible on their own merits (this check only runs against
 * candidates already on the queue).
 */
async function hasChildIssues(issue: Issue): Promise<boolean> {
  const children = await issue.children();
  return children.nodes.length > 0;
}

/**
 * VA-394: returns true when `issue` has at least one `inverseRelations`
 * record of type `blocks` whose blocker is in a non-terminal workflow
 * state. Other relation types (`duplicate`, `related`) do not gate
 * pickup. A blocker with a missing or undecodable state is treated as
 * inactive (best-effort: drift in one relation should not stop the
 * queue), but the decoder still throws `ParseError` on outright
 * malformed relation nodes — caught upstream as `LinearSchemaError`.
 */
async function hasActiveBlocker(issue: Issue): Promise<boolean> {
  const relations = await issue.inverseRelations();
  for (const rawRel of relations.nodes) {
    const rel = decodeIssueRelationNode(rawRel);
    if (rel.type !== "blocks") continue;
    const blocker = await rawRel.issue;
    if (!blocker) continue;
    const blockerState = await blocker.state;
    if (!blockerState) continue;
    const stateType = decodeWorkflowStateTypeNode(blockerState).type;
    if (!isTerminalStateType(stateType)) return true;
  }
  return false;
}

/**
 * Trimmed-down view of a Linear issue — just what runway's loop needs.
 * Resolved up-front so the orchestrator doesn't have to round-trip the
 * SDK for every field.
 */
export interface RunwayIssue {
  readonly id: string;
  readonly identifier: string; // "VA-123"
  readonly title: string;
  readonly description: string;
  /**
   * VA-387: full set of label names attached to the issue at fetch
   * time. The orchestrator forwards these onto the `processIssue`
   * span as `runway.issue.labels` so the dashboard can surface what
   * the agent saw. Order matches the SDK's response order.
   */
  readonly labels: readonly string[];
}

/**
 * VA-383: trimmed comment view used to surface prior-attempt review
 * feedback to the implementer. `author` is the comment author's
 * `name` field (empty string for system/integration comments with no
 * user) — the orchestrator filters on this against a configured
 * allowlist before formatting into the prompt.
 */
export interface RunwayComment {
  readonly id: string;
  readonly author: string;
  readonly body: string;
  readonly createdAt: Date;
}

// VA-356: typed error ADT for the Linear gateway. The orchestrator
// (and later, retry policies in VA-357) discriminates on `_tag`.
// Resource-shaped not-found is its own branch because "team not found"
// is a config error the operator should fix, while a NetworkError is
// transient and retry-eligible.
export type LinearResource =
  | "team"
  | "state"
  | "project"
  | "label"
  | "issue";

export class LinearNotFound extends Data.TaggedError("LinearNotFound")<{
  readonly resource: LinearResource;
  readonly identifier: string;
  readonly message: string;
}> {}

export class LinearUnauthorized extends Data.TaggedError(
  "LinearUnauthorized",
)<{
  readonly message: string;
}> {}

export class LinearRateLimited extends Data.TaggedError("LinearRateLimited")<{
  readonly message: string;
}> {}

export class LinearNetworkError extends Data.TaggedError(
  "LinearNetworkError",
)<{
  readonly cause: unknown;
  readonly message: string;
}> {}

// VA-357: a stalled HTTP request becomes a typed timeout (rather than
// a stuck process). Retryable just like NetworkError — the next attempt
// may succeed.
export class LinearTimeout extends Data.TaggedError("LinearTimeout")<{
  readonly call: string;
  readonly afterMs: number;
  readonly message: string;
}> {}

// VA-360: SDK response failed schema validation — Linear's GraphQL
// schema drifted, an expected field went missing, or a type changed.
// NOT retryable: re-running the same call will produce the same
// drift. The operator needs to update runway's schemas (or pin the
// SDK version) before this gets better.
export class LinearSchemaError extends Data.TaggedError("LinearSchemaError")<{
  readonly call: string;
  readonly message: string;
}> {}

export type LinearError =
  | LinearNotFound
  | LinearUnauthorized
  | LinearRateLimited
  | LinearNetworkError
  | LinearTimeout
  | LinearSchemaError;

// VA-357: which typed errors a retry policy will re-attempt. Hard
// failures (NotFound, Unauthorized) bypass the retry loop and surface
// immediately — they are operator-fix problems, not transient blips.
const RETRYABLE_LINEAR_TAGS = new Set<LinearError["_tag"]>([
  "LinearNetworkError",
  "LinearRateLimited",
  "LinearTimeout",
]);

const isRetryableLinearError = (err: LinearError): boolean =>
  RETRYABLE_LINEAR_TAGS.has(err._tag);

/**
 * VA-357: timeout + jittered-exponential retry policy for one Linear
 * call. 5 retries from a 1s base ⇒ delays jittered around 1/2/4/8/16s
 * ⇒ ~31s worst-case wall time before bubbling out. `while` gates the
 * retry on the typed error tag so an `Unauthorized` or `NotFound` is
 * not retried (no point: it's an operator/config problem).
 *
 * Exported so unit tests can apply it to a hand-built Effect and
 * verify retry behavior under `TestClock`.
 */
export const linearRetrySchedule = Schedule.exponential("1 second").pipe(
  Schedule.compose(Schedule.recurs(5)),
  Schedule.jittered,
);

export const applyLinearPolicy = <A>(
  effect: Effect.Effect<A, LinearError>,
  opts: { call: string; timeoutMs?: number },
): Effect.Effect<A, LinearError> => {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  return effect.pipe(
    Effect.timeoutFail({
      duration: `${timeoutMs} millis`,
      onTimeout: () =>
        new LinearTimeout({
          call: opts.call,
          afterMs: timeoutMs,
          message: `Linear ${opts.call} timed out after ${timeoutMs}ms`,
        }),
    }),
    Effect.retry({
      schedule: linearRetrySchedule,
      while: isRetryableLinearError,
    }),
  );
};

/**
 * Best-effort classification of an unknown thrown value into the
 * gateway's typed error ADT. `LinearNotFound`s we threw ourselves
 * (from the find* helpers) pass through unchanged; SDK / network
 * exceptions are bucketed by message-shape. Step 2 (VA-357) is where
 * the retry policy actually leans on these tags — for now, the value
 * is mostly that the orchestrator's `catch (err: unknown)` becomes
 * `catch (err: LinearError)`.
 */
function classifyLinearError(err: unknown, context: string): LinearError {
  if (
    err instanceof LinearNotFound ||
    err instanceof LinearUnauthorized ||
    err instanceof LinearRateLimited ||
    err instanceof LinearNetworkError ||
    err instanceof LinearTimeout ||
    err instanceof LinearSchemaError
  ) {
    return err;
  }
  // VA-360: a schema validation throw (Linear API drift) should
  // surface as `LinearSchemaError`, not get bucketed as a transient
  // NetworkError — retrying won't fix a drifted field.
  if (ParseResult.isParseError(err)) {
    return new LinearSchemaError({
      call: context,
      message: `${context}: SDK response failed schema validation — ${err.message}`,
    });
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/\b(401|403)\b|unauthorized|invalid api key|forbidden/i.test(msg)) {
    return new LinearUnauthorized({ message: msg });
  }
  if (/\b429\b|rate.?limit/i.test(msg)) {
    return new LinearRateLimited({ message: msg });
  }
  return new LinearNetworkError({
    cause: err,
    message: `${context}: ${msg}`,
  });
}

export interface LinearGateway {
  fetchReady(): Effect.Effect<readonly RunwayIssue[], LinearError>;
  applyLabel(
    issueId: string,
    labelName: string,
  ): Effect.Effect<void, LinearError>;
  /**
   * VA-423: remove `labelName` from `issueId`. Used by the
   * orchestrator to claim an issue at pickup time (remove
   * `ready-for-agent`) — the atomic claim signal that prevents the
   * next drain from re-picking the issue while the current run is
   * in flight. Idempotent: a no-op if the label isn't present.
   */
  removeLabel(
    issueId: string,
    labelName: string,
  ): Effect.Effect<void, LinearError>;
  comment(issueId: string, body: string): Effect.Effect<void, LinearError>;
  /**
   * VA-383: fetch every comment on an issue, ordered ascending by
   * `createdAt`. Used by the orchestrator to surface prior-attempt
   * review feedback to the implementer. Filtering by author is the
   * orchestrator's concern — this returns the raw set.
   */
  fetchComments(
    issueId: string,
  ): Effect.Effect<readonly RunwayComment[], LinearError>;
  /**
   * VA-383: the Linear user the API key authenticates as. Resolved
   * once per drain and used as the default author allowlist for
   * `fetchComments` — the reviewer agent and orchestrator both post
   * comments under this identity, so it covers the "review feedback
   * + repo owner" default named in VA-383's ACs.
   */
  viewer(): Effect.Effect<{ readonly id: string; readonly name: string }, LinearError>;
}

/**
 * Concrete @linear/sdk-backed implementation. Tests inject their own
 * gateway; never reach for the SDK directly outside this file.
 *
 * The internal `find*` helpers stay plain `async` and throw typed
 * `LinearNotFound` directly. Only the public `LinearGateway` methods
 * wrap into `Effect.tryPromise` — that's the boundary the orchestrator
 * sees.
 *
 * VA-358: optional `limiter` wraps every method's Effect so the queue
 * drain respects Linear's API rate limit (~1500 req/hr). When `null`
 * (the default — tests don't need it), calls go through unrestricted.
 * Production: `commands/run.ts` builds a limiter inside `Effect.scoped`
 * and passes it here.
 */
export function createLinearGateway(
  config: Config,
  limiter: RateLimiter.RateLimiter | null = null,
): LinearGateway {
  const client = new LinearClient({ apiKey: Redacted.value(config.linearApiKey) });
  const gate = <A>(
    eff: Effect.Effect<A, LinearError>,
  ): Effect.Effect<A, LinearError> => (limiter ? limiter(eff) : eff);

  async function findTeamId(): Promise<string> {
    const teams = await client.teams({
      filter: { key: { eq: config.linearTeam } },
    });
    const rawTeam = teams.nodes[0];
    if (!rawTeam) {
      throw new LinearNotFound({
        resource: "team",
        identifier: config.linearTeam,
        message: `Linear team "${config.linearTeam}" not found`,
      });
    }
    return decodeTeamNode(rawTeam).id;
  }

  /**
   * Resolve a project identifier (UUID, slug, or name) to its Linear
   * project ID. Tries each shape in order so user-facing flags like
   * `--project=bedrock` work without forcing users to copy the UUID.
   */
  async function findProjectId(identifier: string): Promise<string> {
    const projects = await client.projects({
      filter: {
        or: [
          { id: { eq: identifier } },
          { slugId: { eq: identifier } },
          { name: { eq: identifier } },
        ],
      },
    });
    const rawProject = projects.nodes[0];
    if (!rawProject) {
      throw new LinearNotFound({
        resource: "project",
        identifier,
        message: `Linear project "${identifier}" not found`,
      });
    }
    return decodeProjectNode(rawProject).id;
  }

  return {
    fetchReady() {
      return gate(applyLinearPolicy(
        Effect.tryPromise({
          try: async () => {
            const teamId = await findTeamId();
            const projectId = config.linearProject
              ? await findProjectId(config.linearProject)
              : null;
            // VA-423: drain queue is gated by `config.readyLabel`
            // (default `ready-for-agent`, the flightplan v1.1.0
            // contract). Status is intentionally NOT filtered — Linear
            // auto-mutates status on PR cross-references, which used
            // to silently drop issues from a status-gated queue every
            // time someone mentioned the issue from a PR. Labels are
            // immune to that integration.
            const batch = await client.issues({
              filter: {
                team: { id: { eq: teamId } },
                labels: { name: { eq: config.readyLabel } },
                ...(projectId ? { project: { id: { eq: projectId } } } : {}),
              },
              // VA-420: order doesn't matter at the SDK call — Linear's
              // `IssueOrderBy` enum doesn't expose `priority`, and the
              // SDK type for this argument hides the ASC/DESC direction
              // anyway. We re-sort the candidate set in JS below.
              orderBy: "createdAt" as never,
            });
            // VA-420: drain by Linear priority first, then by createdAt
            // within a priority bucket. Linear's priority encoding is
            // non-monotonic — `1 = Urgent, 2 = High, 3 = Medium,
            // 4 = Low, 0 = No priority` — so `0` is remapped to
            // `Infinity` to sit behind every prioritised bucket
            // (operator intuition: Urgent first, unprioritised last).
            // Within a bucket, oldest-first restores the FIFO intent.
            const candidates = [...batch.nodes].sort((a, b) => {
              const pa = a.priority === 0 ? Infinity : a.priority;
              const pb = b.priority === 0 ? Infinity : b.priority;
              if (pa !== pb) return pa - pb;
              return (
                new Date(a.createdAt).getTime() -
                new Date(b.createdAt).getTime()
              );
            });
            // VA-360: validate every issue node through the schema —
            // a single drifted issue surfaces as `LinearSchemaError`
            // instead of a downstream `cannot read property X`.
            //
            // VA-394 / VA-423 per-candidate eligibility:
            // - skip issues carrying `config.hitlLabel` (triage's
            //   `ready-for-human` marker; also covers the AC case
            //   "issue carries BOTH `ready-for-agent` and
            //   `ready-for-human` → treat as ready-for-human, skip");
            // - skip issues whose `ready-for-agent` label was just
            //   stripped (defensive: the GraphQL filter narrows the
            //   set, but eventual consistency or a label change
            //   between query and per-candidate fetch can return an
            //   issue that no longer qualifies);
            // - skip issues with at least one active `blocks`
            //   relation pointing at them;
            // - skip parent PRDs (issues with sub-issues — agents
            //   should pick up the children, not the umbrella).
            // The candidate set is typically a handful of issues;
            // the N+1 SDK calls go through the rate limiter and
            // retry policy alongside everything else.
            const eligible: RunwayIssue[] = [];
            for (const raw of candidates) {
              const i = decodeIssueNode(raw);
              const labels = await fetchIssueLabelNames(raw);
              if (!labels.includes(config.readyLabel)) continue;
              if (labels.includes(config.hitlLabel)) continue;
              if (await hasActiveBlocker(raw)) continue;
              if (await hasChildIssues(raw)) {
                console.debug(
                  `[runway] fetchReady: skipping ${i.identifier} — has child sub-issues (PRD / umbrella ticket)`,
                );
                continue;
              }
              eligible.push({
                id: i.id,
                identifier: i.identifier,
                title: i.title,
                description: i.description ?? "",
                labels,
              });
            }
            return eligible as readonly RunwayIssue[];
          },
          catch: (err) => classifyLinearError(err, "fetchReady"),
        }),
        { call: "fetchReady" },
      ));
    },

    applyLabel(issueId, labelName) {
      return gate(applyLinearPolicy(
        Effect.tryPromise({
          try: async () => {
            const issue = await client.issue(issueId);
            const team = await issue.team;
            if (!team) {
              throw new LinearNotFound({
                resource: "issue",
                identifier: issueId,
                message: `Issue ${issueId} has no team`,
              });
            }
            // VA-416: Linear labels can be team-scoped OR
            // workspace-scoped (no team association). Earlier code
            // filtered by team only, which silently excluded
            // workspace-scoped labels like the default
            // `ready-for-human`. Query by name alone, then prefer a
            // team-scoped match when one exists so the team-vs-
            // workspace name-collision edge resolves the obvious way.
            const labels = await client.issueLabels({
              filter: { name: { eq: labelName } },
            });
            const decoded = labels.nodes.map((l) => ({
              raw: l,
              decoded: decodeIssueLabelNode(l),
            }));
            const teamScoped = await (async () => {
              for (const { raw, decoded: d } of decoded) {
                const labelTeam = await raw.team;
                if (labelTeam?.id === team.id) return d;
              }
              return undefined;
            })();
            const workspaceScoped = await (async () => {
              for (const { raw, decoded: d } of decoded) {
                const labelTeam = await raw.team;
                if (!labelTeam) return d;
              }
              return undefined;
            })();
            const label = teamScoped ?? workspaceScoped;
            if (!label) {
              throw new LinearNotFound({
                resource: "label",
                identifier: labelName,
                message: `Linear label "${labelName}" not found at workspace scope or on team ${team.id}`,
              });
            }
            const existing = await issue.labels();
            const existingIds = existing.nodes.map(
              (l) => decodeIssueLabelNode(l).id,
            );
            const labelIds = [...existingIds, label.id];
            await client.updateIssue(issueId, { labelIds });
          },
          catch: (err) => classifyLinearError(err, `applyLabel(${labelName})`),
        }),
        { call: `applyLabel(${labelName})` },
      ));
    },

    // VA-423: pickup-time claim signal. The orchestrator calls this
    // with `config.readyLabel` (`ready-for-agent`) once an issue is
    // chosen for processing, which removes it from the drain queue
    // so a concurrent / immediately-following drain doesn't double-
    // pick it. The Linear API has no label-level CAS — `updateIssue`
    // assigns the full `labelIds` set — so this isn't truly atomic
    // against two parallel drains; it IS atomic against the
    // canonical "single runway, sequential drains" pattern. If the
    // label was already absent (idempotent re-run, operator-removed,
    // etc.) the resulting set is the same as the input and Linear
    // accepts the no-op write.
    removeLabel(issueId, labelName) {
      return gate(applyLinearPolicy(
        Effect.tryPromise({
          try: async () => {
            const issue = await client.issue(issueId);
            const existing = await issue.labels();
            const existingDecoded = existing.nodes.map((l) =>
              decodeIssueLabelNode(l),
            );
            const remaining = existingDecoded.filter(
              (l) => l.name !== labelName,
            );
            if (remaining.length === existingDecoded.length) {
              // Label not present — no-op write skipped.
              return;
            }
            await client.updateIssue(issueId, {
              labelIds: remaining.map((l) => l.id),
            });
          },
          catch: (err) => classifyLinearError(err, `removeLabel(${labelName})`),
        }),
        { call: `removeLabel(${labelName})` },
      ));
    },

    comment(issueId, body) {
      return gate(applyLinearPolicy(
        Effect.tryPromise({
          try: async () => {
            await client.createComment({ issueId, body });
          },
          catch: (err) => classifyLinearError(err, "comment"),
        }),
        { call: "comment" },
      ));
    },

    fetchComments(issueId) {
      return gate(applyLinearPolicy(
        Effect.tryPromise({
          try: async () => {
            // Linear SDK paginates by default — use the issue-scoped
            // accessor and let the SDK's first page suffice for the
            // common case (Runway's HITL + reviewer flow rarely
            // produces more than a handful per attempt). If issues
            // start blowing past the page limit, fold in pagination.
            const issue = await client.issue(issueId);
            const comments = await issue.comments();
            const decoded = comments.nodes.map((raw) => {
              const c = decodeCommentNode(raw);
              const createdAt =
                c.createdAt instanceof Date ? c.createdAt : new Date(c.createdAt);
              return {
                id: c.id,
                author: c.user?.name ?? "",
                body: c.body,
                createdAt,
              } satisfies RunwayComment;
            });
            // VA-383: ascending by createdAt so the impl agent reads
            // feedback in the order it was given.
            return [...decoded].sort(
              (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
            ) as readonly RunwayComment[];
          },
          catch: (err) => classifyLinearError(err, "fetchComments"),
        }),
        { call: "fetchComments" },
      ));
    },

    viewer() {
      return gate(applyLinearPolicy(
        Effect.tryPromise({
          try: async () => {
            const v = await client.viewer;
            return decodeViewer({ id: v.id, name: v.name });
          },
          catch: (err) => classifyLinearError(err, "viewer"),
        }),
        { call: "viewer" },
      ));
    },
  };
}

/**
 * VA-354 / VA-423: read-only preflight that surfaces every
 * Linear-side misconfiguration `runway run` would hit. Returns a
 * structured result; the caller (currently `runway doctor`) decides
 * how to render. The returned `available` lists are sampled (max 50)
 * so a red ✗ on a missing label can show the operator what IS there.
 *
 * After VA-423, runway's queue contract is label-gated — the doctor
 * verifies that `readyLabel` and `hitlLabel` both exist; workflow
 * states are no longer part of the runway contract (Linear's GitHub
 * integration drives status from PR events, and runway no longer
 * issues any state mutations).
 */
export interface LinearValidationResult {
  readonly team:
    | { kind: "ok"; id: string }
    | { kind: "missing"; key: string };
  readonly readyLabel: LabelValidation;
  readonly hitlLabel: LabelValidation;
}

type LabelValidation =
  | { kind: "ok"; name: string }
  | { kind: "missing"; name: string; available: readonly string[] }
  | { kind: "skipped"; reason: string };

export async function validateLinearConfig(
  config: Config,
): Promise<LinearValidationResult> {
  const client = new LinearClient({ apiKey: Redacted.value(config.linearApiKey) });

  const teams = await client.teams({
    filter: { key: { eq: config.linearTeam } },
  });
  const team = teams.nodes[0];
  if (!team) {
    return {
      team: { kind: "missing", key: config.linearTeam },
      readyLabel: { kind: "skipped", reason: "team missing" },
      hitlLabel: { kind: "skipped", reason: "team missing" },
    };
  }

  // Accept labels scoped to this team OR workspace-level labels (team: null).
  const labels = await client.issueLabels({
    filter: { or: [{ team: { id: { eq: team.id } } }, { team: { null: true } }] },
  });
  const labelNames = labels.nodes.map((l) => l.name);
  const checkLabel = (want: string): LabelValidation =>
    labelNames.includes(want)
      ? { kind: "ok", name: want }
      : { kind: "missing", name: want, available: labelNames.slice(0, 50) };

  return {
    team: { kind: "ok", id: team.id },
    readyLabel: checkLabel(config.readyLabel),
    hitlLabel: checkLabel(config.hitlLabel),
  };
}
