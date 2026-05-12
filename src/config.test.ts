import { Effect, Redacted } from "effect";
import { afterEach, describe, expect, it } from "vitest";

// VA-359: the file imports `Effect.Config` lazily — the constructor
// reads `process.env` only when the config Effect runs, so we can set
// vars in the test body and call `loadConfig()` directly.

const originalEnv = { ...process.env };

afterEach(() => {
  // Restore env to a clean slate between tests so each one is
  // self-contained.
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value !== undefined) process.env[key] = value;
  }
});

describe("VA-359 — Effect.Config + Redacted secrets", () => {
  it("loads a minimal valid config from env vars", async () => {
    process.env.LINEAR_API_KEY = "lin_api_secret_should_not_leak";
    delete process.env.OP_SERVICE_ACCOUNT_TOKEN;
    delete process.env.RUNWAY_LINEAR_TEAM;
    const { loadConfig } = await import("./config.js");
    const cfg = loadConfig();
    // Defaults applied.
    expect(cfg.linearTeam).toBe("VA");
    expect(cfg.readyStatus).toBe("Todo");
    expect(cfg.hitlLabel).toBe("ready-for-human");
    expect(cfg.maxIterations).toBe(5);
    // Optionals flatten Option → undefined.
    expect(cfg.opServiceAccountToken).toBeUndefined();
    expect(cfg.linearProject).toBeUndefined();
    expect(cfg.baseBranch).toBeUndefined();
  });

  it("LINEAR_API_KEY is Redacted — toString and JSON.stringify both yield <redacted>, not the raw value", async () => {
    process.env.LINEAR_API_KEY = "lin_api_secret_should_not_leak";
    const { loadConfig } = await import("./config.js");
    const cfg = loadConfig();
    // The whole point: the raw secret value never appears in any
    // string render of the config.
    expect(String(cfg.linearApiKey)).not.toContain(
      "lin_api_secret_should_not_leak",
    );
    expect(String(cfg.linearApiKey)).toMatch(/<redacted>/);
    expect(JSON.stringify(cfg)).not.toContain(
      "lin_api_secret_should_not_leak",
    );
    // But we can still extract the actual value at the boundary
    // where the Linear SDK actually needs it.
    expect(Redacted.value(cfg.linearApiKey)).toBe(
      "lin_api_secret_should_not_leak",
    );
  });

  it("OP_SERVICE_ACCOUNT_TOKEN is Redacted when present", async () => {
    process.env.LINEAR_API_KEY = "lin_test";
    process.env.OP_SERVICE_ACCOUNT_TOKEN = "op_secret_token_should_not_leak";
    const { loadConfig } = await import("./config.js");
    const cfg = loadConfig();
    expect(cfg.opServiceAccountToken).toBeDefined();
    expect(JSON.stringify(cfg)).not.toContain(
      "op_secret_token_should_not_leak",
    );
    expect(Redacted.value(cfg.opServiceAccountToken!)).toBe(
      "op_secret_token_should_not_leak",
    );
  });

  it("missing LINEAR_API_KEY surfaces a ConfigError-shaped failure", async () => {
    delete process.env.LINEAR_API_KEY;
    const { loadConfig } = await import("./config.js");
    expect(() => loadConfig()).toThrow(/LINEAR_API_KEY/);
  });

  it("RUNWAY_MAX_ITERATIONS=0 fails validation (must be positive)", async () => {
    process.env.LINEAR_API_KEY = "lin_test";
    process.env.RUNWAY_MAX_ITERATIONS = "0";
    const { loadConfig } = await import("./config.js");
    expect(() => loadConfig()).toThrow(/positive integer/);
  });

  it("RUNWAY_MAX_ITERATIONS=10 parses to the integer", async () => {
    process.env.LINEAR_API_KEY = "lin_test";
    process.env.RUNWAY_MAX_ITERATIONS = "10";
    const { loadConfig } = await import("./config.js");
    expect(loadConfig().maxIterations).toBe(10);
  });

  it("env-driven overrides for status names and HITL label apply", async () => {
    process.env.LINEAR_API_KEY = "lin_test";
    process.env.RUNWAY_LINEAR_TEAM = "FLIGHT";
    process.env.RUNWAY_READY_STATUS = "Backlog";
    process.env.RUNWAY_HITL_LABEL = "needs-review";
    const { loadConfig } = await import("./config.js");
    const cfg = loadConfig();
    expect(cfg.linearTeam).toBe("FLIGHT");
    expect(cfg.readyStatus).toBe("Backlog");
    expect(cfg.hitlLabel).toBe("needs-review");
  });

  it("ConfigLive Layer provides the resolved config via ConfigTag", async () => {
    process.env.LINEAR_API_KEY = "lin_layer_test";
    const { ConfigLive, ConfigTag } = await import("./config.js");
    const program = Effect.gen(function* () {
      const cfg = yield* ConfigTag;
      return cfg.linearTeam;
    }).pipe(Effect.provide(ConfigLive));
    const team = await Effect.runPromise(program);
    expect(team).toBe("VA");
  });
});
