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
  computeVerdict,
  parsePredictedEffectFromBody,
  parseSourceMetaReviewIdentifiers,
} from "../attribution.js";
import {
  categoryFromIssueIdentifier,
  type PostShipMetrics,
} from "../dashboard-read.js";
import type { ShippedPromotedQueueEntry } from "../linear-meta.js";
import {
  type AttributionMetric,
  type ObservedMetric,
  type PredictedEffect,
  type Promotion,
  type Recommendation,
  RUNWAY_META_PREDICTED_EFFECT_MARKER,
  RUNWAY_META_THEME_KEY_MARKER,
  type ShippedPromotion,
  type Verdict,
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
      /**
       * VA-409: number of shipped-promotion rows the attribution loop
       * graded into the *What we shipped* section. Equals the count
       * of `runway-meta-promoted` issues that completed since the
       * prior Weekly Review.
       */
      readonly shippedPromotionsGraded: number;
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

    // VA-409: attribution loop. For each shipped promotion in the
    // window, parse its predicted effect off the issue body and grade
    // it against post-ship metrics. The result is a structured array
    // the LLM echoes into `shipped_promotions` in its output — the
    // LLM authors the one-sentence comment but the verdict itself is
    // computed deterministically. Done sequentially: one
    // `loadPostShipMetrics` query per shipped issue, bounded by
    // category × cutoff. At most ~5 shipped per week so the latency
    // is dwarfed by the LLM call.
    const shippedComputed = yield* computeShippedPromotionVerdicts(
      ctx.shippedPromotions,
      deps.dashboardRead,
    );

    // 4) Call the LLM with the structured Weekly Review prompt.
    const llmResult = yield* callWeeklyReview({
      apiKey: deps.anthropicApiKey,
      model: deps.metaWeeklyModel,
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: composeUserPrompt(args, ctx, promoterOutput, shippedComputed),
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
    //    promotion that succeeded. Source URLs come from the Run
    //    Review content_json so the promoted body renders as markdown
    //    links instead of plain identifier strings.
    const sourceUrlMap = buildSourceUrlMap(ctx.runReviews);
    const filings = yield* fileEachPromotion(
      parsed.report.promotions,
      deps,
      sourceUrlMap,
    );

    // VA-409: reconcile the LLM's `shipped_promotions` array with the
    // mechanically-computed verdicts. The IRA authors the per-row
    // `comment` (one sentence) but the verdict / observed value /
    // sample size are deterministic — we overwrite those fields so a
    // hallucinated verdict can't mislead the operator. Shipped rows
    // the LLM missed get a fallback comment from `computeVerdict`.
    const finalReport = reconcileShippedPromotions(
      parsed.report,
      shippedComputed,
    );

    // 6) Weekly Review issue in runway-meta with provenance disclaimer
    //    + cross-links to the filed promotions.
    const weeklyIssueResult = yield* deps.metaLinear
      .createWeeklyReviewIssue({
        title: `Weekly Review: ${shortWindowLabel(args)}`,
        body: renderWeeklyReviewMarkdown(finalReport, args, filings),
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
        review: finalReport,
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
      promotionsPlanned: finalReport.promotions.length,
      shippedPromotionsGraded: finalReport.shipped_promotions.length,
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
  sourceUrlMap: ReadonlyMap<string, string>,
): Effect.Effect<readonly PromotionFiling[], never, never> =>
  Effect.gen(function* () {
    const results: PromotionFiling[] = [];
    // Sequential — Linear's API isn't rate-limited per call but
    // running 5 issue-creates in parallel risks tripping the global
    // workspace mutation rate. Sequential is safe and still finishes
    // in seconds for a 5-promotion batch.
    for (const promotion of promotions) {
      const labels = [promotion.category, "runway-meta-promoted"];
      const body = renderPromotionMarkdown(promotion, sourceUrlMap);
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
// VA-409: attribution loop — shipped promotion verdict computation
// ---------------------------------------------------------------------------

/**
 * Shape the pre-LLM attribution computation produces, one per shipped
 * `runway-meta-promoted` issue. Carries the parsed predicted effect
 * (or null when the issue body had no readable shape), the observed
 * post-ship metric value, the mechanical verdict, and a default
 * comment. The LLM may overwrite `comment` only; the other fields
 * are reconciled back from this struct after the LLM parse.
 */
interface ComputedShippedPromotion {
  readonly themeKey: string;
  readonly linearIdentifier: string;
  readonly linearUrl: string;
  readonly linearTitle: string;
  readonly category: string;
  readonly sourceMetaReviewIdentifiers: readonly string[];
  readonly predictedEffect: PredictedEffect | null;
  readonly observed: ObservedMetric;
  readonly verdict: Verdict;
  readonly defaultComment: string;
}

const computeShippedPromotionVerdicts = (
  shipped: readonly ShippedPromotedQueueEntry[],
  dashboardRead: MetaDashboardRead,
): Effect.Effect<readonly ComputedShippedPromotion[], never, never> =>
  Effect.gen(function* () {
    const results: ComputedShippedPromotion[] = [];
    for (const entry of shipped) {
      const predictedEffect = parsePredictedEffectFromBody(entry.body);
      const category = categoryFromIssueIdentifier(entry.identifier);
      const sourceIds = parseSourceMetaReviewIdentifiers(entry.body);

      if (predictedEffect === null) {
        // Pre-VA-409 issue with no readable predicted-effect surface,
        // or a hand-edited body. Render a QUALITATIVE row so the
        // operator sees the shipped issue and can audit it manually.
        results.push({
          themeKey: entry.themeKey ?? `unknown:${entry.identifier}`,
          linearIdentifier: entry.identifier,
          linearUrl: entry.url,
          linearTitle: entry.title,
          category,
          sourceMetaReviewIdentifiers: sourceIds,
          predictedEffect: null,
          observed: { metric: null, value: null, sample_size: 0 },
          verdict: "QUALITATIVE",
          defaultComment:
            "QUALITATIVE — operator review needed. No parseable predicted effect on the runway-repo issue body.",
        });
        continue;
      }

      // Query the post-ship metric. If the prediction has no
      // attribution block, `metricToRead` is null and the verdict
      // path immediately resolves to QUALITATIVE without touching
      // the dashboard.
      const metricToRead = predictedEffect.attribution?.metric ?? null;
      let observedValue: number | null = null;
      let sampleSize = 0;
      if (metricToRead !== null) {
        const metricsResult = yield* dashboardRead
          .loadPostShipMetrics(category, entry.completedAt)
          .pipe(Effect.either);
        if (metricsResult._tag === "Right" && metricsResult.right !== null) {
          observedValue = readMetric(metricsResult.right, metricToRead);
          sampleSize = metricsResult.right.sampleSize;
        }
        // Left → degraded read; observedValue / sampleSize stay
        // null/0 and the verdict falls to PENDING. Conservative: the
        // operator still sees the row, the loop re-grades next week.
      }

      const verdict = computeVerdict({
        predictedEffect,
        observedValue,
        observedSampleSize: sampleSize,
      });
      results.push({
        themeKey: entry.themeKey ?? `unknown:${entry.identifier}`,
        linearIdentifier: entry.identifier,
        linearUrl: entry.url,
        linearTitle: entry.title,
        category,
        sourceMetaReviewIdentifiers: sourceIds,
        predictedEffect,
        observed: {
          metric: metricToRead,
          value: verdict.observedValue,
          sample_size: sampleSize,
        },
        verdict: verdict.verdict,
        defaultComment: verdict.comment,
      });
    }
    return results;
  });

const readMetric = (
  metrics: PostShipMetrics,
  name: AttributionMetric,
): number | null => {
  switch (name) {
    case "median_iteration_count":
      return metrics.medianIterationCount;
    case "p95_iteration_count":
      return metrics.p95IterationCount;
    case "median_wall_time_ms":
      return metrics.medianWallTimeMs;
    case "p95_wall_time_ms":
      return metrics.p95WallTimeMs;
    case "reviewer_rejection_rate":
      return metrics.reviewerRejectionRate;
    case "revert_rate":
      return metrics.revertRate;
    case "hitl_escape_rate":
      return metrics.hitlEscapeRate;
    case "infra_error_rate":
      return metrics.infraErrorRate;
  }
};

/**
 * VA-409: reconcile the LLM-emitted `shipped_promotions` array with
 * the mechanically-computed verdicts. The IRA may author one
 * `comment` per row (a single sentence narrating the verdict); every
 * other field is overwritten from `shippedComputed` so a hallucinated
 * verdict doesn't reach the operator. Rows the LLM omitted are
 * appended with their default comment so all shipped issues land in
 * the *What we shipped* section.
 */
const reconcileShippedPromotions = (
  llmReport: WeeklyReview,
  shippedComputed: readonly ComputedShippedPromotion[],
): WeeklyReview => {
  const llmCommentByKey = new Map<string, string>();
  // Defensive against a parsed report whose schema parser didn't run
  // — `.default([])` ensures the field is always an array post-parse,
  // but tests sometimes hand in raw fixtures that bypass the schema.
  const fromLlm = llmReport.shipped_promotions ?? [];
  for (const row of fromLlm) {
    if (row.comment.length > 0) llmCommentByKey.set(row.theme_key, row.comment);
  }
  const reconciled: ShippedPromotion[] = shippedComputed.map((c) => ({
    theme_key: c.themeKey,
    linear_identifier: c.linearIdentifier,
    linear_url: c.linearUrl,
    linear_title: c.linearTitle,
    source_meta_review_identifiers: [...c.sourceMetaReviewIdentifiers],
    predicted_effect: c.predictedEffect ?? {
      claim: "(no readable predicted effect)",
      min_sample_size: 1,
      sample_description: "—",
    },
    observed: c.observed,
    verdict: c.verdict,
    comment: llmCommentByKey.get(c.themeKey) ?? c.defaultComment,
  }));
  return { ...llmReport, shipped_promotions: reconciled };
};

// ---------------------------------------------------------------------------
// Recommendation extraction from raw meta_reviews rows
// ---------------------------------------------------------------------------

/**
 * VA-408: parse each `meta-run-review` row's content_json into a
 * `RunReview` and walk its `recommendations` array. Returns one
 * `RecommendationSource` per recommendation, keyed by the Run
 * Review's Linear identifier (NOT the SQLite row id) so the
 * promoter's `source_meta_review_identifiers` output is rendered
 * as clickable links in the promoted runway-repo issue body.
 *
 * Rows that fail to parse (template_version drift, malformed JSON)
 * are silently skipped — the IRA's broader narrative still has the
 * row count as context, and the operator sees parse-failure stubs
 * through the `meta-failed` kind separately. Rows missing the
 * Linear identifier (very old writes pre-VA-402, defensive) fall
 * back to the SQLite row id so the chain doesn't break — they
 * just render as plain text in the promotion body.
 */
const extractRecommendationSources = (
  rows: readonly WindowedMetaRow[],
): readonly RecommendationSource[] => {
  const out: RecommendationSource[] = [];
  for (const row of rows) {
    if (row.kind !== "meta-run-review") continue;
    const parsed = parseRunReviewContentJson(row.contentJson);
    if (!parsed) continue;
    const sourceIdentifier = parsed.linearIssueIdentifier ?? row.id;
    for (const rec of parsed.recommendations) {
      out.push({
        sourceMetaReviewIdentifier: sourceIdentifier,
        recommendation: rec,
      });
    }
  }
  return out;
};

/**
 * VA-408: extract a lookup map from Linear identifier → URL by
 * walking every Run Review row's content_json. Used by
 * `renderPromotionMarkdown` to render `[VA-1001](url)` markdown
 * links in the *Source meta-reviews* line per the AC. Missing URLs
 * (defensive) just render as plain text.
 */
const buildSourceUrlMap = (
  rows: readonly WindowedMetaRow[],
): ReadonlyMap<string, string> => {
  const map = new Map<string, string>();
  for (const row of rows) {
    if (row.kind !== "meta-run-review") continue;
    const parsed = parseRunReviewContentJson(row.contentJson);
    if (!parsed) continue;
    if (parsed.linearIssueIdentifier && parsed.linearUrl) {
      map.set(parsed.linearIssueIdentifier, parsed.linearUrl);
    }
  }
  return map;
};

interface ParsedRunReviewContent {
  readonly recommendations: readonly Recommendation[];
  readonly linearIssueIdentifier: string | null;
  readonly linearUrl: string | null;
}

const parseRunReviewContentJson = (
  json: string,
): ParsedRunReviewContent | null => {
  try {
    // VA-408: the meta_reviews row's content_json wraps the parsed
    // review under a "review" key when the pass writes it. We pull
    // `recommendations` from `.review.recommendations` (or top-level
    // for hypothetical future writers) and the Linear cross-link
    // fields from `linear_issue_identifier` / `linear_url` at the
    // top level (where `run-review.ts` stamps them).
    const parsed = JSON.parse(json) as
      | {
          review?: { recommendations?: unknown };
          recommendations?: unknown;
          linear_issue_identifier?: unknown;
          linear_url?: unknown;
        }
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
    const linearIssueIdentifier =
      typeof parsed?.linear_issue_identifier === "string"
        ? parsed.linear_issue_identifier
        : null;
    const linearUrl =
      typeof parsed?.linear_url === "string" ? parsed.linear_url : null;
    return {
      recommendations: out,
      linearIssueIdentifier,
      linearUrl,
    };
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
  "Your job has four parts, in priority order:",
  "  1. Summarize the week. Throughput, success rate, HITL escape rate,",
  "     revert rate, infra-error rate. Compare against the prior week's",
  "     Weekly Review if one exists.",
  "  2. Grade the *What we shipped* section (attribution loop). The pass",
  "     pre-computed each shipped promotion's verdict deterministically",
  "     (HELD / PARTIAL / MISSED / PENDING / QUALITATIVE) by reading the",
  "     predicted effect off the runway-repo issue body and querying the",
  "     dashboard read-model for post-ship metrics. Your job is to echo",
  "     each shipped row VERBATIM (theme_key, linear_identifier,",
  "     linear_url, linear_title, source_meta_review_identifiers,",
  "     predicted_effect, observed, verdict) and author the one-sentence",
  "     `comment` — what the verdict means in plain language. Do NOT",
  "     change the verdict, observed value, or sample size.",
  "  3. Write the *Promotions to runway-repo* block. The promoter (a",
  "     deterministic algorithm running BEFORE you) has already filtered",
  "     and ranked the candidate themes — you receive a pre-computed",
  "     top-N list. Your job is to write the QUALITATIVE surfaces per",
  "     promotion: a shippable title, a runway-spec-quality change spec,",
  "     concrete acceptance criteria, and a FALSIFIABLE predicted effect",
  "     with an explicit minimum sample size (e.g. n=10 post-ship runs",
  "     of refactor-class issues). When the prediction can be tied to a",
  "     specific dashboard read-model metric, include the structured",
  "     `attribution` block so the next Weekly Review can grade it.",
  "  4. Write the *Noted but not promoted* block. The promoter has",
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
  "Schema (template_version 1.1.0):",
  "  {",
  '    "template_version": "1.1.0",',
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
  "           predicted_effect (optional attribution block inside) */ } ],",
  '    "noted_but_not_promoted": [',
  "      { /* echo theme_key, target, corroboration_count, reason,",
  "           deferred_behind verbatim; you author description */ } ],",
  '    "shipped_promotions": [',
  "      { /* echo every field from the attribution-loop pre-computed",
  "           row verbatim; YOU author the one-sentence `comment` */ } ]",
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
  "it to `noted_but_not_promoted` with `reason: low-confidence`. When the",
  "prediction CAN be tied to a measurable VA-399 metric, add an",
  "`attribution` block: { metric, baseline_value, direction, threshold_value }.",
  "  - metric: one of {median_iteration_count, p95_iteration_count,",
  "    median_wall_time_ms, p95_wall_time_ms, reviewer_rejection_rate,",
  "    revert_rate, hitl_escape_rate, infra_error_rate}.",
  "  - direction: 'decrease' or 'increase' — which way is improvement.",
  "  - baseline_value: current rolling-norms value (cite the norms",
  "    section when available).",
  "  - threshold_value: the post-ship value the prediction needs to",
  "    reach to count as HELD.",
  "The attribution block makes the next Weekly Review's *What we shipped*",
  "verdict mechanical; without it the verdict falls to QUALITATIVE and",
  "an operator has to read the post-ship narrative themselves.",
].join("\n");

const composeUserPrompt = (
  args: WeeklyReviewPassArgs,
  ctx: WeeklyReviewContext,
  promoter: PromoterOutput,
  shipped: readonly ComputedShippedPromotion[],
): string => {
  const lines: string[] = [];
  lines.push(`Window: ${args.startIso} → ${args.endIso}`);
  lines.push(
    `Counts: ${ctx.runReviews.length} run reviews, ${ctx.drainReviews.length} drain reviews, ${ctx.priorWeeklyReviews.length} prior weekly reviews, ${shipped.length} shipped promotions`,
  );
  if (ctx.degradedSources.outOfScope) {
    lines.push(`Degraded: ${ctx.degradedSources.outOfScope}`);
  }
  if (ctx.degradedSources.openPromotedQueue) {
    lines.push(`Degraded: ${ctx.degradedSources.openPromotedQueue}`);
  }
  if (ctx.degradedSources.shippedPromotions) {
    lines.push(`Degraded: ${ctx.degradedSources.shippedPromotions}`);
  }
  lines.push("");

  // VA-409: pre-graded shipped promotions. The IRA echoes these into
  // `shipped_promotions` and authors the per-row `comment` only — the
  // verdict / observed / sample_size fields are mechanically computed
  // and will be overwritten with the values below if the IRA tries to
  // change them.
  lines.push("# Attribution loop — shipped promotions to grade in the *What we shipped* section");
  lines.push("");
  if (shipped.length === 0) {
    lines.push(
      "(none — no runway-meta-promoted issues completed since the prior Weekly Review, OR no prior Weekly Review exists yet)",
    );
  } else {
    for (const s of shipped) {
      lines.push(renderShippedForPrompt(s));
    }
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

const renderShippedForPrompt = (s: ComputedShippedPromotion): string => {
  const pe = s.predictedEffect;
  const peSummary = pe
    ? pe.attribution
      ? `${pe.claim}  [metric=${pe.attribution.metric}, baseline=${pe.attribution.baseline_value}, ${pe.attribution.direction} to threshold=${pe.attribution.threshold_value}, n≥${pe.min_sample_size}]`
      : `${pe.claim}  [qualitative, n≥${pe.min_sample_size} ${pe.sample_description}]`
    : "(no parseable predicted effect on issue body)";
  return [
    `- theme_key: ${s.themeKey}`,
    `  linear_identifier: ${s.linearIdentifier}`,
    `  linear_url: ${s.linearUrl}`,
    `  linear_title: ${s.linearTitle}`,
    `  source_meta_review_identifiers: ${JSON.stringify(s.sourceMetaReviewIdentifiers)}`,
    `  predicted_effect: ${peSummary}`,
    `  observed: metric=${s.observed.metric ?? "null"}, value=${s.observed.value ?? "null"}, sample_size=${s.observed.sample_size}`,
    `  verdict: ${s.verdict}  (computed mechanically — echo verbatim; you author the one-sentence comment)`,
    `  default_comment: ${s.defaultComment}`,
  ].join("\n");
};

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
  // VA-409: *What we shipped* — attribution-loop verdicts for every
  // promoted runway-repo issue that completed since the prior weekly.
  // Empty section omitted entirely (first weekly / quiet week).
  if (review.shipped_promotions.length > 0) {
    lines.push("## What we shipped");
    lines.push("");
    for (const s of review.shipped_promotions) {
      lines.push(renderShippedPromotion(s));
      lines.push("");
    }
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

const renderShippedPromotion = (s: ShippedPromotion): string => {
  const lines: string[] = [];
  lines.push(`### ${s.linear_title} — [${s.linear_identifier}](${s.linear_url}) — \`${s.verdict}\``);
  lines.push("");
  if (s.source_meta_review_identifiers.length > 0) {
    lines.push(
      `**Source meta-reviews**: ${s.source_meta_review_identifiers.join(", ")}`,
    );
    lines.push("");
  }
  // Predicted line — claim + optional structured attribution.
  const pe = s.predicted_effect;
  lines.push(`**Predicted**: ${pe.claim}`);
  if (pe.attribution) {
    lines.push(
      `> ${pe.attribution.metric} ${pe.attribution.direction === "decrease" ? "≤" : "≥"} ${pe.attribution.threshold_value} (baseline ${pe.attribution.baseline_value}, n ≥ ${pe.min_sample_size} ${pe.sample_description})`,
    );
  } else {
    lines.push(`> n ≥ ${pe.min_sample_size} ${pe.sample_description}`);
  }
  lines.push("");
  // Observed line — null/null/0 when no metric to report.
  if (s.observed.value !== null && s.observed.metric !== null) {
    lines.push(
      `**Observed**: ${s.observed.metric} = ${s.observed.value} (n=${s.observed.sample_size} post-ship runs)`,
    );
  } else {
    lines.push(`**Observed**: — (n=${s.observed.sample_size})`);
  }
  lines.push("");
  lines.push(`**Verdict comment**: ${s.comment}`);
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

const renderPromotionMarkdown = (
  p: Promotion,
  sourceUrlMap: ReadonlyMap<string, string>,
): string => {
  const lines: string[] = [];
  // Theme-key marker — machine-readable, invisible in Linear UI.
  // VA-408: the next Weekly Review's queue-defer pass reads this to
  // skip themes that already have an open promoted issue.
  lines.push(`<!-- ${RUNWAY_META_THEME_KEY_MARKER}: ${p.theme_key} -->`);
  // VA-409: predicted-effect marker — the attribution loop reads this
  // back when grading shipped promotions. Carries the full structured
  // block (claim + min_sample_size + sample_description + optional
  // attribution). A v1.0.0-style promotion (no attribution) still
  // stamps the marker so the markdown-fallback path is the last
  // resort, not the first.
  lines.push(
    `<!-- ${RUNWAY_META_PREDICTED_EFFECT_MARKER}: ${JSON.stringify(p.predicted_effect)} -->`,
  );
  lines.push("");
  lines.push(`**Target taxonomy**: \`${p.target}\``);
  lines.push(`**Category**: \`${p.category}\``);
  // VA-408 AC: "source meta-issue links" — render each identifier as
  // a markdown link `[VA-1001](url)` when a URL is known. Identifiers
  // without a URL (defensive fallback for very old rows, or rows where
  // the Run Review pass's Linear write itself failed) render as
  // plain text so the chain doesn't break.
  const sourceLinks = p.source_meta_review_identifiers
    .map((id) => {
      const url = sourceUrlMap.get(id);
      return url ? `[${id}](${url})` : id;
    })
    .join(", ");
  lines.push(`**Source meta-reviews**: ${sourceLinks}`);
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
  buildSourceUrlMap,
  computeShippedPromotionVerdicts,
  extractRecommendationSources,
  parseRunReviewContentJson,
  readMetric,
  reconcileShippedPromotions,
  renderPromotionMarkdown,
  renderShippedPromotion,
  renderWeeklyReviewMarkdown,
  shortWindowLabel,
};
