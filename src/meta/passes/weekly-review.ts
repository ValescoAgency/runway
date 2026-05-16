import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { META_REVIEW_KIND, type Storage } from "../../dashboard/storage.js";
import {
  loadContextFor,
  type WeeklyReviewContext,
} from "../context.js";
import type {
  MetaDashboardRead,
  WindowedMetaRow,
} from "../dashboard-read.js";
import {
  formatAnthropicError,
  formatParseError,
  messageOf,
  nowIso,
} from "../format.js";
import type {
  MetaLinearGateway,
  OpenPromotedQueueEntry,
} from "../linear-meta.js";
import { callWeeklyReview } from "../llm.js";
import {
  runPromoter,
  type CandidatePromotion,
  type FilteredTheme,
  type OpenPromotedIssue,
  type PromoterOutput,
  type RecommendationSource,
  type RecurringObservation,
} from "../promoter.js";
import {
  type Promotion,
  type Recommendation,
  RUNWAY_META_THEME_KEY_MARKER,
  WEEKLY_REVIEW_VERSION,
  type WeeklyReview,
} from "../templates.js";

/**
 * VA-408: weekly IRA pass. Reads the week's Run + Drain Reviews +
 * prior 4 Weekly Reviews + `.out-of-scope/` + open promoted-queue,
 * runs the promoter (mechanical ranking + dedupe + budget cap), then
 * asks the IRA LLM to write the narrative + falsifiable predicted
 * effects per promotion. Promotions land as runway-repo issues with
 * `<category> + runway-meta-promoted` labels; the Weekly Review
 * lands in runway-meta.
 *
 * Failure mode differs from Run / Drain Review: this pass is the
 * LOUD-failure pass per PRD. On LLM retry exhaustion we return a
 * `failed-loud` outcome that the runner / CLI maps to a non-zero
 * exit, with NO Linear stub and NO `meta-failed` SQLite row. Cron
 * MAILTO / GitHub Actions step failure is the audit trail; silent
 * gaps are not acceptable for the only promoter pass.
 */

// ---------------------------------------------------------------------------
// Inputs / outputs
// ---------------------------------------------------------------------------

export interface WeeklyReviewPassDeps {
  readonly anthropicApiKey: string;
  readonly metaWeeklyModel: string;
  readonly dashboardRead: MetaDashboardRead;
  readonly metaLinear: MetaLinearGateway;
  readonly storage: Storage;
  /**
   * cwd of the runway invocation. Used to locate `.out-of-scope/`.
   * Defaults to `process.cwd()` in production; tests inject a
   * tmpdir.
   */
  readonly cwd: string;
}

export interface WeeklyReviewPassArgs {
  readonly startIso: string;
  readonly endIso: string;
}

export type WeeklyReviewPassOutcome =
  | {
      readonly kind: "review";
      readonly metaReviewId: string;
      readonly linearIdentifier: string;
      readonly linearUrl: string;
      /**
       * Number of promotions that landed as runway-repo issues. May
       * be < `parsed.promotions.length` if individual Linear writes
       * failed — the pass continues so a partial week still produces
       * a Weekly Review issue.
       */
      readonly promotionsFiled: number;
      readonly promotionsPlanned: number;
    }
  | {
      // VA-408 AC: "exit code is non-zero after retry exhaustion". No
      // stub Linear issue, no meta-failed SQLite row. The CLI maps
      // this to `process.exit(1)` so cron mail surfaces it.
      readonly kind: "failed-loud";
      readonly reason: string;
    }
  | {
      // VA-408: defensive — the window contained no Run Reviews. A
      // genuine empty week is operator-meaningful (no work happened)
      // so we still write a Weekly Review issue, but the pass returns
      // this variant when the window is so empty there's literally
      // nothing to promote AND no Reviews to summarize.
      readonly kind: "no-reviews";
      readonly reason: string;
    };

// ---------------------------------------------------------------------------
// Pass body
// ---------------------------------------------------------------------------

export const runWeeklyReviewPass = (
  args: WeeklyReviewPassArgs,
  deps: WeeklyReviewPassDeps,
): Effect.Effect<WeeklyReviewPassOutcome, never, never> =>
  Effect.gen(function* () {
    // 1) Load context. Dashboard-side failure is fatal (no point
    //    asking the LLM to write a Weekly Review with no Reviews to
    //    reflect on); FS + Linear failures degrade to empty arrays
    //    inside the loader.
    const contextResult = yield* loadContextFor(
      {
        pass: "weekly-review",
        startIso: args.startIso,
        endIso: args.endIso,
        cwd: deps.cwd,
        metaLinear: deps.metaLinear,
      },
      deps.dashboardRead,
    ).pipe(Effect.either);
    if (contextResult._tag === "Left") {
      return {
        kind: "failed-loud",
        reason: `failed to load context: ${messageOf(contextResult.left)}`,
      };
    }
    if (contextResult.right.pass !== "weekly-review") {
      return {
        kind: "failed-loud",
        reason: `context loader returned unexpected pass: ${contextResult.right.pass}`,
      };
    }
    const ctx: WeeklyReviewContext = contextResult.right.context;

    // 2) Empty-window short-circuit: nothing to grade.
    if (
      ctx.runReviews.length === 0 &&
      ctx.drainReviews.length === 0
    ) {
      return {
        kind: "no-reviews",
        reason: `no Run / Drain Reviews in window [${args.startIso}, ${args.endIso})`,
      };
    }

    // 3) Run the promoter (mechanical: group + corroborate + filter +
    //    rank + cap). Promoter output feeds the LLM prompt.
    const recommendations = extractRecommendationSources(ctx.runReviews);
    const promoterOutput = runPromoter({
      recommendations,
      openPromotedQueue: ctx.openPromotedQueue
        .filter((q): q is OpenPromotedQueueEntry & { themeKey: string } =>
          q.themeKey !== null,
        )
        .map(
          (q): OpenPromotedIssue => ({
            identifier: q.identifier,
            themeKey: q.themeKey,
          }),
        ),
      outOfScopeEntries: ctx.outOfScopeEntries,
    });

    // 4) Call the LLM with the structured Weekly Review prompt.
    const llmResult = yield* callWeeklyReview({
      apiKey: deps.anthropicApiKey,
      model: deps.metaWeeklyModel,
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: composeUserPrompt(args, ctx, promoterOutput),
    }).pipe(Effect.either);
    if (llmResult._tag === "Left") {
      // VA-408: retry exhaustion → loud failure. No stub, no row.
      return {
        kind: "failed-loud",
        reason: `LLM call failed after retry: ${formatAnthropicError(llmResult.left)}`,
      };
    }
    const parsed = llmResult.right;
    if (!parsed.ok) {
      return {
        kind: "failed-loud",
        reason: `LLM response failed parse: ${formatParseError(parsed.error)}`,
      };
    }

    // 5) Promotions: file each as a runway-repo issue. Best-effort
    //    per promotion — if Linear fails for one, the others still
    //    land. The Weekly Review issue body cross-links to each
    //    promotion that succeeded.
    const filings = yield* fileEachPromotion(parsed.report.promotions, deps);

    // 6) Weekly Review issue in runway-meta with provenance disclaimer
    //    + cross-links to the filed promotions.
    const weeklyIssueResult = yield* deps.metaLinear
      .createWeeklyReviewIssue({
        title: `Weekly Review: ${shortWindowLabel(args)}`,
        body: renderWeeklyReviewMarkdown(parsed.report, args, filings),
      })
      .pipe(Effect.either);
    if (weeklyIssueResult._tag === "Left") {
      // Linear-side failure on the summary write — surface as loud
      // failure. The promotion issues may have landed already; that's
      // not ideal but the operator can re-run the weekly to write the
      // summary (the open-queue defer + duplicate-prevention isn't
      // automatic across summary-vs-promotion writes in v1).
      return {
        kind: "failed-loud",
        reason: `Linear weekly-review issue create failed: ${messageOf(weeklyIssueResult.left)}`,
      };
    }

    // 7) Save the SQLite row last (cross-link is now resolved).
    const metaReviewId = randomUUID();
    deps.storage.saveMetaReview({
      id: metaReviewId,
      kind: META_REVIEW_KIND.WEEKLY,
      scope: `${args.startIso}/${args.endIso}`,
      drainId: null,
      issueId: null,
      contentJson: JSON.stringify({
        review: parsed.report,
        linear_identifier: weeklyIssueResult.right.identifier,
        linear_url: weeklyIssueResult.right.url,
        promotion_filings: filings.map((f) => ({
          theme_key: f.themeKey,
          identifier: f.identifier,
          url: f.url,
          error: f.error,
        })),
        promoter_summary: {
          candidate_count: promoterOutput.candidatePromotions.length,
          noted_count: promoterOutput.notedButNotPromoted.length,
          recurring_count: promoterOutput.recurringObservations.length,
        },
        degraded_sources: ctx.degradedSources,
      }),
      templateVersion: WEEKLY_REVIEW_VERSION,
      createdAt: nowIso(),
    });

    return {
      kind: "review",
      metaReviewId,
      linearIdentifier: weeklyIssueResult.right.identifier,
      linearUrl: weeklyIssueResult.right.url,
      promotionsFiled: filings.filter((f) => f.identifier !== null).length,
      promotionsPlanned: parsed.report.promotions.length,
    };
  });

// ---------------------------------------------------------------------------
// Promotion filing
// ---------------------------------------------------------------------------

interface PromotionFiling {
  readonly themeKey: string;
  readonly title: string;
  readonly target: Recommendation["target"];
  readonly category: Promotion["category"];
  // Set on success; null when the Linear write failed.
  readonly identifier: string | null;
  readonly url: string | null;
  // Set on failure; null on success. Carried into the SQLite row's
  // content_json so an operator inspecting the dashboard sees why a
  // promotion didn't land.
  readonly error: string | null;
}

const fileEachPromotion = (
  promotions: readonly Promotion[],
  deps: WeeklyReviewPassDeps,
): Effect.Effect<readonly PromotionFiling[], never, never> =>
  Effect.gen(function* () {
    const results: PromotionFiling[] = [];
    // Sequential — Linear's API isn't rate-limited per call but
    // running 5 issue-creates in parallel risks tripping the global
    // workspace mutation rate. Sequential is safe and still finishes
    // in seconds for a 5-promotion batch.
    for (const promotion of promotions) {
      const labels = [promotion.category, "runway-meta-promoted"];
      const body = renderPromotionMarkdown(promotion);
      const writeResult = yield* deps.metaLinear
        .createRunwayRepoIssue({
          title: promotion.title,
          body,
          labels,
        })
        .pipe(Effect.either);
      if (writeResult._tag === "Right") {
        results.push({
          themeKey: promotion.theme_key,
          title: promotion.title,
          target: promotion.target,
          category: promotion.category,
          identifier: writeResult.right.identifier,
          url: writeResult.right.url,
          error: null,
        });
      } else {
        results.push({
          themeKey: promotion.theme_key,
          title: promotion.title,
          target: promotion.target,
          category: promotion.category,
          identifier: null,
          url: null,
          error: messageOf(writeResult.left),
        });
      }
    }
    return results;
  });

// ---------------------------------------------------------------------------
// Recommendation extraction from raw meta_reviews rows
// ---------------------------------------------------------------------------

/**
 * VA-408: parse each `meta-run-review` row's content_json into a
 * `RunReview` and walk its `recommendations` array. Rows that fail
 * to parse (template_version drift, malformed JSON) are silently
 * skipped — the IRA's broader narrative still has the row count as
 * context, and the operator sees the parse-failure stubs through the
 * `meta-failed` kind separately.
 */
const extractRecommendationSources = (
  rows: readonly WindowedMetaRow[],
): readonly RecommendationSource[] => {
  const out: RecommendationSource[] = [];
  for (const row of rows) {
    if (row.kind !== "meta-run-review") continue;
    const parsed = parseRunReviewContentJson(row.contentJson);
    if (!parsed) continue;
    // Use the meta-review row id as the source identifier. The Weekly
    // Review's content_json keeps the SQLite cross-link; the LLM
    // narrative refers to these via "Run Review <id>" so the
    // identifier shape matches the dashboard URL.
    for (const rec of parsed.recommendations) {
      out.push({
        sourceMetaReviewIdentifier: row.id,
        recommendation: rec,
      });
    }
  }
  return out;
};

const parseRunReviewContentJson = (json: string): { recommendations: readonly Recommendation[] } | null => {
  try {
    // VA-408: the meta_reviews row's content_json wraps the parsed
    // review under a "review" key when the pass writes it. Fall back
    // to root-level fields for forward-compat with hypothetical
    // future writers.
    const parsed = JSON.parse(json) as
      | { review?: { recommendations?: unknown }; recommendations?: unknown }
      | null;
    const recs =
      parsed && typeof parsed === "object"
        ? (parsed.review?.recommendations ?? parsed.recommendations)
        : undefined;
    if (!Array.isArray(recs)) return null;
    const out: Recommendation[] = [];
    for (const r of recs) {
      if (
        r &&
        typeof r === "object" &&
        typeof (r as { target?: unknown }).target === "string" &&
        typeof (r as { change?: unknown }).change === "string" &&
        typeof (r as { confidence?: unknown }).confidence === "string"
      ) {
        const target = (r as { target: string }).target;
        const change = (r as { change: string }).change;
        const confidence = (r as { confidence: string }).confidence;
        if (
          (target === "prompt" ||
            target === "workflow" ||
            target === "sandcastle" ||
            target === "issue-body" ||
            target === "tooling") &&
          (confidence === "LOW" ||
            confidence === "MEDIUM" ||
            confidence === "HIGH")
        ) {
          out.push({ target, change, confidence });
        }
      }
    }
    return { recommendations: out };
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = [
  "You are the Independent Review Agent (IRA) — a retrospective evaluator",
  "for the runway coding-agent orchestrator. You are reviewing one WEEK",
  "(a configurable time window — defaults to the trailing 7 days) of",
  "Run Reviews and Drain Reviews.",
  "",
  "Your job has three parts, in priority order:",
  "  1. Summarize the week. Throughput, success rate, HITL escape rate,",
  "     revert rate, infra-error rate. Compare against the prior week's",
  "     Weekly Review if one exists.",
  "  2. Write the *Promotions to runway-repo* block. The promoter (a",
  "     deterministic algorithm running BEFORE you) has already filtered",
  "     and ranked the candidate themes — you receive a pre-computed",
  "     top-N list. Your job is to write the QUALITATIVE surfaces per",
  "     promotion: a shippable title, a runway-spec-quality change spec,",
  "     concrete acceptance criteria, and a FALSIFIABLE predicted effect",
  "     with an explicit minimum sample size (e.g. n=10 post-ship runs",
  "     of refactor-class issues).",
  "  3. Write the *Noted but not promoted* block. The promoter has",
  "     pre-classified entries by reason (`budget-cap`,",
  "     `deferred-open-promotion`, `out-of-scope`). Echo each with a",
  "     one-line summary; you may add `low-confidence` reason entries",
  "     for promoter candidates you decline to promote on qualitative",
  "     grounds.",
  "",
  "Output exactly one fenced block, tagged `runway-weekly-review`,",
  "containing a JSON object matching the schema below. The fence must",
  "be on its own line; the body must be valid JSON. You may emit a",
  "short preamble before the fence, but nothing after the closing",
  "fence.",
  "",
  "Schema (template_version 1.0.0):",
  "  {",
  '    "template_version": "1.0.0",',
  '    "time_window": { "start_iso": "<echo>", "end_iso": "<echo>" },',
  '    "rates": { "throughput": <n>, "success_pct": <0-100>,',
  '               "hitl_pct": <0-100>, "revert_pct": <0-100>,',
  '               "infra_error_pct": <0-100> },',
  '    "rates_delta_vs_prior_week": <delta object or null>,',
  '    "narrative": "<prose summarizing the week>",',
  '    "recurring_themes": [',
  '      { "target": <prompt|workflow|sandcastle|issue-body|tooling>,',
  '        "description": "<one line>",',
  '        "corroboration_count": <n> } ],',
  '    "promotions": [',
  "      { /* echo theme_key, target, corroboration_count,",
  "           recommendation_confidence verbatim from the promoter",
  "           input; YOU author title, category, change_spec,",
  "           acceptance_criteria, source_meta_review_identifiers,",
  "           predicted_effect */ } ],",
  '    "noted_but_not_promoted": [',
  "      { /* echo theme_key, target, corroboration_count, reason,",
  "           deferred_behind verbatim; you author description */ } ]",
  "  }",
  "",
  "Hard cap: `promotions` has at most 5 entries. The promoter pre-filtered",
  "to this cap; if you decline a candidate on qualitative grounds, move",
  "it to `noted_but_not_promoted` with `reason: low-confidence`.",
  "",
  "Predicted-effect contract — non-negotiable. Every promotion declares:",
  "  - A claim (specific, falsifiable, NOT motherhood-and-apple-pie).",
  "  - A minimum sample size (integer > 0).",
  "  - A sample description (what kind of runs count toward the n=X).",
  "If you can't write a falsifiable claim for a promotion candidate, move",
  "it to `noted_but_not_promoted` with `reason: low-confidence`. The",
  "attribution loop reads these blocks to grade HELD / PARTIAL / MISSED",
  "after the change ships — vague claims defeat the whole loop.",
].join("\n");

const composeUserPrompt = (
  args: WeeklyReviewPassArgs,
  ctx: WeeklyReviewContext,
  promoter: PromoterOutput,
): string => {
  const lines: string[] = [];
  lines.push(`Window: ${args.startIso} → ${args.endIso}`);
  lines.push(
    `Counts: ${ctx.runReviews.length} run reviews, ${ctx.drainReviews.length} drain reviews, ${ctx.priorWeeklyReviews.length} prior weekly reviews`,
  );
  if (ctx.degradedSources.outOfScope) {
    lines.push(`Degraded: ${ctx.degradedSources.outOfScope}`);
  }
  if (ctx.degradedSources.openPromotedQueue) {
    lines.push(`Degraded: ${ctx.degradedSources.openPromotedQueue}`);
  }
  lines.push("");

  lines.push("# Promoter output — top-N candidate promotions (write narrative + predicted effects for these)");
  lines.push("");
  if (promoter.candidatePromotions.length === 0) {
    lines.push("(none — no themes met the corroboration threshold)");
  } else {
    for (const c of promoter.candidatePromotions) {
      lines.push(renderCandidateForPrompt(c));
    }
  }
  lines.push("");

  lines.push("# Promoter output — noted-but-not-promoted (echo these in the output block)");
  lines.push("");
  if (promoter.notedButNotPromoted.length === 0) {
    lines.push("(none)");
  } else {
    for (const f of promoter.notedButNotPromoted) {
      lines.push(renderFilteredForPrompt(f));
    }
  }
  lines.push("");

  lines.push("# Promoter output — recurring observations (themes below corroboration threshold)");
  lines.push("");
  if (promoter.recurringObservations.length === 0) {
    lines.push("(none)");
  } else {
    for (const o of promoter.recurringObservations) {
      lines.push(renderRecurringForPrompt(o));
    }
  }
  lines.push("");

  lines.push("# Run Reviews in window");
  lines.push("");
  if (ctx.runReviews.length === 0) {
    lines.push("(none)");
  } else {
    for (const r of ctx.runReviews) {
      lines.push(renderRowForPrompt(r));
    }
  }
  lines.push("");

  lines.push("# Drain Reviews in window");
  lines.push("");
  if (ctx.drainReviews.length === 0) {
    lines.push("(none)");
  } else {
    for (const r of ctx.drainReviews) {
      lines.push(renderRowForPrompt(r));
    }
  }
  lines.push("");

  lines.push("# Prior Weekly Reviews (newest first — for trend grounding)");
  lines.push("");
  if (ctx.priorWeeklyReviews.length === 0) {
    lines.push("(none — fresh workspace OR first weekly review)");
  } else {
    for (const r of ctx.priorWeeklyReviews) {
      lines.push(renderRowForPrompt(r));
    }
  }

  return lines.join("\n");
};

const renderCandidateForPrompt = (c: CandidatePromotion): string =>
  [
    `- theme_key: ${c.themeKey}`,
    `  target: ${c.target}`,
    `  corroboration_count: ${c.corroborationCount}`,
    `  recommendation_confidence: ${c.maxConfidence}`,
    `  source_meta_review_identifiers: ${JSON.stringify(c.sourceMetaReviewIdentifiers)}`,
    `  representative_change: ${c.representativeChange}`,
  ].join("\n");

const renderFilteredForPrompt = (f: FilteredTheme): string =>
  [
    `- theme_key: ${f.themeKey}`,
    `  target: ${f.target}`,
    `  reason: ${f.reason}`,
    `  corroboration_count: ${f.corroborationCount}`,
    `  deferred_behind: ${f.deferredBehind ?? "null"}`,
    `  out_of_scope_filename: ${f.outOfScopeFilename ?? "null"}`,
    `  description: ${f.representativeChange}`,
  ].join("\n");

const renderRecurringForPrompt = (o: RecurringObservation): string =>
  [
    `- target: ${o.target}`,
    `  corroboration_count: ${o.corroborationCount}`,
    `  description: ${o.representativeChange}`,
  ].join("\n");

const renderRowForPrompt = (row: WindowedMetaRow): string => {
  // Compact projection — the prompt can balloon fast with N rows
  // × full content_json. Show id + kind + drain + truncated body.
  const body = row.contentJson.length > 1200
    ? row.contentJson.slice(0, 1200) + "…(truncated)"
    : row.contentJson;
  return [
    `- id: ${row.id}`,
    `  kind: ${row.kind}`,
    `  drain_id: ${row.drainId ?? "null"}`,
    `  issue_id: ${row.issueId ?? "null"}`,
    `  created_at: ${row.createdAt}`,
    `  template_version: ${row.templateVersion}`,
    `  content: ${body}`,
  ].join("\n");
};

// ---------------------------------------------------------------------------
// Linear issue body rendering
// ---------------------------------------------------------------------------

const renderWeeklyReviewMarkdown = (
  review: WeeklyReview,
  args: WeeklyReviewPassArgs,
  filings: readonly PromotionFiling[],
): string => {
  const lines: string[] = [];
  lines.push(`**Window**: \`${args.startIso}\` → \`${args.endIso}\``);
  lines.push("");
  lines.push("## Rates");
  lines.push("");
  lines.push(renderRatesTable(review));
  lines.push("");
  if (review.narrative.length > 0) {
    lines.push("## Narrative");
    lines.push("");
    lines.push(review.narrative);
    lines.push("");
  }
  if (review.recurring_themes.length > 0) {
    lines.push("## Recurring themes");
    lines.push("");
    for (const t of review.recurring_themes) {
      lines.push(`- (\`${t.target}\`, ×${t.corroboration_count}) ${t.description}`);
    }
    lines.push("");
  }
  lines.push("## Promotions to runway-repo");
  lines.push("");
  if (review.promotions.length === 0) {
    lines.push("(none — no themes met the bar this week)");
  } else {
    for (let i = 0; i < review.promotions.length; i += 1) {
      const p = review.promotions[i];
      if (!p) continue;
      const filing = filings.find((f) => f.themeKey === p.theme_key);
      const status = filing?.identifier
        ? `[${filing.identifier}](${filing.url})`
        : `(filing failed: ${filing?.error ?? "unknown"})`;
      lines.push(`### ${i + 1}. ${p.title} — ${status}`);
      lines.push("");
      lines.push(
        `**Target**: \`${p.target}\` | **Category**: \`${p.category}\` | **Confidence**: \`${p.recommendation_confidence}\` | **Corroboration**: ×${p.corroboration_count}`,
      );
      lines.push("");
      lines.push("**Predicted effect**:");
      lines.push(`> ${p.predicted_effect.claim}`);
      lines.push(
        `> _n ≥ ${p.predicted_effect.min_sample_size} ${p.predicted_effect.sample_description}_`,
      );
      lines.push("");
    }
  }
  lines.push("## Noted but not promoted");
  lines.push("");
  if (review.noted_but_not_promoted.length === 0) {
    lines.push("(none)");
  } else {
    for (const n of review.noted_but_not_promoted) {
      const trailer =
        n.reason === "deferred-open-promotion" && n.deferred_behind
          ? ` (deferred — open promotion ${n.deferred_behind})`
          : ` (${n.reason})`;
      lines.push(`- (\`${n.target}\`, ×${n.corroboration_count}) ${n.description}${trailer}`);
    }
  }
  return lines.join("\n");
};

const renderRatesTable = (review: WeeklyReview): string => {
  const r = review.rates;
  const d = review.rates_delta_vs_prior_week;
  const delta = (v: number | undefined): string =>
    v === undefined ? "" : ` (${v >= 0 ? "+" : ""}${v.toFixed(1)})`;
  return [
    "| Metric | This week | Δ vs prior |",
    "| --- | ---: | ---: |",
    `| Throughput | ${r.throughput} |${delta(d?.throughput)} |`,
    `| Success % | ${r.success_pct.toFixed(1)} |${delta(d?.success_pct)} |`,
    `| HITL % | ${r.hitl_pct.toFixed(1)} |${delta(d?.hitl_pct)} |`,
    `| Revert % | ${r.revert_pct.toFixed(1)} |${delta(d?.revert_pct)} |`,
    `| Infra-error % | ${r.infra_error_pct.toFixed(1)} |${delta(d?.infra_error_pct)} |`,
  ].join("\n");
};

const renderPromotionMarkdown = (p: Promotion): string => {
  const lines: string[] = [];
  // Theme-key marker — machine-readable, invisible in Linear UI.
  // VA-408: the next Weekly Review's queue-defer pass reads this to
  // skip themes that already have an open promoted issue.
  lines.push(`<!-- ${RUNWAY_META_THEME_KEY_MARKER}: ${p.theme_key} -->`);
  lines.push("");
  lines.push(`**Target taxonomy**: \`${p.target}\``);
  lines.push(`**Category**: \`${p.category}\``);
  lines.push(`**Source meta-reviews**: ${p.source_meta_review_identifiers.join(", ")}`);
  lines.push("");
  lines.push("## Change");
  lines.push("");
  lines.push(p.change_spec);
  lines.push("");
  lines.push("## Acceptance criteria");
  lines.push("");
  for (const ac of p.acceptance_criteria) {
    lines.push(`- [ ] ${ac}`);
  }
  lines.push("");
  lines.push("## Predicted effect");
  lines.push("");
  lines.push(`> **Claim**: ${p.predicted_effect.claim}`);
  lines.push(
    `> **Minimum sample size**: n ≥ ${p.predicted_effect.min_sample_size} ${p.predicted_effect.sample_description}`,
  );
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(
    `_Theme corroboration: ${p.corroboration_count} runway-meta reviews (confidence: ${p.recommendation_confidence}). The next Weekly Review will check this issue's state before re-promoting the same theme._`,
  );
  return lines.join("\n");
};

const shortWindowLabel = (args: WeeklyReviewPassArgs): string => {
  // ISO timestamps are noisy in a Linear title. Project to YYYY-MM-DD
  // boundaries — operators scanning the runway-meta project see week
  // boundaries at a glance.
  const startDay = args.startIso.slice(0, 10);
  const endDay = args.endIso.slice(0, 10);
  return `${startDay} → ${endDay}`;
};

// ---------------------------------------------------------------------------
// Test seam — exported for unit tests of the prompt assembly path
// ---------------------------------------------------------------------------

export const __testing = {
  SYSTEM_PROMPT,
  composeUserPrompt,
  extractRecommendationSources,
  parseRunReviewContentJson,
  renderPromotionMarkdown,
  renderWeeklyReviewMarkdown,
  shortWindowLabel,
};
