import { beforeEach, describe, expect, it, vi } from "vitest";

const execaMock = vi.fn();
vi.mock("execa", () => ({ execa: execaMock }));

const { gitStateDiagnostic } = await import("./git-state.js");

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
});

describe("gitStateDiagnostic", () => {
  it("returns 3 checks (git-repo ok, clean tree, branch) when in a clean git repo", async () => {
    execaMock
      .mockResolvedValueOnce({ stdout: "" }) // rev-parse --git-dir
      .mockResolvedValueOnce({ stdout: "" }) // status --porcelain (empty)
      .mockResolvedValueOnce({ stdout: "main\n" }); // rev-parse --abbrev-ref HEAD
    const results = await gitStateDiagnostic.run(ctx);
    expect(results.map((r) => r.label)).toEqual([
      "git repo",
      "working tree clean",
      "branch",
    ]);
    expect(results[0]?.status).toBe("ok");
    expect(results[1]?.status).toBe("ok");
    expect(results[2]).toMatchObject({ status: "ok", detail: "main" });
  });

  it("reports working tree dirty as warn with change count", async () => {
    execaMock
      .mockResolvedValueOnce({ stdout: "" }) // rev-parse --git-dir
      .mockResolvedValueOnce({ stdout: " M file1.ts\n M file2.ts\n" })
      .mockResolvedValueOnce({ stdout: "main\n" });
    const results = await gitStateDiagnostic.run(ctx);
    expect(results[1]).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("2 change(s)"),
    });
  });

  it("returns just `git repo: warn` and gates the other checks when not in a git repo", async () => {
    execaMock.mockRejectedValueOnce(new Error("not a git repo"));
    const results = await gitStateDiagnostic.run(ctx);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      status: "warn",
      label: "git repo",
    });
  });
});
