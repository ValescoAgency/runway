import { describe, expect, it } from "vitest";
import { runwayScaffoldDiagnostic } from "./runway-scaffold.js";
import type { DoctorContext, RepoState } from "./index.js";

function ctxWithRepo(repo: RepoState): DoctorContext {
  return {
    cwd: "/tmp/repo",
    tier: 2,
    repo,
    options: { detailed: false, json: false },
  };
}

describe("runwayScaffoldDiagnostic", () => {
  it("returns warn when repo.tier is null (no scaffold)", async () => {
    const [res] = await runwayScaffoldDiagnostic.run(
      ctxWithRepo({
        tier: null,
        hasDockerfile: false,
        hasSchema: false,
        authMode: null,
        hasConflictingAuthVars: false,
      }),
    );
    expect(res).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("runway init"),
    });
  });

  it("returns ok when a tier-1 scaffold is present", async () => {
    const [res] = await runwayScaffoldDiagnostic.run(
      ctxWithRepo({
        tier: 1,
        hasDockerfile: true,
        hasSchema: false,
        authMode: null,
        hasConflictingAuthVars: false,
      }),
    );
    expect(res).toMatchObject({
      status: "ok",
      detail: expect.stringContaining("tier 1"),
    });
  });

  it("returns ok when a tier-2 scaffold is present", async () => {
    const [res] = await runwayScaffoldDiagnostic.run(
      ctxWithRepo({
        tier: 2,
        hasDockerfile: true,
        hasSchema: true,
        authMode: "api-key",
        hasConflictingAuthVars: false,
      }),
    );
    expect(res?.detail).toContain("tier 2");
  });
});
