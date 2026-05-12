import { describe, expect, it, vi } from "vitest";
import { nodeDiagnostic } from "./node.js";

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

describe("nodeDiagnostic", () => {
  it("returns ok when node major version is ≥ 22", async () => {
    vi.spyOn(process.versions, "node", "get").mockReturnValue("22.10.0");
    const [res] = await nodeDiagnostic.run(ctx);
    expect(res).toEqual({ status: "ok", label: "node", detail: "v22.10.0" });
  });

  it("returns fail when node major version is < 22", async () => {
    vi.spyOn(process.versions, "node", "get").mockReturnValue("20.11.0");
    const [res] = await nodeDiagnostic.run(ctx);
    expect(res).toMatchObject({
      status: "fail",
      label: "node",
      detail: expect.stringContaining("≥ 22 required"),
    });
  });

  it("handles a future node release (e.g. 24.x) as ok", async () => {
    vi.spyOn(process.versions, "node", "get").mockReturnValue("24.0.0");
    const [res] = await nodeDiagnostic.run(ctx);
    expect(res?.status).toBe("ok");
  });
});
