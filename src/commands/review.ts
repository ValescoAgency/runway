import { Effect, Redacted } from "effect";
import { loadConfig } from "../config.js";
import { dispatchRunReview } from "../meta/runner.js";

/**
 * VA-402: `runway review` subcommand family. Verbs:
 *
 *   - `runway review run --drain <id> --issue <id>` (this slice)
 *   - `runway review drain --id <drain>` (VA-406)
 *   - `runway review weekly` (VA-408)
 *
 * Each pass is a short-lived process — scheduler-agnostic. The CLI
 * here just parses argv, loads config, hands off to `meta/runner`,
 * and prints the outcome.
 *
 * Per PRD: Run Review failures stub-and-continue (exit 0). Weekly
 * Review (VA-408) will exit non-zero on retry exhaustion so cron
 * mail surfaces it loudly.
 */

export interface ReviewArgs {
  readonly verb: "run";
  readonly traceId: string;
  readonly issueIdentifier: string;
}

export function printReviewUsage(): void {
  console.log(`runway review — IRA retrospective passes

USAGE
  runway review run --drain <trace-id> --issue <identifier>

OPTIONS
  --drain <trace-id>     the drain's OTLP trace id (32 hex chars)
  --issue <identifier>   the Linear issue identifier (e.g. VA-401)

ENV
  ANTHROPIC_API_KEY      required — Claude API key for the IRA call
  RUNWAY_DASHBOARD_DB    dashboard SQLite path (default: ./runway-dashboard.db)
  RUNWAY_META_REVIEW_MODEL  override the Anthropic model (default: claude-sonnet-4-6)
  RUNWAY_META_PROJECT_NAME  override the Linear meta-project name (default: runway-meta)
`);
}

export async function reviewCommand(argv: readonly string[]): Promise<void> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    printReviewUsage();
    return;
  }
  const verb = argv[0];
  const rest = argv.slice(1);
  if (verb !== "run") {
    console.error(`[runway review] unknown verb: ${verb}`);
    printReviewUsage();
    process.exit(2);
  }

  const parsed = parseRunArgs(rest);
  if (parsed.kind === "error") {
    console.error(`[runway review run] ${parsed.message}`);
    printReviewUsage();
    process.exit(2);
  }

  const config = loadConfig();
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicApiKey) {
    console.error(
      "[runway review run] ANTHROPIC_API_KEY is required — set it in the environment before running.",
    );
    process.exit(2);
  }
  const dashboardDbPath =
    process.env.RUNWAY_DASHBOARD_DB ?? "./runway-dashboard.db";

  const outcome = await Effect.runPromise(
    dispatchRunReview(
      { traceId: parsed.traceId, issueIdentifier: parsed.issueIdentifier },
      {
        config,
        cwd: process.cwd(),
        dashboardDbPath,
        anthropicApiKey,
      },
    ),
  );

  if (outcome.kind === "review") {
    console.log(
      `[runway review run] ok — meta_review=${outcome.metaReviewId} linear=${outcome.linearIdentifier} (${outcome.linearUrl})`,
    );
  } else if (outcome.kind === "skipped") {
    // VA-404: heuristic pre-filter trip. No LLM, no Linear — just the
    // skipped row. Operator audit reads the reason off `meta_reviews`.
    console.log(
      `[runway review run] skipped — meta_review=${outcome.metaReviewId} reason: ${outcome.reason}`,
    );
  } else {
    console.log(
      `[runway review run] stub-and-continue — meta_review=${outcome.metaReviewId} reason: ${outcome.reason}`,
    );
  }
  // Run Review failures stub and continue per PRD — exit code stays 0
  // regardless of outcome.kind. Weekly Review (VA-408) will diverge.
}

type ParseResult =
  | { kind: "ok"; traceId: string; issueIdentifier: string }
  | { kind: "error"; message: string };

/**
 * Minimal argv parser — supports `--drain <id> --issue <id>` (with
 * `=` allowed in either form). Order independent.
 */
export function parseRunArgs(argv: readonly string[]): ParseResult {
  let traceId: string | undefined;
  let issueIdentifier: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    const split = consumeFlag(arg, argv, i);
    if (!split) continue;
    if (split.name === "--drain") {
      traceId = split.value;
      i = split.advance;
    } else if (split.name === "--issue") {
      issueIdentifier = split.value;
      i = split.advance;
    } else {
      return { kind: "error", message: `unknown flag: ${split.name}` };
    }
  }
  if (!traceId) {
    return { kind: "error", message: "missing required --drain <trace-id>" };
  }
  if (!issueIdentifier) {
    return { kind: "error", message: "missing required --issue <identifier>" };
  }
  return { kind: "ok", traceId, issueIdentifier };
}

interface ConsumedFlag {
  readonly name: string;
  readonly value: string;
  /** New index for the outer loop to skip the value token if it was a separate argv element. */
  readonly advance: number;
}

function consumeFlag(
  arg: string,
  argv: readonly string[],
  i: number,
): ConsumedFlag | null {
  if (!arg.startsWith("--")) return null;
  const eq = arg.indexOf("=");
  if (eq > 0) {
    return { name: arg.slice(0, eq), value: arg.slice(eq + 1), advance: i };
  }
  const next = argv[i + 1];
  if (next === undefined || next.startsWith("--")) {
    return { name: arg, value: "", advance: i };
  }
  return { name: arg, value: next, advance: i + 1 };
}
