import { describe, expect, it } from "vitest";
import { parseRunArgs } from "./run.js";

describe("parseRunArgs", () => {
  it("returns an empty options object for no args (drain the whole queue)", () => {
    expect(parseRunArgs([])).toEqual({});
  });

  it("parses --max with a separate value", () => {
    expect(parseRunArgs(["--max", "3"])).toEqual({ max: 3 });
  });

  it("parses -n as a short alias for --max", () => {
    expect(parseRunArgs(["-n", "5"])).toEqual({ max: 5 });
  });

  it("rejects a non-numeric --max value", () => {
    expect(() => parseRunArgs(["--max", "lots"])).toThrow(
      /--max must be a positive integer/,
    );
  });

  it("rejects a zero or negative --max value", () => {
    expect(() => parseRunArgs(["--max", "0"])).toThrow(
      /--max must be a positive integer/,
    );
  });

  it("rejects --max with no value", () => {
    expect(() => parseRunArgs(["--max"])).toThrow(/--max requires a number/);
  });

  it("parses --project=value (inline form)", () => {
    expect(parseRunArgs(["--project=bedrock"])).toEqual({ project: "bedrock" });
  });

  it("parses --project value (separate form)", () => {
    expect(parseRunArgs(["--project", "bedrock"])).toEqual({
      project: "bedrock",
    });
  });

  it("rejects --project with no value", () => {
    expect(() => parseRunArgs(["--project"])).toThrow(
      /--project requires a value/,
    );
  });

  it("combines --max and --project", () => {
    expect(parseRunArgs(["--max", "2", "--project=bedrock"])).toEqual({
      max: 2,
      project: "bedrock",
    });
  });

  it("rejects unknown arguments", () => {
    expect(() => parseRunArgs(["--lol"])).toThrow(/unknown argument: --lol/);
  });

  describe("--allow-paths (VA-352)", () => {
    it("parses a single inline glob", () => {
      expect(parseRunArgs(["--allow-paths=.github/workflows/**"])).toEqual({
        allowPaths: [".github/workflows/**"],
      });
    });

    it("parses a comma-separated list and trims whitespace", () => {
      expect(
        parseRunArgs(["--allow-paths", ".github/workflows/**, foo/bar"]),
      ).toEqual({ allowPaths: [".github/workflows/**", "foo/bar"] });
    });

    it("merges repeated flags", () => {
      expect(
        parseRunArgs([
          "--allow-paths=a",
          "--allow-paths=b,c",
        ]),
      ).toEqual({ allowPaths: ["a", "b", "c"] });
    });

    it("rejects an empty value", () => {
      expect(() => parseRunArgs(["--allow-paths="])).toThrow(
        /--allow-paths requires at least one glob/,
      );
    });
  });

  describe("--impl-turns", () => {
    it("parses --impl-turns with a separate value", () => {
      expect(parseRunArgs(["--impl-turns", "5"])).toEqual({ implTurns: 5 });
    });

    it("parses --impl-turns=value (inline form)", () => {
      expect(parseRunArgs(["--impl-turns=7"])).toEqual({ implTurns: 7 });
    });

    it("rejects a non-numeric value", () => {
      expect(() => parseRunArgs(["--impl-turns", "lots"])).toThrow(
        /--impl-turns must be a positive integer/,
      );
    });

    it("rejects a zero or negative value", () => {
      expect(() => parseRunArgs(["--impl-turns", "0"])).toThrow(
        /--impl-turns must be a positive integer/,
      );
    });

    it("rejects --impl-turns with no value", () => {
      expect(() => parseRunArgs(["--impl-turns"])).toThrow(
        /--impl-turns requires a number/,
      );
    });
  });

  describe("--review-retries (VA-418)", () => {
    it("parses --review-retries with a separate value", () => {
      expect(parseRunArgs(["--review-retries", "2"])).toEqual({
        reviewRetries: 2,
      });
    });

    it("parses --review-retries=value (inline form)", () => {
      expect(parseRunArgs(["--review-retries=3"])).toEqual({ reviewRetries: 3 });
    });

    it("accepts --review-retries=0 (kill-switch)", () => {
      expect(parseRunArgs(["--review-retries=0"])).toEqual({ reviewRetries: 0 });
    });

    it("rejects a non-numeric value", () => {
      expect(() => parseRunArgs(["--review-retries", "lots"])).toThrow(
        /--review-retries must be a non-negative integer/,
      );
    });

    it("rejects a negative value", () => {
      expect(() => parseRunArgs(["--review-retries", "-1"])).toThrow(
        /--review-retries must be a non-negative integer/,
      );
    });

    it("rejects --review-retries with no value", () => {
      expect(() => parseRunArgs(["--review-retries"])).toThrow(
        /--review-retries requires a number/,
      );
    });
  });

  describe("--target (VA-480)", () => {
    it("parses --target VA-123", () => {
      expect(parseRunArgs(["--target", "VA-123"])).toEqual({ target: "VA-123" });
    });

    it("parses --target=VA-123 (inline form)", () => {
      expect(parseRunArgs(["--target=VA-456"])).toEqual({ target: "VA-456" });
    });

    it("rejects --target with no value", () => {
      expect(() => parseRunArgs(["--target"])).toThrow(
        /--target requires a Linear issue identifier/,
      );
    });

    it("rejects malformed identifier", () => {
      expect(() => parseRunArgs(["--target", "not-a-real-id"])).toThrow(
        /must be a Linear issue identifier/,
      );
      expect(() => parseRunArgs(["--target=lowercase-7"])).toThrow(
        /must be a Linear issue identifier/,
      );
    });

    it("combines with --max", () => {
      expect(parseRunArgs(["--max", "1", "--target", "VA-200"])).toEqual({
        max: 1,
        target: "VA-200",
      });
    });
  });
});
