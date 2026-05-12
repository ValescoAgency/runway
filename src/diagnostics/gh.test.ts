import { beforeEach, describe, expect, it, vi } from "vitest";

const execaMock = vi.fn();
vi.mock("execa", () => ({ execa: execaMock }));

const { ghDiagnostic } = await import("./gh.js");

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

describe("ghDiagnostic", () => {
  it("returns ok with the first non-empty line of auth status as detail", async () => {
    execaMock
      .mockResolvedValueOnce({ stdout: "gh 2.40.0", stderr: "" }) // --version
      .mockResolvedValueOnce({
        stdout: "github.com\n  ✓ Logged in to github.com as alice",
        stderr: "",
      });
    const [res] = await ghDiagnostic.run(ctx);
    expect(res).toEqual({
      status: "ok",
      label: "gh",
      detail: "github.com",
    });
  });

  it("returns fail when gh is not on PATH", async () => {
    execaMock.mockRejectedValueOnce(new Error("spawn ENOENT"));
    const [res] = await ghDiagnostic.run(ctx);
    expect(res).toMatchObject({
      status: "fail",
      detail: "gh not on PATH",
    });
  });

  it("returns fail when auth status fails", async () => {
    execaMock
      .mockResolvedValueOnce({ stdout: "gh 2.40.0", stderr: "" }) // --version
      .mockRejectedValueOnce(new Error("You are not logged in")); // auth status
    const [res] = await ghDiagnostic.run(ctx);
    expect(res).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("not authenticated"),
    });
  });
});
