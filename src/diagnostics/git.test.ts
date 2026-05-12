import { beforeEach, describe, expect, it, vi } from "vitest";

const execaMock = vi.fn();
vi.mock("execa", () => ({ execa: execaMock }));

const { gitDiagnostic } = await import("./git.js");

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

describe("gitDiagnostic", () => {
  it("is registered as both-tier host-tooling", () => {
    expect(gitDiagnostic.name).toBe("git");
    expect(gitDiagnostic.section).toBe("Host tooling");
    expect(gitDiagnostic.tier).toBe("both");
  });

  it("probes `git --version` and returns ok with the version string", async () => {
    execaMock.mockResolvedValueOnce({
      stdout: "git version 2.43.0",
      stderr: "",
    });
    const [res] = await gitDiagnostic.run(ctx);
    expect(execaMock).toHaveBeenCalledWith("git", ["--version"], expect.any(Object));
    expect(res).toEqual({
      status: "ok",
      label: "git",
      detail: "git version 2.43.0",
    });
  });
});
