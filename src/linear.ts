import { LinearClient } from "@linear/sdk";
import { Data, Effect, Schedule } from "effect";
import type { Config } from "./config.js";

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

export type LinearError =
  | LinearNotFound
  | LinearUnauthorized
  | LinearRateLimited
  | LinearNetworkError
  | LinearTimeout;

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
    err instanceof LinearTimeout
  ) {
    return err;
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
}

/**
 * Concrete @linear/sdk-backed implementation. Tests inject their own
 * gateway; never reach for the SDK directly outside this file.
 *
 * The internal `find*` helpers stay plain `async` and throw typed
 * `LinearNotFound` directly. Only the public `LinearGateway` methods
 * wrap into `Effect.tryPromise` — that's the boundary the orchestrator
 * sees.
 */
export function createLinearGateway(config: Config): LinearGateway {
  const client = new LinearClient({ apiKey: config.linearApiKey });

  async function findStateId(teamId: string, name: string): Promise<string> {
    const states = await client.workflowStates({
      filter: { team: { id: { eq: teamId } }, name: { eq: name } },
    });
    const state = states.nodes[0];
    if (!state) {
      throw new LinearNotFound({
        resource: "state",
        identifier: name,
        message: `Linear workflow state "${name}" not found on team ${teamId}`,
      });
    }
    return state.id;
  }

  async function findTeamId(): Promise<string> {
    const teams = await client.teams({
      filter: { key: { eq: config.linearTeam } },
    });
    const team = teams.nodes[0];
    if (!team) {
      throw new LinearNotFound({
        resource: "team",
        identifier: config.linearTeam,
        message: `Linear team "${config.linearTeam}" not found`,
      });
    }
    return team.id;
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
    const project = projects.nodes[0];
    if (!project) {
      throw new LinearNotFound({
        resource: "project",
        identifier,
        message: `Linear project "${identifier}" not found`,
      });
    }
    return project.id;
  }

  return {
    fetchReady() {
      return applyLinearPolicy(
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
            return issues.nodes.map((i) => ({
              id: i.id,
              identifier: i.identifier,
              title: i.title,
              description: i.description ?? "",
            })) as readonly RunwayIssue[];
          },
          catch: (err) => classifyLinearError(err, "fetchReady"),
        }),
        { call: "fetchReady" },
      );
    },

    transition(issueId, statusName) {
      return applyLinearPolicy(
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
      );
    },

    applyLabel(issueId, labelName) {
      return applyLinearPolicy(
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
            const label = labels.nodes[0];
            if (!label) {
              throw new LinearNotFound({
                resource: "label",
                identifier: labelName,
                message: `Linear label "${labelName}" not found on team ${team.id}`,
              });
            }
            const existing = await issue.labels();
            const labelIds = [
              ...existing.nodes.map((l) => l.id),
              label.id,
            ];
            await client.updateIssue(issueId, { labelIds });
          },
          catch: (err) => classifyLinearError(err, `applyLabel(${labelName})`),
        }),
        { call: `applyLabel(${labelName})` },
      );
    },

    comment(issueId, body) {
      return applyLinearPolicy(
        Effect.tryPromise({
          try: async () => {
            await client.createComment({ issueId, body });
          },
          catch: (err) => classifyLinearError(err, "comment"),
        }),
        { call: "comment" },
      );
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
  const client = new LinearClient({ apiKey: config.linearApiKey });

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

  const labels = await client.issueLabels({
    filter: { team: { id: { eq: team.id } } },
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
