import type { SectionResult, Status, Tier } from "./index.js";

// ---------------------------------------------------------------------------
// Render layer — converts the diagnostic registry's SectionResult[]
// into the text and JSON shapes `runway doctor` prints. Lives here
// (not in commands/doctor.ts) so future commands that want the same
// summary shape can reuse it — and to keep doctor.ts focused on
// argv parsing + context-building.
// ---------------------------------------------------------------------------

export function statusGlyph(s: Status): string {
  switch (s) {
    case "ok":
      return "✓";
    case "fail":
      return "✗";
    case "warn":
      return "⚠";
    case "skip":
      return "·";
  }
}

export function renderText(
  sections: readonly SectionResult[],
  tier: Tier | null,
  initialised: boolean,
  detailed: boolean,
): void {
  const tierLabel = tier === null ? "not initialized" : `tier ${tier}`;
  console.log(`runway doctor — ${tierLabel}`);
  console.log("");

  for (const section of sections) {
    console.log(`${section.title}`);
    if (!section.ran) {
      console.log("  · skipped (no runway scaffold detected)");
      console.log("");
      continue;
    }
    for (const check of section.checks.values()) {
      const glyph = statusGlyph(check.status);
      if (detailed && check.detail) {
        console.log(`  ${glyph} ${check.label} — ${check.detail}`);
      } else if (check.status !== "ok" && check.detail) {
        // Always surface non-OK detail even in terse mode.
        console.log(`  ${glyph} ${check.label} — ${check.detail}`);
      } else {
        console.log(`  ${glyph} ${check.label}`);
      }
    }
    console.log("");
  }

  if (!initialised) {
    console.log(
      "Hint: cwd has no runway scaffold. Run `runway init` from a target repo " +
        "to enable the full diagnostic.",
    );
  }
}

/**
 * `ok` is a caller-decided boolean — the renderer doesn't know which
 * sections are required for exit-code purposes (that's a doctor
 * concern). Callers pass it pre-computed.
 */
export function renderJson(
  sections: readonly SectionResult[],
  tier: Tier | null,
  ok: boolean,
): void {
  const sectionKey = (title: string): string =>
    title.toLowerCase().replace(/\s+/g, "_");

  const checksByName = (s: SectionResult): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, v] of s.checks.entries()) out[k] = v.status;
    return out;
  };

  const checks: Record<string, Record<string, string> | null> = {};
  for (const s of sections) {
    checks[sectionKey(s.title)] = s.ran ? checksByName(s) : null;
  }

  console.log(JSON.stringify({ ok, tier, checks }, null, 2));
}
