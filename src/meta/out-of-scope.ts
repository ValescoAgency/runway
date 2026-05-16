import { Data, Effect } from "effect";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * VA-408: `.out-of-scope/` reader for the Weekly Review's promoter.
 *
 * Convention: operators drop one `.md` file per rejected theme into
 * `.out-of-scope/` (a directory next to `.runway/`). Each file's body
 * captures the rejection rationale — why a previously-promoted IRA
 * theme was kicked out at `/triage` time. The Weekly Review reads
 * these as a filter input: themes that match a prior rejection
 * rationale are filtered out before promoter ranking so the IRA
 * doesn't re-promote already-rejected ideas.
 *
 * Matching is intentionally fuzzy at v1 — the file BODY is treated as
 * a free-text rationale and we substring-match the promoter's theme
 * change-fragment against it. Operators concerned about false
 * positives can rewrite their `.out-of-scope/*.md` files to be more
 * narrowly worded; false negatives surface as re-promotion of a
 * previously-rejected idea, which the operator can re-reject in the
 * usual `/triage` flow.
 */

export class OutOfScopeReadError extends Data.TaggedError(
  "OutOfScopeReadError",
)<{ readonly path: string; readonly message: string }> {}

export interface OutOfScopeEntry {
  readonly filename: string;
  // Normalized body — lowercase, whitespace-collapsed. The matcher
  // compares against this rather than the raw file contents so an
  // operator's casing / line breaks don't affect the filter outcome.
  readonly normalizedBody: string;
}

/**
 * Read every `.md` file from `<cwd>/.out-of-scope/` and project to
 * `OutOfScopeEntry[]`. Returns an empty array when the directory
 * doesn't exist (a fresh workspace has no rejections yet). A read
 * failure on an individual file is a tagged error — the Weekly Review
 * pass surfaces it as a degraded read rather than crashing the run.
 */
export const loadOutOfScopeEntries = (
  cwd: string,
): Effect.Effect<readonly OutOfScopeEntry[], OutOfScopeReadError> =>
  Effect.try({
    try: () => {
      const dir = join(cwd, ".out-of-scope");
      if (!existsSync(dir)) return [];
      const stat = statSync(dir);
      if (!stat.isDirectory()) return [];
      const filenames = readdirSync(dir).filter((n) => n.endsWith(".md"));
      return filenames.map((filename) => {
        const body = readFileSync(join(dir, filename), "utf8");
        return {
          filename,
          normalizedBody: normalize(body),
        } satisfies OutOfScopeEntry;
      });
    },
    catch: (err) =>
      new OutOfScopeReadError({
        path: join(cwd, ".out-of-scope"),
        message: err instanceof Error ? err.message : String(err),
      }),
  });

/**
 * VA-408: lowercase, collapse whitespace, strip non-alphanumerics
 * (keep dashes + spaces). Used both for the `.out-of-scope/` bodies
 * and the promoter's theme fragments — substring matching needs the
 * same normalization on both sides.
 */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * VA-408: does the theme's normalized change-fragment overlap with
 * any of the rejection rationales? Returns the matching entry (so the
 * promoter can record "out of scope per <filename>") or null when no
 * match.
 *
 * Matching strategy: take the first MATCH_FRAGMENT_LEN chars of the
 * normalized theme fragment and check substring inclusion in either
 * direction (theme-in-rationale OR rationale-in-theme). The
 * bidirectional check keeps short-rationale files matchable against
 * long themes and vice versa.
 */
const MATCH_FRAGMENT_LEN = 40;

export function findMatchingOutOfScope(
  normalizedThemeFragment: string,
  entries: readonly OutOfScopeEntry[],
): OutOfScopeEntry | null {
  if (normalizedThemeFragment.length === 0) return null;
  const themeFragment = normalizedThemeFragment.slice(0, MATCH_FRAGMENT_LEN);
  if (themeFragment.length === 0) return null;
  for (const entry of entries) {
    if (entry.normalizedBody.length === 0) continue;
    if (entry.normalizedBody.includes(themeFragment)) return entry;
    // Reverse direction: a short rationale fragment included in a
    // longer theme text. We only check this when the rationale body
    // is shorter than the theme fragment we'd be searching for.
    const rationaleFragment = entry.normalizedBody.slice(
      0,
      MATCH_FRAGMENT_LEN,
    );
    if (
      rationaleFragment.length >= 10 &&
      normalizedThemeFragment.includes(rationaleFragment)
    ) {
      return entry;
    }
  }
  return null;
}
