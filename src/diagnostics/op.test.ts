import { beforeEach, describe, expect, it, vi } from "vitest";

const execaMock = vi.fn();
vi.mock("execa", () => ({ execa: execaMock }));

const { opDiagnostic } = await import("./op.js");

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

describe("opDiagnostic", () => {
  it("is registered as a tier-2 host-tooling check", () => {
    expect(opDiagnostic.name).toBe("op");
    expect(opDiagnostic.section).toBe("Host tooling");
    expect(opDiagnostic.tier).toBe("tier-2");
  });

  it("probes `op --version` and surfaces the binary's output", async () => {
    execaMock.mockResolvedValueOnce({ stdout: "2.30.0", stderr: "" });
    const [res] = await opDiagnostic.run(ctx);
    expect(execaMock).toHaveBeenCalledWith(
      "op",
      ["--version"],
      expect.any(Object),
    );
    expect(res).toMatchObject({ status: "ok", label: "op" });
  });
});
