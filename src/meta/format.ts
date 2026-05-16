import type { ReportParseError } from "./templates.js";
import type { AnthropicError } from "./llm.js";

/**
 * VA-406: shared rendering / formatting helpers used by both the
 * Run Review and Drain Review passes (and any future pass). Kept as
 * a thin "presentation" seam so the pass bodies stay focused on
 * orchestration; renaming a stub-failure header or changing the
 * trace-id elision lives in one place.
 */

/**
 * Shorten an OTLP trace id (32-hex-char) for human-readable headers.
 * Linear issue titles + log lines benefit from the first 8 chars —
 * still unique enough to disambiguate inside one drain's neighbourhood.
 */
export const shortenTrace = (traceId: string): string =>
  traceId.length > 8 ? traceId.slice(0, 8) : traceId;

/**
 * Current time in the SQLite `datetime('now')` shape
 * (`YYYY-MM-DD HH:MM:SS`). Mirrors what the storage layer's
 * `inserted_at` DEFAULT writes, so a manually-stamped `created_at`
 * sorts identically to the auto-stamped column.
 */
export const nowIso = (): string =>
  new Date().toISOString().replace("T", " ").slice(0, 19);

/**
 * Compact one-line render of an Anthropic SDK error from the
 * `AnthropicError` ADT — used in `meta-failed` row reasons and
 * Linear stub bodies so the operator sees the SDK tag + message
 * without the SDK's stack-trace noise.
 */
export const formatAnthropicError = (err: AnthropicError): string =>
  `${err._tag}: ${err.message}`;

/**
 * Compact one-line render of a `ReportParseError` from the templates
 * module. Version-mismatch errors get their own format (with expected
 * + observed) because that's the "silent shape drift" failure mode
 * the PRD guards against and operators want both numbers immediately.
 */
export const formatParseError = (err: ReportParseError): string => {
  if (err.kind === "version-mismatch") {
    return `version-mismatch (expected ${err.expectedMajor}.x.x, observed ${err.observed})`;
  }
  return `${err.kind}: ${err.message}`;
};

/**
 * Extract a string `.message` from a duck-typed error or fall back
 * to `String(err)`. Used at the Linear / dashboard-read failure
 * boundaries where the inbound value is `unknown` (Effect's tagged
 * error or a raw thrown value) but the operator-facing rendering
 * just wants a one-liner.
 */
export const messageOf = (err: unknown): string =>
  (err as { message?: unknown })?.message
    ? String((err as { message?: unknown }).message)
    : String(err);
