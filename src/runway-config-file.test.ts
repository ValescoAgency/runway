import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadRunwayConfigFile } from "./runway-config-file.js";

// VA-402: `.runway/config.yml` is the persistent operator-level
// config layer for the IRA's meta-review pass. These tests lock the
// happy-path read, the "file absent" empty-object return, and the
// loud-failure-on-malformed contract — the resolution chain that
// uses this (in `meta/runner.ts`) trusts the returned shape.

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "runway-config-file-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

const writeConfig = (yaml: string): void => {
  mkdirSync(join(cwd, ".runway"), { recursive: true });
  writeFileSync(join(cwd, ".runway", "config.yml"), yaml);
};

describe("loadRunwayConfigFile (VA-402)", () => {
  it("returns an empty object when .runway/config.yml is absent", () => {
    expect(loadRunwayConfigFile(cwd)).toEqual({});
  });

  it("parses metaReviewModel + metaProjectName fields", () => {
    writeConfig(
      [
        "metaReviewModel: claude-opus-4-7",
        "metaProjectName: my-ira-meta",
      ].join("\n"),
    );
    expect(loadRunwayConfigFile(cwd)).toEqual({
      metaReviewModel: "claude-opus-4-7",
      metaProjectName: "my-ira-meta",
    });
  });

  it("treats unrelated fields as forward-compatible (ignored, no throw)", () => {
    // The schema uses zod's default behaviour (passthrough not
    // enabled but unknown keys aren't rejected by default `z.object`).
    // Operators may carry forward fields the loader doesn't know
    // about (e.g. a future VA-405 norms knob); we don't punish them.
    writeConfig(
      [
        "metaReviewModel: claude-opus-4-7",
        "futureRollingNormsWindow: 90",
      ].join("\n"),
    );
    expect(loadRunwayConfigFile(cwd).metaReviewModel).toBe(
      "claude-opus-4-7",
    );
  });

  it("returns an empty object on an empty file (yaml null)", () => {
    writeConfig("");
    expect(loadRunwayConfigFile(cwd)).toEqual({});
  });

  it("throws on a malformed type (loud failure on operator intent we can't honour)", () => {
    writeConfig("metaReviewModel: 12345");
    expect(() => loadRunwayConfigFile(cwd)).toThrow();
  });

  // VA-403: metaReviewDelayHours — numeric, constrained to the
  // PRD's 12–24h band. The `--force` CLI flag is the supported
  // one-off bypass; persistent disable (e.g. `0`) isn't a mode.

  it("parses metaReviewDelayHours inside the 12-24h band", () => {
    writeConfig("metaReviewDelayHours: 24");
    expect(loadRunwayConfigFile(cwd).metaReviewDelayHours).toBe(24);
  });

  it("rejects metaReviewDelayHours below the band (loud failure)", () => {
    writeConfig("metaReviewDelayHours: 1");
    expect(() => loadRunwayConfigFile(cwd)).toThrow();
  });

  it("rejects metaReviewDelayHours of 0 (use --force CLI flag instead)", () => {
    writeConfig("metaReviewDelayHours: 0");
    expect(() => loadRunwayConfigFile(cwd)).toThrow();
  });

  it("rejects metaReviewDelayHours above the band (loud failure)", () => {
    writeConfig("metaReviewDelayHours: 999");
    expect(() => loadRunwayConfigFile(cwd)).toThrow();
  });

  it("rejects a negative metaReviewDelayHours", () => {
    writeConfig("metaReviewDelayHours: -1");
    expect(() => loadRunwayConfigFile(cwd)).toThrow();
  });
});
