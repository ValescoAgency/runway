import {
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyVarlockLayer } from "./scaffolder-varlock.js";

// VA-413: the varlock layer writes the claude shim into
// `.sandcastle/runway-claude-shim` so the Dockerfile's
// `COPY .sandcastle/runway-claude-shim …` resolves at build time.
// These tests stage a minimal target-repo skeleton in a tmpdir and
// verify the shim landed, is executable, and contains the signing
// bootstrap.

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "runway-varlock-"));
  mkdirSync(join(tmpDir, ".sandcastle"), { recursive: true });
  // The varlock layer expects a Dockerfile with the canonical
  // ENTRYPOINT line to splice the snippet against.
  writeFileSync(
    join(tmpDir, ".sandcastle", "Dockerfile"),
    [
      "FROM node:24-bookworm",
      "WORKDIR /home/agent",
      'ENTRYPOINT ["sleep", "infinity"]',
    ].join("\n"),
  );
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("applyVarlockLayer — VA-413 claude shim deployment", () => {
  const opts = {
    tier: 2 as const,
    opVault: "runway",
    anthropicItem: "anthropic-api-key",
    ghTokenItem: "gh-token",
    authMode: "api-key" as const,
    allowDirty: false,
    force: false,
    skipBuild: true,
  };

  it("writes .sandcastle/runway-claude-shim during apply", async () => {
    await applyVarlockLayer(tmpDir, opts);
    const shimPath = join(tmpDir, ".sandcastle", "runway-claude-shim");
    expect(existsSync(shimPath)).toBe(true);
  });

  it("marks the shim 0755 so docker COPY preserves execute bit", async () => {
    await applyVarlockLayer(tmpDir, opts);
    const shimPath = join(tmpDir, ".sandcastle", "runway-claude-shim");
    const mode = statSync(shimPath).mode & 0o777;
    expect(mode & 0o100).toBeTruthy(); // owner-execute
  });

  it("includes the signing bootstrap block in the shim", async () => {
    await applyVarlockLayer(tmpDir, opts);
    const shimPath = join(tmpDir, ".sandcastle", "runway-claude-shim");
    const body = readFileSync(shimPath, "utf8");
    // The bootstrap checks all four signing env vars and configures
    // git globally when present. We don't assert on exact wording —
    // just that the recognisable parts are present.
    expect(body).toContain("RUNWAY_SIGNING_SSH_PRIVKEY");
    expect(body).toContain("RUNWAY_SIGNING_SSH_PUBKEY");
    expect(body).toContain("RUNWAY_SIGNING_NAME");
    expect(body).toContain("RUNWAY_SIGNING_EMAIL");
    expect(body).toContain("gpg.format ssh");
    expect(body).toContain("commit.gpgsign true");
  });

  it("unsets the signing env vars before exec'ing claude.real (no key leak into agent env)", async () => {
    await applyVarlockLayer(tmpDir, opts);
    const body = readFileSync(
      join(tmpDir, ".sandcastle", "runway-claude-shim"),
      "utf8",
    );
    // The shim must drop the signing vars from the env so claude.real
    // (and every subprocess the agent spawns) can't read the private
    // key from $RUNWAY_SIGNING_SSH_PRIVKEY. Git reads the key from the
    // on-disk file we wrote, not from env.
    const unsetIdx = body.indexOf("unset RUNWAY_SIGNING_SSH_PRIVKEY");
    const execIdx = body.indexOf("exec /home/agent/.local/bin/claude.real");
    expect(unsetIdx).toBeGreaterThan(0);
    expect(execIdx).toBeGreaterThan(0);
    // Unset must happen BEFORE the exec, otherwise the env still
    // inherits.
    expect(unsetIdx).toBeLessThan(execIdx);
    // All four signing vars must be in the unset list.
    expect(body).toMatch(
      /unset[^\n]*RUNWAY_SIGNING_SSH_PRIVKEY[^\n]*RUNWAY_SIGNING_SSH_PUBKEY[^\n]*RUNWAY_SIGNING_NAME[^\n]*RUNWAY_SIGNING_EMAIL/,
    );
  });

  it("invokes varlock around claude.real so secrets stay scoped", async () => {
    await applyVarlockLayer(tmpDir, opts);
    const body = readFileSync(
      join(tmpDir, ".sandcastle", "runway-claude-shim"),
      "utf8",
    );
    expect(body).toContain("varlock run --env-file");
    expect(body).toContain("claude.real");
  });

  it("patches the Dockerfile to COPY the shim into PATH (path relative to .sandcastle build context)", async () => {
    await applyVarlockLayer(tmpDir, opts);
    const dockerfile = readFileSync(
      join(tmpDir, ".sandcastle", "Dockerfile"),
      "utf8",
    );
    // `buildAgentImage` runs `docker build .sandcastle`, so COPY
    // sources are relative to .sandcastle/. A `COPY .sandcastle/…`
    // would resolve to `.sandcastle/.sandcastle/…` and fail. Pin the
    // assertion so we don't regress to the broken form.
    expect(dockerfile).toContain(
      "COPY runway-claude-shim /home/agent/.local/bin/claude",
    );
    expect(dockerfile).not.toContain("COPY .sandcastle/runway-claude-shim");
    expect(dockerfile).toContain(
      "mv /home/agent/.local/bin/claude /home/agent/.local/bin/claude.real",
    );
  });

  it("seeds .env.schema with commented-out RUNWAY_SIGNING_* opt-in block", async () => {
    await applyVarlockLayer(tmpDir, opts);
    const schema = readFileSync(join(tmpDir, ".env.schema"), "utf8");
    // The default scaffold leaves signing OFF — the four refs are
    // commented out with setup instructions inline.
    expect(schema).toContain("# RUNWAY_SIGNING_SSH_PRIVKEY=");
    expect(schema).toContain("# RUNWAY_SIGNING_SSH_PUBKEY=");
    expect(schema).toContain("# RUNWAY_SIGNING_NAME=");
    expect(schema).toContain("# RUNWAY_SIGNING_EMAIL=");
  });
});
