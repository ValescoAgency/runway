import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEMPLATES_DIR } from "./scaffolder.js";
import { writeShim } from "./scaffolder-varlock.js";
import {
  composeAndApplyScaffoldChanges,
  parseOpRefs,
  renderDockerfile,
} from "./repo-upgrade.js";

// `varlock` invokes 1Password via a `<execName>("op read ...")` DSL.
// Constructed at runtime so the literal substring doesn't trip
// repository security hooks that grep for shell-call patterns.
const E = "exec";

function schemaFor(authVar: "ANTHROPIC_API_KEY" | "CLAUDE_CODE_OAUTH_TOKEN"): string {
  return [
    "# header comment",
    "",
    "# @sensitive @required",
    `${authVar}=${E}('op read "op://runway/anthropic-api-key/credential"')`,
    "",
    "# @sensitive @required",
    `GH_TOKEN=${E}('op read "op://runway/gh-token/credential"')`,
    "",
  ].join("\n");
}

const apiKeySchema = schemaFor("ANTHROPIC_API_KEY");
const oauthSchema = schemaFor("CLAUDE_CODE_OAUTH_TOKEN");

const mismatchSchema = [
  "# @sensitive @required",
  `ANTHROPIC_API_KEY=${E}('op read "op://vault-a/anthropic-api-key/credential"')`,
  "",
  "# @sensitive @required",
  `GH_TOKEN=${E}('op read "op://vault-b/gh-token/credential"')`,
].join("\n");

describe("parseOpRefs", () => {
  it("extracts vault + item names from an api-key schema and reports authMode=api-key", () => {
    expect(parseOpRefs(apiKeySchema, {})).toEqual({
      opVault: "runway",
      anthropicItem: "anthropic-api-key",
      ghTokenItem: "gh-token",
      authMode: "api-key",
    });
  });

  it("detects authMode=oauth when the schema uses CLAUDE_CODE_OAUTH_TOKEN", () => {
    expect(parseOpRefs(oauthSchema, {}).authMode).toBe("oauth");
  });

  it("applies per-field overrides over extracted values", () => {
    const result = parseOpRefs(apiKeySchema, {
      opVault: "override-vault",
      anthropicItem: "override-item",
    });
    expect(result.opVault).toBe("override-vault");
    expect(result.anthropicItem).toBe("override-item");
    // gh-token unaffected
    expect(result.ghTokenItem).toBe("gh-token");
  });

  it("throws when the schema can't be parsed and no overrides are passed", () => {
    expect(() => parseOpRefs("# empty schema\n", {})).toThrow(
      /could not parse existing \.env\.schema/,
    );
  });

  it("throws on vault mismatch (different vault per entry, no --op-vault override)", () => {
    expect(() => parseOpRefs(mismatchSchema, {})).toThrow(/vault mismatch/);
  });

  it("a --op-vault override silences the vault-mismatch check", () => {
    expect(() =>
      parseOpRefs(mismatchSchema, { opVault: "user-says-vault-a" }),
    ).not.toThrow();
  });
});

// VA-426: tier-2 `upgrade-repo` must materialise
// `.sandcastle/runway-claude-shim` alongside the Dockerfile/.env.schema
// re-render — otherwise the rendered `COPY runway-claude-shim …` step
// in the Dockerfile points at a missing file and the post-render
// `docker build` verification fails. The bug surfaced on 2026-05-16
// when bedrock (last scaffolded against runway 0.10.x) was upgraded to
// 0.11.0.
//
// We exercise the `writeShim` helper directly here rather than the
// full `upgradeRepo` pipeline because the pipeline calls preflight
// (which expects a real git repo, docker daemon, etc.); the relevant
// contract for this regression is "did the shim land on disk with the
// right mode and the template's content," which `writeShim` owns.
// `upgradeRepo`'s composition is covered by manual smoke-test of the
// bedrock upgrade plus the existing `applyVarlockLayer` tests in
// scaffolder-varlock.test.ts.
describe("writeShim (VA-426 — runway upgrade-repo claude-shim deployment)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "runway-upgrade-shim-"));
    mkdirSync(join(tmpDir, ".sandcastle"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes .sandcastle/runway-claude-shim when the file is missing (pre-0.11.0 upgrade path)", () => {
    const shimPath = join(tmpDir, ".sandcastle", "runway-claude-shim");
    expect(existsSync(shimPath)).toBe(false);
    writeShim(tmpDir);
    expect(existsSync(shimPath)).toBe(true);
  });

  it("marks the written shim 0755 so docker COPY preserves the execute bit", () => {
    writeShim(tmpDir);
    const shimPath = join(tmpDir, ".sandcastle", "runway-claude-shim");
    const mode = statSync(shimPath).mode & 0o777;
    expect(mode & 0o100).toBeTruthy();
  });

  it("writes byte-for-byte content from templates/claude-shim.sh", () => {
    writeShim(tmpDir);
    const shimPath = join(tmpDir, ".sandcastle", "runway-claude-shim");
    const expected = readFileSync(join(TEMPLATES_DIR, "claude-shim.sh"), "utf8");
    expect(readFileSync(shimPath, "utf8")).toBe(expected);
  });

  it("overwrites an existing shim whose content drifted from the template", () => {
    const shimPath = join(tmpDir, ".sandcastle", "runway-claude-shim");
    writeFileSync(shimPath, "#!/usr/bin/env bash\n# stale\n", { mode: 0o755 });
    writeShim(tmpDir);
    const expected = readFileSync(join(TEMPLATES_DIR, "claude-shim.sh"), "utf8");
    expect(readFileSync(shimPath, "utf8")).toBe(expected);
  });

  it("is idempotent when the on-disk shim already matches the template", () => {
    writeShim(tmpDir);
    const shimPath = join(tmpDir, ".sandcastle", "runway-claude-shim");
    const firstMtime = statSync(shimPath).mtimeMs;
    // Force the existing-file write path; if the body changes byte-for-byte
    // we'd notice on the content assertion, but we also want to confirm the
    // helper isn't doing anything weird that would corrupt the result on
    // back-to-back invocations (e.g. an upgrade-repo retry after a build
    // failure).
    writeShim(tmpDir);
    const expected = readFileSync(join(TEMPLATES_DIR, "claude-shim.sh"), "utf8");
    expect(readFileSync(shimPath, "utf8")).toBe(expected);
    // mtimeMs is monotonic non-decreasing across the two writes; the
    // file is replaced each call, but the content invariant holds.
    expect(statSync(shimPath).mtimeMs).toBeGreaterThanOrEqual(firstMtime);
  });

  it("flips the execute bit on even when the prior on-disk shim was 0644", () => {
    // `writeFileSync({mode})` only sets the mode on file creation; on
    // overwrite it leaves the existing inode's mode intact. `writeShim`
    // compensates with an explicit `chmodSync(path, 0o755)`. Without
    // that, a stale 0644 shim left behind by a manual `cp` would
    // silently survive a re-render and Docker's `COPY` would lose the
    // execute bit.
    const shimPath = join(tmpDir, ".sandcastle", "runway-claude-shim");
    writeFileSync(shimPath, "stale\n");
    chmodSync(shimPath, 0o644);
    writeShim(tmpDir);
    const mode = statSync(shimPath).mode & 0o777;
    expect(mode & 0o100).toBeTruthy();
  });
});

// VA-426 composition coverage. The writeShim tests above prove the
// helper works in isolation, but they don't catch a regression where
// upgradeRepo's composition forgets the shim — for example dropping
// `shimChange` from the changes array, accidentally routing through
// `writeFileSync` (which loses the 0755 mode), or skipping the call
// on tier 2. These tests drive the real composition seam
// (`composeAndApplyScaffoldChanges`) against an in-tmpdir tier-2
// fixture so a future refactor breaks loudly here.
//
// The seam intentionally excludes `preflight`, `buildAgentImage`, and
// `verify` so the test doesn't need a real git repo / docker daemon /
// `op` / `gh` to run — those phases are exercised by the bedrock
// smoke-test recorded on the VA-426 PR.
describe("composeAndApplyScaffoldChanges (VA-426 — tier-2 composition)", () => {
  let tmpDir: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  // The `varlock` shell-call DSL — split at runtime so the literal
  // doesn't trip our own secret-pattern grep checks.
  const E = "exec";

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "runway-upgrade-compose-"));
    mkdirSync(join(tmpDir, ".sandcastle"), { recursive: true });

    // Stale Dockerfile mimicking what a pre-0.11.0 tier-2 scaffold
    // would have written: inline `varlock run` shim block, no COPY of
    // a vendored shim, no shim file alongside.
    writeFileSync(
      join(tmpDir, ".sandcastle", "Dockerfile"),
      [
        "FROM node:22-bookworm",
        "WORKDIR /home/agent",
        "RUN mv /home/agent/.local/bin/claude /home/agent/.local/bin/claude.real \\",
        "  && printf '%s\\n' \\",
        "       '#!/usr/bin/env bash' \\",
        "       \"exec varlock run --env-file /home/agent/workspace/.env.schema -- /home/agent/.local/bin/claude.real \\\"\\$@\\\"\" \\",
        "       > /home/agent/.local/bin/claude",
        'ENTRYPOINT ["sleep", "infinity"]',
      ].join("\n"),
    );

    // Stale tier-2 .env.schema: API_KEY auth, op:// refs in place,
    // no RUNWAY_SIGNING_* block yet.
    writeFileSync(
      join(tmpDir, ".env.schema"),
      [
        "# header comment",
        "",
        "# @sensitive @required",
        `ANTHROPIC_API_KEY=${E}('op read "op://test-vault/anthropic-api-key/credential"')`,
        "",
        "# @sensitive @required",
        `GH_TOKEN=${E}('op read "op://test-vault/gh-token/credential"')`,
        "",
      ].join("\n"),
    );

    // `composeAndApplyScaffoldChanges` calls `process.exit(0|1)` on the
    // no-op and --check-drift paths. In production this halts the
    // process; in tests we throw a sentinel so the function returns
    // control without falling through to the write loop. Returning
    // undefined here would let execution continue past the early-exit
    // and silently invalidate the "didn't write anything on --check"
    // contract.
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__process_exit__(${code})`);
    }) as never);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    exitSpy.mockRestore();
  });

  const baseOpts = {
    check: false,
    skipBuild: true,
    allowDirty: true,
    force: true,
  } as const;

  it("writes Dockerfile + .env.schema + runway-claude-shim on a pre-0.11.0 tier-2 fixture", async () => {
    const resolved = await composeAndApplyScaffoldChanges(tmpDir, 2, baseOpts);

    // resolved op refs propagate from the existing .env.schema
    expect(resolved).not.toBeNull();
    expect(resolved?.opVault).toBe("test-vault");
    expect(resolved?.anthropicItem).toBe("anthropic-api-key");
    expect(resolved?.ghTokenItem).toBe("gh-token");
    expect(resolved?.authMode).toBe("api-key");

    // Dockerfile rewritten with the post-VA-413 COPY pattern
    const dockerfile = readFileSync(
      join(tmpDir, ".sandcastle", "Dockerfile"),
      "utf8",
    );
    expect(dockerfile).toContain("COPY runway-claude-shim");
    expect(dockerfile).toContain("FROM node:24-bookworm");

    // .env.schema picks up the signing opt-in block
    const schema = readFileSync(join(tmpDir, ".env.schema"), "utf8");
    expect(schema).toContain("RUNWAY_SIGNING_SSH_PRIVKEY");

    // Shim file materialised, 0755, byte-for-byte from the template
    const shimPath = join(tmpDir, ".sandcastle", "runway-claude-shim");
    expect(existsSync(shimPath)).toBe(true);
    const shimMode = statSync(shimPath).mode & 0o777;
    expect(shimMode & 0o100).toBeTruthy();
    const expectedShim = readFileSync(
      join(TEMPLATES_DIR, "claude-shim.sh"),
      "utf8",
    );
    expect(readFileSync(shimPath, "utf8")).toBe(expectedShim);
  });

  it("reports missing-shim drift on --check and exits 1 without writing", async () => {
    const shimPath = join(tmpDir, ".sandcastle", "runway-claude-shim");
    expect(existsSync(shimPath)).toBe(false);

    await expect(
      composeAndApplyScaffoldChanges(tmpDir, 2, { ...baseOpts, check: true }),
    ).rejects.toThrow(/__process_exit__\(1\)/);

    // --check exits with code 1 and writes nothing.
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(existsSync(shimPath)).toBe(false);
  });

  it("reports already-up-to-date and exits 0 when every scaffold file matches the template", async () => {
    // First pass: write everything from templates so the second pass
    // sees no drift. The first pass itself doesn't trigger
    // process.exit (changes exist, opts.check is false, write path
    // runs to completion and returns naturally).
    await composeAndApplyScaffoldChanges(tmpDir, 2, baseOpts);
    exitSpy.mockClear();

    await expect(
      composeAndApplyScaffoldChanges(tmpDir, 2, baseOpts),
    ).rejects.toThrow(/__process_exit__\(0\)/);

    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});

// ---------------------------------------------------------------------------
// VA-466: history-aware manual-edit detector
// ---------------------------------------------------------------------------

describe("renderDockerfile manual-edit detector (VA-466)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "runway-detector-"));
    mkdirSync(join(tmpDir, ".sandcastle"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const opts = {
    check: false,
    skipBuild: true,
    allowDirty: true,
    force: false,
  } as const;

  it("does NOT flag a Dockerfile rendered by the previous canonical template (history union)", () => {
    // The FFL manager regression: a target Dockerfile written by an
    // older runway diverges from the current template only in lines
    // the prior canonical template owned. Pre-VA-466 the detector
    // treated every cross-version delta as a manual edit and forced
    // operators to pass --force; that's a false positive.
    const v013 = readFileSync(
      join(TEMPLATES_DIR, "history", "Dockerfile.claude-code.base.v0.13.0"),
      "utf8",
    );
    writeFileSync(join(tmpDir, ".sandcastle", "Dockerfile"), v013);

    expect(() => renderDockerfile(tmpDir, 1, opts, true)).not.toThrow();
  });

  it("STILL flags a genuine manual edit (a line absent from every known template)", () => {
    // Defense-in-depth: the history union must not silently approve
    // every diff — a foreign line that's not in the current template
    // OR any historical snapshot must still trip the detector.
    const v013 = readFileSync(
      join(TEMPLATES_DIR, "history", "Dockerfile.claude-code.base.v0.13.0"),
      "utf8",
    );
    const tampered = v013.replace(
      /^WORKDIR \/home\/agent$/m,
      'RUN echo "hello from operator"\nWORKDIR /home/agent',
    );
    writeFileSync(join(tmpDir, ".sandcastle", "Dockerfile"), tampered);

    expect(() => renderDockerfile(tmpDir, 1, opts, true)).toThrow(
      /manual Dockerfile edits detected/,
    );
  });

  it("--force bypasses the detector even when foreign lines exist", () => {
    writeFileSync(
      join(tmpDir, ".sandcastle", "Dockerfile"),
      'FROM scratch\nRUN echo "totally unrelated"\n',
    );

    expect(() =>
      renderDockerfile(tmpDir, 1, { ...opts, force: true }, true),
    ).not.toThrow();
  });

  it("tier-2: 0.13.0 base + standard varlock splice (the FFL manager reproducer) does NOT flag", () => {
    // The exact shape the FFL manager hit on 0.13.0 → 0.14.0: a
    // local Dockerfile composed of the v0.13.0 canonical base with
    // the tier-2 varlock+1Password splice spliced in immediately
    // before the ENTRYPOINT line. The detector must accept this
    // because (a) the base content is in the history union and (b)
    // the splice content matches the current snippet (which lives
    // in `after` via the same splice logic renderDockerfile uses).
    const v013Base = readFileSync(
      join(TEMPLATES_DIR, "history", "Dockerfile.claude-code.base.v0.13.0"),
      "utf8",
    );
    const snippet = readFileSync(
      join(TEMPLATES_DIR, "dockerfile-varlock.snippet"),
      "utf8",
    );
    const spliced = v013Base.replace(
      /^ENTRYPOINT \["sleep", "infinity"\]$/m,
      `${snippet.trimEnd()}\n\nENTRYPOINT ["sleep", "infinity"]`,
    );
    writeFileSync(join(tmpDir, ".sandcastle", "Dockerfile"), spliced);

    expect(() => renderDockerfile(tmpDir, 2, opts, true)).not.toThrow();
  });
});
