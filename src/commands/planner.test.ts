import { describe, expect, it, vi } from "vitest";
import { parsePlannerArgs } from "./planner.js";

describe("parsePlannerArgs", () => {
  it("parses `run` verb", () => {
    expect(parsePlannerArgs(["run"])).toEqual({ verb: "run" });
  });

  it("throws on missing verb", () => {
    expect(() => parsePlannerArgs([])).toThrow(/missing verb/);
  });

  it("throws on unknown verb", () => {
    expect(() => parsePlannerArgs(["start"])).toThrow(/unknown verb "start"/);
  });

  it("throws on unknown trailing arg", () => {
    expect(() => parsePlannerArgs(["run", "--foo"])).toThrow(
      /unknown argument/,
    );
  });

  it("exits 0 on --help", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("EXIT");
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(() => parsePlannerArgs(["--help"])).toThrow("EXIT");
      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(logSpy).toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});
