import { beforeEach, describe, expect, it, vi } from "vitest";

const execaMock = vi.fn();
vi.mock("execa", () => ({ execa: execaMock }));

const { varlockDiagnostic } = await import("./varlock.js");

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

describe("varlockDiagnostic", () => {
  it("is registered as a tier-2 host-tooling check", () => {
    expect(varlockDiagnostic.name).toBe("varlock");
    expect(varlockDiagnostic.section).toBe("Host tooling");
    expect(varlockDiagnostic.tier).toBe("tier-2");
  });

  it("probes `varlock --version` and surfaces the binary's output", async () => {
    execaMock.mockResolvedValueOnce({ stdout: "varlock 0.5.1", stderr: "" });
    const [res] = await varlockDiagnostic.run(ctx);
    expect(execaMock).toHaveBeenCalledWith(
      "varlock",
      ["--version"],
      expect.any(Object),
    );
    expect(res).toMatchObject({ status: "ok", label: "varlock" });
  });
});
