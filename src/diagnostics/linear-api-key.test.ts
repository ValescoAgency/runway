import { beforeEach, describe, expect, it } from "vitest";
import { linearApiKeyDiagnostic } from "./linear-api-key.js";

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
  delete process.env.LINEAR_API_KEY;
});

describe("linearApiKeyDiagnostic", () => {
  it("is registered as an Environment / both-tier check", () => {
    expect(linearApiKeyDiagnostic.name).toBe("linear-api-key");
    expect(linearApiKeyDiagnostic.section).toBe("Environment");
    expect(linearApiKeyDiagnostic.tier).toBe("both");
  });

  it("returns fail when LINEAR_API_KEY is unset", async () => {
    const [res] = await linearApiKeyDiagnostic.run(ctx);
    expect(res?.status).toBe("fail");
  });

  it("returns ok when LINEAR_API_KEY is set", async () => {
    process.env.LINEAR_API_KEY = "lin_api_xxx";
    const [res] = await linearApiKeyDiagnostic.run(ctx);
    expect(res?.status).toBe("ok");
  });
});
