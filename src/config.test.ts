import { Effect, Redacted } from "effect";
import { describe, expect, it } from "vitest";

// VA-411: every test passes an explicit env map to `loadConfig` /
// `makeConfigLive` so the host process.env (direnv-exported
// `RUNWAY_*` vars, etc.) can't leak in and break assertions. See
// VA-359 for the underlying Effect.Config + Redacted setup.
import { ConfigTag, loadConfig, makeConfigLive } from "./config.js";

describe("VA-359 — Effect.Config + Redacted secrets", () => {
  it("loads a minimal valid config from env vars", () => {
    const cfg = loadConfig({
      LINEAR_API_KEY: "lin_api_secret_should_not_leak",
    });
    // Defaults applied.
    expect(cfg.linearTeam).toBe("VA");
    // VA-423: queue is label-gated; `ready-for-agent` is the flightplan
    // v1.1.0 contract.
    expect(cfg.readyLabel).toBe("ready-for-agent");
    expect(cfg.hitlLabel).toBe("ready-for-human");
    expect(cfg.maxIterations).toBe(5);
    expect(cfg.implTurns).toBe(3);
    expect(cfg.reviewRetries).toBe(1);
    // Optionals flatten Option → undefined.
    expect(cfg.opServiceAccountToken).toBeUndefined();
    expect(cfg.linearProject).toBeUndefined();
    expect(cfg.baseBranch).toBeUndefined();
  });

  it("LINEAR_API_KEY is Redacted — toString and JSON.stringify both yield <redacted>, not the raw value", () => {
    const cfg = loadConfig({
      LINEAR_API_KEY: "lin_api_secret_should_not_leak",
    });
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

  it("OP_SERVICE_ACCOUNT_TOKEN is Redacted when present", () => {
    const cfg = loadConfig({
      LINEAR_API_KEY: "lin_test",
      OP_SERVICE_ACCOUNT_TOKEN: "op_secret_token_should_not_leak",
    });
    expect(cfg.opServiceAccountToken).toBeDefined();
    expect(JSON.stringify(cfg)).not.toContain(
      "op_secret_token_should_not_leak",
    );
    expect(Redacted.value(cfg.opServiceAccountToken!)).toBe(
      "op_secret_token_should_not_leak",
    );
  });

  it("missing LINEAR_API_KEY surfaces a ConfigError-shaped failure", () => {
    expect(() => loadConfig({})).toThrow(/LINEAR_API_KEY/);
  });

  it("RUNWAY_MAX_ITERATIONS=0 fails validation (must be positive)", () => {
    expect(() =>
      loadConfig({ LINEAR_API_KEY: "lin_test", RUNWAY_MAX_ITERATIONS: "0" }),
    ).toThrow(/positive integer/);
  });

  it("RUNWAY_MAX_ITERATIONS=10 parses to the integer", () => {
    const cfg = loadConfig({
      LINEAR_API_KEY: "lin_test",
      RUNWAY_MAX_ITERATIONS: "10",
    });
    expect(cfg.maxIterations).toBe(10);
  });

  it("RUNWAY_IMPL_TURNS=0 fails validation (must be positive)", () => {
    expect(() =>
      loadConfig({ LINEAR_API_KEY: "lin_test", RUNWAY_IMPL_TURNS: "0" }),
    ).toThrow(/positive integer/);
  });

  it("RUNWAY_IMPL_TURNS=5 parses to the integer", () => {
    const cfg = loadConfig({
      LINEAR_API_KEY: "lin_test",
      RUNWAY_IMPL_TURNS: "5",
    });
    expect(cfg.implTurns).toBe(5);
  });

  it("RUNWAY_REVIEW_RETRIES=0 parses (kill-switch — VA-418)", () => {
    // 0 is intentionally valid here: it disables the in-run
    // review-rejection retry loop entirely. Unlike implTurns and
    // maxIterations, which require >= 1.
    const cfg = loadConfig({
      LINEAR_API_KEY: "lin_test",
      RUNWAY_REVIEW_RETRIES: "0",
    });
    expect(cfg.reviewRetries).toBe(0);
  });

  it("RUNWAY_REVIEW_RETRIES=3 parses to the integer (VA-418)", () => {
    const cfg = loadConfig({
      LINEAR_API_KEY: "lin_test",
      RUNWAY_REVIEW_RETRIES: "3",
    });
    expect(cfg.reviewRetries).toBe(3);
  });

  it("RUNWAY_REVIEW_RETRIES=-1 fails validation (must be non-negative — VA-418)", () => {
    expect(() =>
      loadConfig({ LINEAR_API_KEY: "lin_test", RUNWAY_REVIEW_RETRIES: "-1" }),
    ).toThrow(/non-negative integer/);
  });

  it("env-driven overrides for ready label, team, and HITL label apply", () => {
    const cfg = loadConfig({
      LINEAR_API_KEY: "lin_test",
      RUNWAY_LINEAR_TEAM: "FLIGHT",
      RUNWAY_READY_LABEL: "agent-ready",
      RUNWAY_HITL_LABEL: "needs-review",
    });
    expect(cfg.linearTeam).toBe("FLIGHT");
    expect(cfg.readyLabel).toBe("agent-ready");
    expect(cfg.hitlLabel).toBe("needs-review");
  });

  it("VA-411 — host env leaks (e.g. RUNWAY_LINEAR_PROJECT exported by direnv) do not affect loadConfig when an explicit env is passed", () => {
    const cfg = loadConfig({ LINEAR_API_KEY: "lin_test" });
    // Even if the test process has `RUNWAY_LINEAR_PROJECT` set,
    // the optional must flatten to undefined because the explicit
    // env map doesn't include it.
    expect(cfg.linearProject).toBeUndefined();
    expect(cfg.baseBranch).toBeUndefined();
    expect(cfg.opServiceAccountToken).toBeUndefined();
  });

  it("VA-460: shepherdEnabled defaults to false and parses RUNWAY_SHEPHERD_ENABLED", () => {
    expect(loadConfig({ LINEAR_API_KEY: "lin_test" }).shepherdEnabled).toBe(
      false,
    );
    expect(
      loadConfig({ LINEAR_API_KEY: "lin_test", RUNWAY_SHEPHERD_ENABLED: "true" })
        .shepherdEnabled,
    ).toBe(true);
  });

  it("VA-460: shepherdPollIntervalSeconds defaults to 15 and parses positive integers", () => {
    expect(
      loadConfig({ LINEAR_API_KEY: "lin_test" }).shepherdPollIntervalSeconds,
    ).toBe(15);
    expect(
      loadConfig({
        LINEAR_API_KEY: "lin_test",
        RUNWAY_SHEPHERD_POLL_INTERVAL_SECONDS: "30",
      }).shepherdPollIntervalSeconds,
    ).toBe(30);
    expect(() =>
      loadConfig({
        LINEAR_API_KEY: "lin_test",
        RUNWAY_SHEPHERD_POLL_INTERVAL_SECONDS: "0",
      }),
    ).toThrow(/positive integer/);
  });

  it("ConfigLive Layer provides the resolved config via ConfigTag", async () => {
    const ConfigLayer = makeConfigLive({ LINEAR_API_KEY: "lin_layer_test" });
    const program = Effect.gen(function* () {
      const cfg = yield* ConfigTag;
      return cfg.linearTeam;
    }).pipe(Effect.provide(ConfigLayer));
    const team = await Effect.runPromise(program);
    expect(team).toBe("VA");
  });
});
