import { describe, expect, it } from "vitest";
import { expectedImageName } from "./scaffolder.js";

// `expectedImageName` is the one bit of logic in scaffolder.ts that
// isn't side-effecting — the rest is `await phase(...)` orchestration.
// The phase functions themselves are heavily fs/execa-bound; their
// behaviour is exercised by the existing end-to-end tests for the
// commands that wrap the scaffolder.

describe("expectedImageName (VA-365)", () => {
  it("sanitises a clean cwd basename into `sandcastle:<name>`", () => {
    expect(expectedImageName("/Users/x/runway")).toBe("sandcastle:runway");
  });

  it("strips trailing slashes before taking the basename", () => {
    expect(expectedImageName("/Users/x/runway/")).toBe("sandcastle:runway");
    expect(expectedImageName("/Users/x/runway///")).toBe("sandcastle:runway");
  });

  it("lower-cases the basename", () => {
    expect(expectedImageName("/Users/x/MyProject")).toBe("sandcastle:myproject");
  });

  it("replaces characters outside [a-z0-9_.-] with a dash", () => {
    expect(expectedImageName("/Users/x/my project")).toBe(
      "sandcastle:my-project",
    );
    expect(expectedImageName("/path/to/some@weird#name")).toBe(
      "sandcastle:some-weird-name",
    );
  });

  it("falls back to `local` when the basename sanitises to empty", () => {
    expect(expectedImageName("/")).toBe("sandcastle:local");
    expect(expectedImageName("///")).toBe("sandcastle:local");
  });
});
