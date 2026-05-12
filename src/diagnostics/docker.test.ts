import { beforeEach, describe, expect, it, vi } from "vitest";

const execaMock = vi.fn();
vi.mock("execa", () => ({ execa: execaMock }));

const { dockerDiagnostic } = await import("./docker.js");

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

describe("dockerDiagnostic", () => {
  it("returns ok when both `docker --version` and `docker info` succeed", async () => {
    execaMock.mockResolvedValue({ stdout: "Docker version", stderr: "" });
    const [res] = await dockerDiagnostic.run(ctx);
    expect(res).toEqual({ status: "ok", label: "docker", detail: "daemon up" });
  });

  it("returns fail with `not on PATH` when --version throws", async () => {
    execaMock.mockRejectedValueOnce(new Error("spawn ENOENT"));
    const [res] = await dockerDiagnostic.run(ctx);
    expect(res).toMatchObject({
      status: "fail",
      label: "docker",
      detail: expect.stringContaining("not on PATH"),
    });
  });

  it("returns fail with `daemon not running` when --version succeeds but info fails", async () => {
    execaMock
      .mockResolvedValueOnce({ stdout: "Docker version", stderr: "" }) // --version
      .mockRejectedValueOnce(new Error("Cannot connect to the Docker daemon")); // info
    const [res] = await dockerDiagnostic.run(ctx);
    expect(res).toMatchObject({
      status: "fail",
      label: "docker",
      detail: expect.stringContaining("daemon not running"),
    });
  });
});
