import { beforeEach, describe, expect, it, vi } from "vitest";

const execaMock = vi.fn();
vi.mock("execa", () => ({ execa: execaMock }));

const { dockerImageDiagnostic } = await import("./docker-image.js");

const ctx = {
  cwd: "/tmp/my-project",
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
  // Default container probe: all env vars correctly baked in.
  execaMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
});

describe("dockerImageDiagnostic", () => {
  it("returns fail and short-circuits when `docker image inspect` fails", async () => {
    execaMock.mockReset();
    execaMock.mockRejectedValueOnce(new Error("No such image"));
    const results = await dockerImageDiagnostic.run(ctx);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("not built"),
    });
  });

  it("emits image-present + image-user (ok when user matches host) + container-ready", async () => {
    const hostUid = process.getuid?.() ?? 1000;
    const hostGid = process.getgid?.() ?? 1000;
    execaMock.mockReset();
    execaMock
      .mockResolvedValueOnce({ stdout: `${hostUid}:${hostGid}` }) // image inspect
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout:
          "HOME=/home/agent\nXDG_CACHE_HOME=/home/agent/.cache\nTURBO_CACHE_DIR=/tmp/turbo-cache\n",
      });
    const results = await dockerImageDiagnostic.run(ctx);
    expect(results.map((r) => r.status)).toEqual(["ok", "ok", "ok"]);
    expect(results[0]?.label).toContain("sandcastle-my-project");
  });

  it("warns when image User differs from host UID:GID", async () => {
    execaMock.mockReset();
    execaMock
      .mockResolvedValueOnce({ stdout: "9999:9999" }) // image inspect
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout:
          "HOME=/home/agent\nXDG_CACHE_HOME=/home/agent/.cache\nTURBO_CACHE_DIR=/tmp/turbo-cache\n",
      });
    const results = await dockerImageDiagnostic.run(ctx);
    expect(results[1]).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("AGENT_UID"),
    });
  });

  it("warns when the container probe is missing env vars", async () => {
    execaMock.mockReset();
    execaMock
      .mockResolvedValueOnce({ stdout: "" }) // image inspect (User unset / root)
      .mockResolvedValueOnce({ exitCode: 0, stdout: "" }); // probe: no env output
    const results = await dockerImageDiagnostic.run(ctx);
    expect(results[2]).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("HOME"),
    });
  });
});
