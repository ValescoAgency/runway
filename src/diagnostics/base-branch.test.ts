import { beforeEach, describe, expect, it, vi } from "vitest";

const execaMock = vi.fn();
vi.mock("execa", () => ({ execa: execaMock }));

const { baseBranchDiagnostic } = await import("./base-branch.js");

const ctx = {
  cwd: "/tmp/repo",
  tier: 2 as const,
  repo: {
    tier: 2 as const,
    hasDockerfile: true,
    hasSchema: true,
    authMode: "api-key" as const,
    hasConflictingAuthVars: false,
  },
  options: { detailed: false, json: false },
};

beforeEach(() => {
  execaMock.mockReset();
  delete process.env.RUNWAY_BASE_BRANCH;
});

describe("baseBranchDiagnostic", () => {
  it("uses the RUNWAY_BASE_BRANCH override when set", async () => {
    process.env.RUNWAY_BASE_BRANCH = "develop";
    const [res] = await baseBranchDiagnostic.run(ctx);
    expect(res).toMatchObject({
      status: "ok",
      label: "base branch",
      detail: expect.stringContaining("develop (RUNWAY_BASE_BRANCH override)"),
    });
    expect(execaMock).not.toHaveBeenCalled();
  });

  it("auto-detects via detectBaseBranch when no override is set", async () => {
    // detectBaseBranch's symbolic-ref fast path
    execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: "origin/main\n" });
    const [res] = await baseBranchDiagnostic.run(ctx);
    expect(res).toMatchObject({
      status: "ok",
      label: "base branch",
      detail: expect.stringContaining("main (detected from origin/HEAD)"),
    });
  });

  it("returns fail when detection fails", async () => {
    execaMock.mockRejectedValue(new Error("git missing"));
    const [res] = await baseBranchDiagnostic.run(ctx);
    expect(res).toMatchObject({
      status: "fail",
      label: "base branch",
    });
  });
});
