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

  // VA-404: threshold resolution mirrors the model/project chain.
  it("falls back to default thresholds when nothing is set", () => {
    const r = resolveMetaConfig({ config: baseConfig(), cwd });
    expect(r.metaFilterThresholds.minIterationCount).toBe(3);
    expect(r.metaFilterThresholds.minReviewerRejections).toBe(2);
    expect(r.source.thresholds).toBe("default");
  });

  it("reads metaFilterThresholds from .runway/config.yml", () => {
    writeFile(
      [
        "metaFilterThresholds:",
        "  minIterationCount: 5",
        "  minReviewerRejections: 4",
      ].join("\n"),
    );
    const r = resolveMetaConfig({ config: baseConfig(), cwd });
    expect(r.metaFilterThresholds.minIterationCount).toBe(5);
    expect(r.metaFilterThresholds.minReviewerRejections).toBe(4);
    expect(r.source.thresholds).toBe(".runway/config.yml");
  });

  it("partial file thresholds fall through to defaults per-field", () => {
    writeFile(
      ["metaFilterThresholds:", "  minIterationCount: 7"].join("\n"),
    );
    const r = resolveMetaConfig({ config: baseConfig(), cwd });
    expect(r.metaFilterThresholds.minIterationCount).toBe(7);
    expect(r.metaFilterThresholds.minReviewerRejections).toBe(2);
  });

  it("env metaFilterThresholds wins over file", () => {
    writeFile(
      [
        "metaFilterThresholds:",
        "  minIterationCount: 5",
        "  minReviewerRejections: 4",
      ].join("\n"),
    );
    const r = resolveMetaConfig({
      config: baseConfig({
        metaFilterThresholds: { minIterationCount: 9 },
      }),
      cwd,
    });
    expect(r.metaFilterThresholds.minIterationCount).toBe(9);
    // Partial env override: minReviewerRejections falls through to
    // file value, NOT default.
    expect(r.metaFilterThresholds.minReviewerRejections).toBe(4);
    expect(r.source.thresholds).toBe("env");
  });
});
