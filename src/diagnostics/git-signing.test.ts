import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitSigningDiagnostic } from "./git-signing.js";
import type { DoctorContext, RepoState } from "./index.js";

// VA-413: the git-signing diagnostic reads .env.schema from
// ctx.cwd and reports whether the four RUNWAY_SIGNING_* refs are
// declared. The host-side `gpg.ssh.allowedSignersFile` check is a
// soft probe; we mostly verify the schema-driven branches here and
// trust the execa probe for the host check.

function makeCtx(cwd: string, repo?: Partial<RepoState>): DoctorContext {
  return {
    cwd,
    tier: 2,
    repo: {
      tier: 2,
      hasDockerfile: true,
      hasSchema: true,
      authMode: "api-key",
      hasConflictingAuthVars: false,
      ...repo,
    },
    options: { detailed: false, json: false },
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "runway-git-signing-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("gitSigningDiagnostic (VA-413)", () => {
  it("returns skip when no .env.schema is present", async () => {
    const results = await gitSigningDiagnostic.run(makeCtx(tmpDir));
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      status: "skip",
      detail: expect.stringContaining("no .env.schema"),
    });
  });

  it("returns warn when .env.schema declares no signing refs (signing off)", async () => {
    writeFileSync(
      join(tmpDir, ".env.schema"),
      [
        "# @sensitive @required",
        'ANTHROPIC_API_KEY=exec(\'op read "op://vault/anthropic/credential"\')',
      ].join("\n"),
    );
    const results = await gitSigningDiagnostic.run(makeCtx(tmpDir));
    expect(results[0]).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("0003-agent-commit-signing"),
    });
  });

  it("returns fail when only some of the four signing refs are declared", async () => {
    writeFileSync(
      join(tmpDir, ".env.schema"),
      [
        'RUNWAY_SIGNING_SSH_PRIVKEY=exec(\'op read "op://vault/runway-signing-ssh/private"\')',
        'RUNWAY_SIGNING_NAME=exec(\'op read "op://vault/runway-signing-ssh/name"\')',
      ].join("\n"),
    );
    const results = await gitSigningDiagnostic.run(makeCtx(tmpDir));
    expect(results[0]).toMatchObject({
      status: "fail",
      detail: expect.stringMatching(/missing: .*RUNWAY_SIGNING_SSH_PUBKEY/),
    });
  });

  it("ignores commented-out signing refs (the schema's docs block)", async () => {
    writeFileSync(
      join(tmpDir, ".env.schema"),
      [
        "# Uncomment to enable signing:",
        '# RUNWAY_SIGNING_SSH_PRIVKEY=exec(\'op read "op://vault/x/private"\')',
        '# RUNWAY_SIGNING_SSH_PUBKEY=exec(\'op read "op://vault/x/public"\')',
        '# RUNWAY_SIGNING_NAME=exec(\'op read "op://vault/x/name"\')',
        '# RUNWAY_SIGNING_EMAIL=exec(\'op read "op://vault/x/email"\')',
      ].join("\n"),
    );
    const results = await gitSigningDiagnostic.run(makeCtx(tmpDir));
    // Treated as "signing off" — comment lines don't count.
    expect(results[0]).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("see docs/adr"),
    });
  });

  it("returns ok when all four signing refs are declared", async () => {
    writeFileSync(
      join(tmpDir, ".env.schema"),
      [
        'RUNWAY_SIGNING_SSH_PRIVKEY=exec(\'op read "op://vault/x/private"\')',
        'RUNWAY_SIGNING_SSH_PUBKEY=exec(\'op read "op://vault/x/public"\')',
        'RUNWAY_SIGNING_NAME=exec(\'op read "op://vault/x/name"\')',
        'RUNWAY_SIGNING_EMAIL=exec(\'op read "op://vault/x/email"\')',
      ].join("\n"),
    );
    const results = await gitSigningDiagnostic.run(makeCtx(tmpDir));
    expect(results[0]).toMatchObject({
      status: "ok",
      label: "agent commit signing",
    });
    // Second result is the soft allowedSignersFile probe; it's
    // either "ok" (host has it set) or "warn" (unset). We don't
    // pin which one — the host running CI may have neither.
    expect(results).toHaveLength(2);
    expect(["ok", "warn"]).toContain(results[1]?.status);
  });

  it("is registered as a tier-2 environment diagnostic", () => {
    expect(gitSigningDiagnostic.name).toBe("git-signing");
    expect(gitSigningDiagnostic.section).toBe("Environment");
    expect(gitSigningDiagnostic.tier).toBe("tier-2");
  });
});
