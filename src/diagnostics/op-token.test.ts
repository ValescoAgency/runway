import { beforeEach, describe, expect, it } from "vitest";
import { opTokenDiagnostic } from "./op-token.js";

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
  delete process.env.OP_SERVICE_ACCOUNT_TOKEN;
});

describe("opTokenDiagnostic", () => {
  it("is registered as a tier-2 Environment check", () => {
    expect(opTokenDiagnostic.name).toBe("op-token");
    expect(opTokenDiagnostic.section).toBe("Environment");
    expect(opTokenDiagnostic.tier).toBe("tier-2");
  });

  it("returns fail when OP_SERVICE_ACCOUNT_TOKEN is unset", async () => {
    const [res] = await opTokenDiagnostic.run(ctx);
    expect(res?.status).toBe("fail");
  });

  it("returns ok when OP_SERVICE_ACCOUNT_TOKEN is set", async () => {
    process.env.OP_SERVICE_ACCOUNT_TOKEN = "ops_secret";
    const [res] = await opTokenDiagnostic.run(ctx);
    expect(res?.status).toBe("ok");
  });
});
