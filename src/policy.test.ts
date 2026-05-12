import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_FORBIDDEN_PATHS, loadPolicy } from "./policy.js";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "runway-policy-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function writePolicy(yaml: string): void {
  mkdirSync(join(cwd, ".runway"), { recursive: true });
  writeFileSync(join(cwd, ".runway", "policy.yml"), yaml);
}

describe("loadPolicy (VA-352)", () => {
  it("returns the conservative defaults when no policy file exists", () => {
    const p = loadPolicy(cwd);
    expect(p.forbiddenPaths).toEqual([...DEFAULT_FORBIDDEN_PATHS]);
    expect(p.source).toBe("defaults");
  });

  it("replaces the defaults with `forbiddenPaths` from the file", () => {
    writePolicy("forbiddenPaths:\n  - secret.txt\n");
    const p = loadPolicy(cwd);
    expect(p.forbiddenPaths).toEqual(["secret.txt"]);
    expect(p.source).toBe(".runway/policy.yml");
  });

  it("strips `allowedPaths` from the defaults so they can be written", () => {
    writePolicy("allowedPaths:\n  - .github/workflows/**\n");
    const p = loadPolicy(cwd);
    expect(p.forbiddenPaths).not.toContain(".github/workflows/**");
    // Defaults minus the allowed entry.
    expect(p.forbiddenPaths).toContain(".env*");
  });

  it("applies `--allow-paths` overrides on top of the file policy", () => {
    writePolicy("forbiddenPaths:\n  - a\n  - b\n  - c\n");
    const p = loadPolicy(cwd, { allowPathsOverride: ["b"] });
    expect([...p.forbiddenPaths].sort()).toEqual(["a", "c"]);
    expect(p.source).toBe(".runway/policy.yml + --allow-paths");
  });

  it("includes --allow-paths in the source even with no policy file", () => {
    const p = loadPolicy(cwd, {
      allowPathsOverride: [".github/workflows/**"],
    });
    expect(p.forbiddenPaths).not.toContain(".github/workflows/**");
    expect(p.source).toBe("defaults + --allow-paths");
  });

  it("rejects malformed policy files via the Zod schema", () => {
    writePolicy("forbiddenPaths: not-an-array\n");
    expect(() => loadPolicy(cwd)).toThrow();
  });
});

// VA-361: renderForbiddenPathsBullet moved into prompts.ts as a
// private helper. Its rendering is now covered by the contract tests
// in src/prompts.test.ts ("renders the policy's forbidden paths into
// the working-style bullet" / "emits the no-restriction sentence …").
