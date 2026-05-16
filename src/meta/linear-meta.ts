import { LinearClient } from "@linear/sdk";
import { Data, Effect, Redacted } from "effect";
import { applyLinearPolicy, type LinearError } from "../linear.js";
import { messageOf } from "./format.js";

/**
 * VA-402: Linear write surface for the IRA's meta-project. Slim by
 * design — the IRA needs (a) a stable Linear project to write into
 * and (b) a way to create one issue per pass output. Both behaviours
 * share runway's existing retry policy (`applyLinearPolicy`) so an
 * Anthropic-side rate limit and a Linear-side rate limit look
 * identical to the operator and produce identical span/log records.
 *
 * Keeps separate from `linear.ts` because the existing gateway is
 * issue-queue-shaped (fetchReady / transition / applyLabel / etc.) —
 * writing a brand-new issue into a brand-new project doesn't fit
 * that interface. A future refactor could fold the two; not worth
 * the churn at this slice.
 */

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface MetaLinearConfig {
  readonly linearApiKey: Redacted.Redacted<string>;
  /** Linear team key (e.g. "VA"). Same as runway's `RUNWAY_LINEAR_TEAM`. */
  readonly linearTeam: string;
  /**
   * The meta-project's name (default `runway-meta`). Resolved to
   * an ID lazily so re-running against a fresh workspace can
   * provision the project on first use.
   */
  readonly metaProjectName: string;
  /**
   * VA-406: optional runway-repo project name (the project where the
   * runway repo's own issues live — e.g. "Runway"). Severity-critical
   * Drain Reviews escalate by filing an issue in this project with
   * `Bug` + `runway-meta-promoted` labels. When unset, escalations
   * still create the team-level issue (with the same labels) but
   * skip project assignment — operators without a dedicated runway
   * project still get the loud signal.
   */
  readonly runwayRepoProjectName?: string;
}

export interface CreateRunReviewIssueArgs {
  /** Linear issue title — short, identifies the scope (issue id + drain). */
  readonly title: string;
  /**
   * Issue body in Markdown. The provenance disclaimer is prepended
   * automatically by `createRunReviewIssue` — callers pass the
   * Review body proper.
   */
  readonly body: string;
}

export type CreateDrainReviewIssueArgs = CreateRunReviewIssueArgs;

/**
 * VA-408: Weekly Review issue in the meta-project. Same shape as Run /
 * Drain Review writes — provenance disclaimer is prepended
 * automatically and the body is the Weekly Review markdown.
 */
export type CreateWeeklyReviewIssueArgs = CreateRunReviewIssueArgs;

/**
 * VA-406: arg shape for the severity-critical escalation. Lands in
 * `runwayRepoProjectName` (when set) with the supplied labels.
 * Labels that don't exist on the team are auto-created idempotently —
 * mirrors `ensureMetaProject`'s "first run provisions" pattern so
 * fresh workspaces don't require manual setup.
 */
export interface CreateRunwayRepoIssueArgs {
  readonly title: string;
  readonly body: string;
  /**
   * Labels to apply (by name). The Drain Review pass passes
   * `["Bug", "runway-meta-promoted"]` per the VA-406 AC. Labels are
   * resolved-or-created on the team scope; the issue carries the
   * resolved IDs.
   */
  readonly labels: readonly string[];
}

/**
 * VA-408: one open `runway-meta-promoted` issue as the promoter sees
 * it on its queue-defer pass. `themeKey` is parsed out of the issue
 * body's `<!-- runway-meta-theme-key: ... -->` HTML comment marker —
 * a previous Weekly Review stamped it there. When the marker is
 * missing (issue body was hand-edited, or the issue predates the
 * marker convention), the theme key is `null` and the promoter treats
 * the entry as "no match against new themes" (re-promotion is
 * preferable to false-negative defer).
 */
export interface OpenPromotedQueueEntry {
  readonly identifier: string;
  readonly url: string;
  readonly themeKey: string | null;
}

/**
 * VA-409: one `runway-meta-promoted` issue that moved to Done since a
 * given timestamp. The attribution loop walks these entries to grade
 * each shipped promotion against its predicted effect. Carries the
 * full issue body so `parsePredictedEffectFromBody` can extract the
 * stamped attribution block (v1.1.0) or fall back to the markdown
 * (v1.0.0) without a second Linear round-trip.
 */
export interface ShippedPromotedQueueEntry {
  readonly identifier: string;
  readonly url: string;
  readonly title: string;
  readonly body: string;
  readonly themeKey: string | null;
  /** ISO timestamp when the issue transitioned to a completed state. */
  readonly completedAt: string;
}

// ---------------------------------------------------------------------------
// Error ADT — narrower than LinearError but compatible
// ---------------------------------------------------------------------------

export class MetaLinearTeamNotFound extends Data.TaggedError(
  "MetaLinearTeamNotFound",
)<{ readonly team: string; readonly message: string }> {}

export class MetaLinearProjectCreateFailed extends Data.TaggedError(
  "MetaLinearProjectCreateFailed",
)<{ readonly projectName: string; readonly message: string }> {}

export class MetaLinearIssueCreateFailed extends Data.TaggedError(
  "MetaLinearIssueCreateFailed",
)<{ readonly title: string; readonly message: string }> {}

export class MetaLinearLabelCreateFailed extends Data.TaggedError(
  "MetaLinearLabelCreateFailed",
)<{ readonly labelName: string; readonly message: string }> {}

export type MetaLinearError =
  | MetaLinearTeamNotFound
  | MetaLinearProjectCreateFailed
  | MetaLinearIssueCreateFailed
  | MetaLinearLabelCreateFailed
  | LinearError;

// ---------------------------------------------------------------------------
// Provenance disclaimer
// ---------------------------------------------------------------------------

/**
 * VA-402 / PRD: every IRA-written Linear issue and comment opens
 * with this one-line disclaimer so the operator can always tell a
 * retrospectively-generated artifact from one a human authored.
 * Mirrors the `/triage` skill's pattern. Kept as a single source of
 * truth so a future rewording lands consistently across passes.
 */
export const IRA_PROVENANCE_DISCLAIMER =
  "> *This was generated by the Independent Review Agent (IRA).*";

/**
 * VA-408: parse the `<!-- runway-meta-theme-key: ... -->` marker out
 * of an issue body. The Weekly Review stamps this on every promoted
 * runway-repo issue so the next week's promoter can recognize the
 * open queue entry by exact key match. Returns null when the marker
 * is absent — operator hand-edits, pre-VA-408 issues, etc.
 *
 * Tolerant matcher: leading/trailing whitespace inside the comment is
 * stripped; the key may contain colons (the `target:fragment:hash`
 * shape the promoter emits). Lives here next to
 * `IRA_PROVENANCE_DISCLAIMER` so both convention markers stay in one
 * place.
 */
export function extractThemeKey(body: string): string | null {
  const match = /<!--\s*runway-meta-theme-key:\s*([^>]+?)\s*-->/.exec(body);
  if (!match) return null;
  const value = match[1]?.trim();
  return value && value.length > 0 ? value : null;
}

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

export interface MetaLinearGateway {
  /**
   * Resolve (or create) the meta-project's Linear ID. Idempotent —
   * a subsequent call with the same `metaProjectName` finds the
   * existing row and returns its ID without creating a duplicate.
   */
  ensureMetaProject(): Effect.Effect<string, MetaLinearError>;
  /**
   * Create one Linear issue inside the meta-project. Prepends the
   * provenance disclaimer to the body automatically. Returns the
   * created issue's identifier (e.g. `VA-501`) so the dashboard's
   * `meta_reviews` row can cross-link to it.
   */
  createRunReviewIssue(
    args: CreateRunReviewIssueArgs,
  ): Effect.Effect<{ readonly identifier: string; readonly url: string }, MetaLinearError>;
  /**
   * VA-406: create one Drain Review Linear issue inside the
   * meta-project. Shares the run-review write path — same project,
   * same provenance disclaimer prefix, same retry policy. Returns the
   * identifier + URL so the SQLite stub can cross-link and so a
   * severity-critical escalation can reference the drain-review in
   * its runway-repo issue body.
   */
  createDrainReviewIssue(
    args: CreateDrainReviewIssueArgs,
  ): Effect.Effect<{ readonly identifier: string; readonly url: string }, MetaLinearError>;
  /**
   * VA-406: create one issue in the runway-repo project (or just the
   * team when `runwayRepoProjectName` is unset). The Drain Review
   * pass calls this on severity-critical findings, supplying the
   * `["Bug", "runway-meta-promoted"]` label pair from the AC. Labels
   * missing on the team are auto-created so a fresh workspace doesn't
   * require manual scaffolding before the first escalation lands.
   *
   * Body assembly is the caller's job (it cross-links to the
   * drain-review issue); the provenance disclaimer is prepended here
   * to keep parity with the meta-project writes.
   */
  createRunwayRepoIssue(
    args: CreateRunwayRepoIssueArgs,
  ): Effect.Effect<{ readonly identifier: string; readonly url: string }, MetaLinearError>;
  /**
   * VA-408: create the Weekly Review Linear issue inside the
   * meta-project. Same write path as Run / Drain Review writes —
   * provenance disclaimer prepended, retry policy applied. The
   * promoter's runway-repo escalations go through `createRunwayRepoIssue`
   * separately so a Weekly Review with N promotions does N+1 Linear
   * writes (one weekly summary + N escalations).
   */
  createWeeklyReviewIssue(
    args: CreateWeeklyReviewIssueArgs,
  ): Effect.Effect<{ readonly identifier: string; readonly url: string }, MetaLinearError>;
  /**
   * VA-408: read the open `runway-meta-promoted` queue. The promoter's
   * queue-defer pass walks this list to skip themes that already have
   * an open promoted issue. "Open" = state type in `started` or
   * `unstarted` (Linear's vocabulary for Todo / In Progress — not
   * Done / Cancelled). Returned entries carry the theme-key parsed
   * from the issue body marker.
   */
  listOpenPromotedQueue(): Effect.Effect<
    readonly OpenPromotedQueueEntry[],
    MetaLinearError
  >;
  /**
   * VA-409: read every `runway-meta-promoted` issue that completed
   * (state type `completed`) at or after `sinceIso`. The Weekly
   * Review's attribution loop walks these to grade each shipped
   * promotion against its predicted effect. State type
   * `completed` is Linear's vocabulary for "Done" — `canceled`
   * issues are excluded because the change was abandoned, not
   * shipped.
   *
   * `sinceIso` is typically the prior Weekly Review's `created_at`;
   * an absent prior review collapses to "every shipped promoted
   * issue in the workspace" via passing the epoch, but the pass
   * skips the attribution section entirely on the first weekly to
   * keep the noise floor low.
   */
  listShippedPromotionsSince(
    sinceIso: string,
  ): Effect.Effect<
    readonly ShippedPromotedQueueEntry[],
    MetaLinearError
  >;
}

export function createMetaLinearGateway(
  config: MetaLinearConfig,
): MetaLinearGateway {
  const client = new LinearClient({
    apiKey: Redacted.value(config.linearApiKey),
  });

  // VA-406: cache the team id per gateway instance. Once-per-process
  // resolution — operators don't rename their team mid-drain, and the
  // critical-escalation path makes 2-3 calls to `resolveTeamId` in
  // sequence (drain-review issue + escalation labels + escalation
  // issue), so re-fetching every time is wasteful.
  let cachedTeamId: string | null = null;
  const resolveTeamId = (): Effect.Effect<string, MetaLinearError> =>
    cachedTeamId !== null
      ? Effect.succeed(cachedTeamId)
      : fetchTeamId().pipe(
          Effect.tap((id) =>
            Effect.sync(() => {
              cachedTeamId = id;
            }),
          ),
        );

  const fetchTeamId = (): Effect.Effect<string, MetaLinearError> =>
    applyLinearPolicy(
      Effect.tryPromise({
        try: async () => {
          const teams = await client.teams({
            filter: { key: { eq: config.linearTeam } },
          });
          const team = teams.nodes[0];
          if (!team) {
            throw new MetaLinearTeamNotFound({
              team: config.linearTeam,
              message: `Linear team "${config.linearTeam}" not found`,
            });
          }
          return team.id;
        },
        catch: (err) => {
          if (err instanceof MetaLinearTeamNotFound) {
            // Reflect into LinearError shape so the retry gate doesn't
            // fire — a missing team is an operator/config failure.
            return {
              _tag: "LinearNotFound" as const,
              resource: "team" as const,
              identifier: config.linearTeam,
              message: err.message,
            } as unknown as LinearError;
          }
          return {
            _tag: "LinearNetworkError" as const,
            message: messageOf(err),
          } as unknown as LinearError;
        },
      }),
      { call: "metaLinear.resolveTeamId" },
    );

  const findProjectIdByName = (
    name: string,
  ): Effect.Effect<string | null, LinearError> =>
    applyLinearPolicy(
      Effect.tryPromise({
        try: async () => {
          const projects = await client.projects({
            filter: { name: { eq: name } },
          });
          // The meta-project name is operator-controlled and
          // workspace-unique by convention. If multiple projects
          // happen to share the name (e.g. an operator scaffolded two
          // teams' meta-projects with the default name), pick the
          // first match — re-running ensureMetaProject won't create
          // a third, so the wider concern is "operator renames one
          // of them" which is out-of-band anyway.
          return projects.nodes[0]?.id ?? null;
        },
        catch: (err) =>
          ({
            _tag: "LinearNetworkError" as const,
            message: messageOf(err),
          }) as unknown as LinearError,
      }),
      { call: "metaLinear.findProjectIdByName" },
    );

  const ensureMetaProject = (): Effect.Effect<string, MetaLinearError> =>
    Effect.gen(function* () {
      const teamId = yield* resolveTeamId();
      const existing = yield* findProjectIdByName(config.metaProjectName);
      if (existing) return existing;
      // Project doesn't exist yet — create it. ProjectCreateInput
      // requires `name` and at least one team association.
      const created = yield* applyLinearPolicy(
        Effect.tryPromise({
          try: async () => {
            const payload = await client.createProject({
              name: config.metaProjectName,
              teamIds: [teamId],
              description:
                "Retrospective reviews emitted by the Independent Review Agent (IRA). One issue per Run / Drain / Weekly review. All issues open with a provenance disclaimer.",
            });
            const project = await payload.project;
            if (!project?.id) {
              throw new Error("project create payload had no project.id");
            }
            return project.id;
          },
          catch: (err) =>
            ({
              _tag: "LinearNetworkError" as const,
              message: messageOf(err),
            }) as unknown as LinearError,
        }),
        { call: "metaLinear.createProject" },
      ).pipe(
        Effect.catchAll((err) =>
          Effect.fail(
            new MetaLinearProjectCreateFailed({
              projectName: config.metaProjectName,
              message: messageOf(err),
            }),
          ),
        ),
      );
      return created;
    });

  // VA-406: shared issue-create path for both Run Review and Drain
  // Review writes into the meta-project. Returns the identifier + url
  // straight from the Linear payload. Pulled out as a closure so the
  // two gateway methods don't drift.
  const createMetaProjectIssue = (
    args: CreateRunReviewIssueArgs,
    call: string,
  ): Effect.Effect<{ readonly identifier: string; readonly url: string }, MetaLinearError> =>
    Effect.gen(function* () {
      const teamId = yield* resolveTeamId();
      const projectId = yield* ensureMetaProject();
      const body = [IRA_PROVENANCE_DISCLAIMER, "", args.body].join("\n");
      return yield* applyLinearPolicy(
        Effect.tryPromise({
          try: async () => {
            const payload = await client.createIssue({
              teamId,
              projectId,
              title: args.title,
              description: body,
            });
            const issue = await payload.issue;
            if (!issue?.identifier || !issue?.url) {
              throw new Error("issue create payload had no identifier/url");
            }
            return { identifier: issue.identifier, url: issue.url };
          },
          catch: (err) =>
            ({
              _tag: "LinearNetworkError" as const,
              message: messageOf(err),
            }) as unknown as LinearError,
        }),
        { call },
      ).pipe(
        Effect.catchAll((err) =>
          Effect.fail(
            new MetaLinearIssueCreateFailed({
              title: args.title,
              message: messageOf(err),
            }),
          ),
        ),
      );
    });

  // VA-406: resolve a project id by name on the configured team, or
  // return null when nothing matches. Used by the runway-repo
  // escalation path — operators may omit `runwayRepoProjectName` and
  // we treat that as "team-only, no project assignment" rather than
  // failing. Distinct from `findProjectIdByName` (used by the
  // meta-project provisioning path) because escalation does NOT
  // auto-create the runway-repo project — that's the operator's
  // canonical project, not something the IRA invents.
  const findRunwayRepoProjectId = (
    teamId: string,
    name: string,
  ): Effect.Effect<string | null, LinearError> =>
    applyLinearPolicy(
      Effect.tryPromise({
        try: async () => {
          const projects = await client.projects({
            filter: {
              name: { eq: name },
              accessibleTeams: { some: { id: { eq: teamId } } },
            },
          });
          return projects.nodes[0]?.id ?? null;
        },
        catch: (err) =>
          ({
            _tag: "LinearNetworkError" as const,
            message: messageOf(err),
          }) as unknown as LinearError,
      }),
      { call: "metaLinear.findRunwayRepoProjectId" },
    );

  // VA-406: resolve a label id by name on the team. When the label
  // doesn't exist on the team, create it idempotently — mirrors the
  // `ensureMetaProject` pattern so a fresh workspace lands its first
  // escalation without manual setup. Two concurrent escalations could
  // race and produce duplicate labels with the same name, but Linear
  // tolerates duplicate label names on a team (the IDs differ), and
  // the issue-create still attaches the first match — the only
  // downside is a cosmetic dupe in the team's label list, fixable in
  // the Linear UI.
  const ensureLabel = (
    teamId: string,
    labelName: string,
  ): Effect.Effect<string, MetaLinearError> =>
    Effect.gen(function* () {
      const existing = yield* applyLinearPolicy(
        Effect.tryPromise({
          try: async () => {
            const labels = await client.issueLabels({
              filter: {
                name: { eq: labelName },
                team: { id: { eq: teamId } },
              },
            });
            return labels.nodes[0]?.id ?? null;
          },
          catch: (err) =>
            ({
              _tag: "LinearNetworkError" as const,
              message: messageOf(err),
            }) as unknown as LinearError,
        }),
        { call: "metaLinear.findLabel" },
      );
      if (existing) return existing;
      const created = yield* applyLinearPolicy(
        Effect.tryPromise({
          try: async () => {
            const payload = await client.createIssueLabel({
              name: labelName,
              teamId,
            });
            const label = await payload.issueLabel;
            if (!label?.id) {
              throw new Error("label create payload had no id");
            }
            return label.id;
          },
          catch: (err) =>
            ({
              _tag: "LinearNetworkError" as const,
              message: messageOf(err),
            }) as unknown as LinearError,
        }),
        { call: "metaLinear.createLabel" },
      ).pipe(
        Effect.catchAll((err) =>
          Effect.fail(
            new MetaLinearLabelCreateFailed({
              labelName,
              message: messageOf(err),
            }),
          ),
        ),
      );
      return created;
    });

  return {
    ensureMetaProject,
    createRunReviewIssue(args) {
      return createMetaProjectIssue(args, "metaLinear.createIssue");
    },
    createDrainReviewIssue(args) {
      return createMetaProjectIssue(args, "metaLinear.createDrainReviewIssue");
    },
    createWeeklyReviewIssue(args) {
      return createMetaProjectIssue(args, "metaLinear.createWeeklyReviewIssue");
    },
    listOpenPromotedQueue() {
      return Effect.gen(function* () {
        const teamId = yield* resolveTeamId();
        return yield* applyLinearPolicy(
          Effect.tryPromise({
            try: async () => {
              // VA-408: filter by team + label name + open state types.
              // `started` and `unstarted` together cover Linear's Todo +
              // In Progress states; `completed` / `canceled` / `backlog`
              // are excluded so the promoter doesn't defer behind a
              // shipped or icebox-bound issue.
              const issues = await client.issues({
                filter: {
                  team: { id: { eq: teamId } },
                  labels: { some: { name: { eq: "runway-meta-promoted" } } },
                  state: {
                    type: { in: ["started", "unstarted"] },
                  },
                },
                first: 50,
              });
              const out: OpenPromotedQueueEntry[] = [];
              for (const issue of issues.nodes) {
                if (!issue.identifier || !issue.url) continue;
                const body =
                  typeof issue.description === "string"
                    ? issue.description
                    : "";
                out.push({
                  identifier: issue.identifier,
                  url: issue.url,
                  themeKey: extractThemeKey(body),
                });
              }
              return out;
            },
            catch: (err) =>
              ({
                _tag: "LinearNetworkError" as const,
                message: messageOf(err),
              }) as unknown as LinearError,
          }),
          { call: "metaLinear.listOpenPromotedQueue" },
        );
      });
    },
    listShippedPromotionsSince(sinceIso) {
      return Effect.gen(function* () {
        const teamId = yield* resolveTeamId();
        return yield* applyLinearPolicy(
          Effect.tryPromise({
            try: async () => {
              // VA-409: completed `runway-meta-promoted` issues since
              // `sinceIso`. State type `completed` is Linear's "Done"
              // bucket; `canceled` is intentionally excluded since the
              // change was abandoned, not shipped. The `completedAt`
              // filter mirrors the gateway doc-comment — we use
              // Linear's IssueFilter `completedAt: { gte }` to push the
              // time predicate to the server.
              const issues = await client.issues({
                filter: {
                  team: { id: { eq: teamId } },
                  labels: { some: { name: { eq: "runway-meta-promoted" } } },
                  state: { type: { eq: "completed" } },
                  completedAt: { gte: new Date(sinceIso) },
                },
                first: 50,
              });
              const out: ShippedPromotedQueueEntry[] = [];
              for (const issue of issues.nodes) {
                if (!issue.identifier || !issue.url) continue;
                const body =
                  typeof issue.description === "string"
                    ? issue.description
                    : "";
                const completedAt = issue.completedAt
                  ? issue.completedAt instanceof Date
                    ? issue.completedAt.toISOString()
                    : String(issue.completedAt)
                  : null;
                if (!completedAt) continue;
                out.push({
                  identifier: issue.identifier,
                  url: issue.url,
                  title: issue.title ?? "(untitled)",
                  body,
                  themeKey: extractThemeKey(body),
                  completedAt,
                });
              }
              return out;
            },
            catch: (err) =>
              ({
                _tag: "LinearNetworkError" as const,
                message: messageOf(err),
              }) as unknown as LinearError,
          }),
          { call: "metaLinear.listShippedPromotionsSince" },
        );
      });
    },
    createRunwayRepoIssue(args) {
      return Effect.gen(function* () {
        const teamId = yield* resolveTeamId();
        // Resolve labels + project in parallel — both depend only on
        // teamId, so the critical-escalation path saves one Linear RTT.
        const [labelIds, projectId] = yield* Effect.all(
          [
            Effect.all(
              args.labels.map((name) => ensureLabel(teamId, name)),
              { concurrency: "unbounded" },
            ),
            config.runwayRepoProjectName
              ? findRunwayRepoProjectId(teamId, config.runwayRepoProjectName)
              : Effect.succeed(null),
          ],
          { concurrency: "unbounded" },
        );
        const body = [IRA_PROVENANCE_DISCLAIMER, "", args.body].join("\n");
        return yield* applyLinearPolicy(
          Effect.tryPromise({
            try: async () => {
              const payload = await client.createIssue({
                teamId,
                // projectId is intentionally omitted when null —
                // Linear's API treats the absent key as "no project,"
                // not "default project", so omitting cleanly is the
                // right call vs sending `projectId: null`.
                ...(projectId ? { projectId } : {}),
                labelIds: labelIds.length === 0 ? undefined : labelIds,
                title: args.title,
                description: body,
              });
              const issue = await payload.issue;
              if (!issue?.identifier || !issue?.url) {
                throw new Error(
                  "runway-repo issue create payload had no identifier/url",
                );
              }
              return { identifier: issue.identifier, url: issue.url };
            },
            catch: (err) =>
              ({
                _tag: "LinearNetworkError" as const,
                message: messageOf(err),
              }) as unknown as LinearError,
          }),
          { call: "metaLinear.createRunwayRepoIssue" },
        ).pipe(
          Effect.catchAll((err) =>
            Effect.fail(
              new MetaLinearIssueCreateFailed({
                title: args.title,
                message: messageOf(err),
              }),
            ),
          ),
        );
      });
    },
  };
}
