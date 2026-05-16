import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Redacted } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunwayConfig } from "../config.js";
import { resolveMetaConfig } from "./runner.js";

// VA-402: the env → file → default precedence for the meta-review
// config knobs is the contract operators care about. Lock it.

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "runway-runner-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

const baseConfig = (over: Partial<RunwayConfig> = {}): RunwayConfig => ({
  linearApiKey: Redacted.make("k"),
  linearTeam: "VA",
  readyStatus: "Todo",
  inProgressStatus: "In Progress",
  inReviewStatus: "In Review",
  hitlLabel: "ready-for-human",
  maxIterations: 5,
  implTurns: 3,
  reviewRetries: 1,
  ...over,
});

const writeFile = (yaml: string): void => {
  mkdirSync(join(cwd, ".runway"), { recursive: true });
  writeFileSync(join(cwd, ".runway", "config.yml"), yaml);
};

describe("resolveMetaConfig (VA-402)", () => {
  it("falls back to the hardcoded default when nothing is set", () => {
    const r = resolveMetaConfig({ config: baseConfig(), cwd });
    expect(r.metaReviewModel).toBe("claude-sonnet-4-6");
    expect(r.metaProjectName).toBe("runway-meta");
    expect(r.source.model).toBe("default");
    expect(r.source.project).toBe("default");
  });

  it("reads .runway/config.yml when env is unset", () => {
    writeFile(
      [
        "metaReviewModel: claude-opus-4-7",
        "metaProjectName: ira-meta",
      ].join("\n"),
    );
    const r = resolveMetaConfig({ config: baseConfig(), cwd });
    expect(r.metaReviewModel).toBe("claude-opus-4-7");
    expect(r.metaProjectName).toBe("ira-meta");
    expect(r.source.model).toBe(".runway/config.yml");
    expect(r.source.project).toBe(".runway/config.yml");
  });

  it("env wins over .runway/config.yml when both are set", () => {
    writeFile("metaReviewModel: claude-opus-4-7");
    const r = resolveMetaConfig({
      config: baseConfig({ metaReviewModel: "claude-haiku-4-5" }),
      cwd,
    });
    expect(r.metaReviewModel).toBe("claude-haiku-4-5");
    expect(r.source.model).toBe("env");
  });

  it("env wins for metaProjectName too", () => {
    writeFile("metaProjectName: ira-meta-from-file");
    const r = resolveMetaConfig({
      config: baseConfig({ metaProjectName: "ira-meta-from-env" }),
      cwd,
    });
    expect(r.metaProjectName).toBe("ira-meta-from-env");
    expect(r.source.project).toBe("env");
  });

  it("mixes env (model) + file (project) + default", () => {
    writeFile("metaProjectName: ira-meta-from-file");
    const r = resolveMetaConfig({
      config: baseConfig({ metaReviewModel: "claude-haiku-4-5" }),
      cwd,
    });
    expect(r.metaReviewModel).toBe("claude-haiku-4-5");
    expect(r.source.model).toBe("env");
    expect(r.metaProjectName).toBe("ira-meta-from-file");
    expect(r.source.project).toBe(".runway/config.yml");
  });

  // VA-403: metaReviewDelayHours follows the same env → file →
  // default chain; default is 18h per PRD.

  it("defaults metaReviewDelayHours to 18 when nothing is set", () => {
    const r = resolveMetaConfig({ config: baseConfig(), cwd });
    expect(r.metaReviewDelayHours).toBe(18);
    expect(r.source.delayHours).toBe("default");
  });

  it("reads metaReviewDelayHours from .runway/config.yml when env is unset", () => {
    writeFile("metaReviewDelayHours: 24");
    const r = resolveMetaConfig({ config: baseConfig(), cwd });
    expect(r.metaReviewDelayHours).toBe(24);
    expect(r.source.delayHours).toBe(".runway/config.yml");
  });

  it("env wins for metaReviewDelayHours", () => {
    writeFile("metaReviewDelayHours: 24");
    const r = resolveMetaConfig({
      config: baseConfig({ metaReviewDelayHours: 6 }),
      cwd,
    });
    expect(r.metaReviewDelayHours).toBe(6);
    expect(r.source.delayHours).toBe("env");
  });

  it("accepts 0 as a valid metaReviewDelayHours (alias for --force always)", () => {
    const r = resolveMetaConfig({
      config: baseConfig({ metaReviewDelayHours: 0 }),
      cwd,
    });
    expect(r.metaReviewDelayHours).toBe(0);
    expect(r.source.delayHours).toBe("env");
  });
});
