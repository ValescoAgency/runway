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
});
