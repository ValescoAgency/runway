import { LinearClient } from "@linear/sdk";
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
});
const WorkflowStateNodeSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
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
// VA-383: comments fetched for surfacing prior-attempt review feedback
// to the implementer. `user` is nullable on Linear's side (system /
// integration comments can lack an author); we map a missing user to
// the empty string so downstream filters can match by name without a
// null-guard at every call site.
const CommentNodeSchema = Schema.Struct({
  id: Schema.String,
  body: Schema.String,
  createdAt: Schema.Union(Schema.String, Schema.DateFromSelf),
  user: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
    }),
  ),
});
const ViewerSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
});

const decodeIssueNode = Schema.decodeUnknownSync(IssueNodeSchema);
const decodeWorkflowStateNode = Schema.decodeUnknownSync(WorkflowStateNodeSchema);
const decodeTeamNode = Schema.decodeUnknownSync(TeamNodeSchema);
const decodeIssueLabelNode = Schema.decodeUnknownSync(IssueLabelNodeSchema);
const decodeProjectNode = Schema.decodeUnknownSync(ProjectNodeSchema);
const decodeCommentNode = Schema.decodeUnknownSync(CommentNodeSchema);
const decodeViewer = Schema.decodeUnknownSync(ViewerSchema);

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
  transition(
    issueId: string,
    statusName: string,
  ): Effect.Effect<void, LinearError>;
  applyLabel(
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

  async function findStateId(teamId: string, name: string): Promise<string> {
    const states = await client.workflowStates({
      filter: { team: { id: { eq: teamId } }, name: { eq: name } },
    });
    const rawState = states.nodes[0];
    if (!rawState) {
      throw new LinearNotFound({
        resource: "state",
        identifier: name,
        message: `Linear workflow state "${name}" not found on team ${teamId}`,
      });
    }
    // VA-360: validate the SDK shape. `decodeWorkflowStateNode` throws
    // `ParseError` on drift, which `classifyLinearError` maps to
    // `LinearSchemaError` (non-retryable).
    return decodeWorkflowStateNode(rawState).id;
  }

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
            const readyStateId = await findStateId(teamId, config.readyStatus);
            const projectId = config.linearProject
              ? await findProjectId(config.linearProject)
              : null;
            const issues = await client.issues({
              filter: {
                team: { id: { eq: teamId } },
                state: { id: { eq: readyStateId } },
                ...(projectId ? { project: { id: { eq: projectId } } } : {}),
              },
              // Stable order: oldest first so the queue drains FIFO.
              orderBy: "createdAt" as never,
            });
            // VA-360: validate every issue node through the schema —
            // a single drifted issue surfaces as `LinearSchemaError`
            // instead of a downstream `cannot read property X`.
            return issues.nodes.map((raw) => {
              const i = decodeIssueNode(raw);
              return {
                id: i.id,
                identifier: i.identifier,
                title: i.title,
                description: i.description ?? "",
              };
            }) as readonly RunwayIssue[];
          },
          catch: (err) => classifyLinearError(err, "fetchReady"),
        }),
        { call: "fetchReady" },
      ));
    },

    transition(issueId, statusName) {
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
            const stateId = await findStateId(team.id, statusName);
            await client.updateIssue(issueId, { stateId });
          },
          catch: (err) => classifyLinearError(err, `transition(${statusName})`),
        }),
        { call: `transition(${statusName})` },
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
            const labels = await client.issueLabels({
              filter: {
                team: { id: { eq: team.id } },
                name: { eq: labelName },
              },
            });
            const rawLabel = labels.nodes[0];
            if (!rawLabel) {
              throw new LinearNotFound({
                resource: "label",
                identifier: labelName,
                message: `Linear label "${labelName}" not found on team ${team.id}`,
              });
            }
            const label = decodeIssueLabelNode(rawLabel);
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
 * VA-354: read-only preflight that surfaces every Linear-side
 * misconfiguration `runway run` would hit. Returns a structured
 * result; the caller (currently `runway doctor`) decides how to
 * render. The returned `availableLabels` are sampled (max 50) so a
 * red ✗ on a missing label can show the operator what IS there.
 */
export interface LinearValidationResult {
  readonly team:
    | { kind: "ok"; id: string }
    | { kind: "missing"; key: string };
  readonly readyStatus: StateValidation;
  readonly inProgressStatus: StateValidation;
  readonly inReviewStatus: StateValidation;
  readonly hitlLabel:
    | { kind: "ok"; name: string }
    | { kind: "missing"; name: string; available: readonly string[] }
    | { kind: "skipped"; reason: string };
}

type StateValidation =
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
      readyStatus: { kind: "skipped", reason: "team missing" },
      inProgressStatus: { kind: "skipped", reason: "team missing" },
      inReviewStatus: { kind: "skipped", reason: "team missing" },
      hitlLabel: { kind: "skipped", reason: "team missing" },
    };
  }

  const states = await client.workflowStates({
    filter: { team: { id: { eq: team.id } } },
  });
  const stateNames = states.nodes.map((s) => s.name);
  const checkState = (want: string): StateValidation =>
    stateNames.includes(want)
      ? { kind: "ok", name: want }
      : { kind: "missing", name: want, available: stateNames };

  // Accept labels scoped to this team OR workspace-level labels (team: null).
  const labels = await client.issueLabels({
    filter: { or: [{ team: { id: { eq: team.id } } }, { team: { null: true } }] },
  });
  const labelNames = labels.nodes.map((l) => l.name);
  const hitlLabel = labelNames.includes(config.hitlLabel)
    ? { kind: "ok" as const, name: config.hitlLabel }
    : {
        kind: "missing" as const,
        name: config.hitlLabel,
        available: labelNames.slice(0, 50),
      };

  return {
    team: { kind: "ok", id: team.id },
    readyStatus: checkState(config.readyStatus),
    inProgressStatus: checkState(config.inProgressStatus),
    inReviewStatus: checkState(config.inReviewStatus),
    hitlLabel,
  };
}
