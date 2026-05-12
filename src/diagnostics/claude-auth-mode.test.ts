import { describe, expect, it } from "vitest";
import type { DoctorContext, RepoState } from "./index.js";
import { claudeAuthModeDiagnostic } from "./claude-auth-mode.js";

function ctxWithRepo(repo: RepoState): DoctorContext {
  return {
    cwd: "/tmp/repo",
    tier: 2,
    repo,
    options: { detailed: false, json: false },
  };
}

describe("claudeAuthModeDiagnostic", () => {
  it("returns ok=oauth when the schema declares CLAUDE_CODE_OAUTH_TOKEN only", async () => {
    const [res] = await claudeAuthModeDiagnostic.run(
      ctxWithRepo({
        tier: 2,
        hasDockerfile: true,
        hasSchema: true,
        authMode: "oauth",
        hasConflictingAuthVars: false,
      }),
    );
    expect(res).toMatchObject({
      status: "ok",
      detail: expect.stringContaining("oauth"),
    });
  });

  it("returns ok=api-key when the schema declares ANTHROPIC_API_KEY only", async () => {
    const [res] = await claudeAuthModeDiagnostic.run(
      ctxWithRepo({
        tier: 2,
        hasDockerfile: true,
        hasSchema: true,
        authMode: "api-key",
        hasConflictingAuthVars: false,
      }),
    );
    expect(res).toMatchObject({
      status: "ok",
      detail: expect.stringContaining("api-key"),
    });
  });

  it("returns fail when both auth vars are declared", async () => {
    const [res] = await claudeAuthModeDiagnostic.run(
      ctxWithRepo({
        tier: 2,
        hasDockerfile: true,
        hasSchema: true,
        authMode: null,
        hasConflictingAuthVars: true,
      }),
    );
    expect(res).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("both"),
    });
  });

  it("returns fail when neither auth var is declared", async () => {
    const [res] = await claudeAuthModeDiagnostic.run(
      ctxWithRepo({
        tier: 2,
        hasDockerfile: true,
        hasSchema: true,
        authMode: null,
        hasConflictingAuthVars: false,
      }),
    );
    expect(res).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("neither"),
    });
  });
});
