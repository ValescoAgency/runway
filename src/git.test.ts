import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock execa BEFORE importing the module under test, so `detectBaseBranch`
// picks up the stub instead of shelling out to a real git binary.
const execaMock = vi.fn();
vi.mock("execa", () => ({ execa: execaMock }));

const { detectBaseBranch, hasCommits } = await import("./git.js");

// VA-358: detectBaseBranch is now an Effect. Tests run it via
// `Effect.runPromise` so the assertion shape (resolves / rejects)
// stays unchanged.
const run = (path: string): Promise<string> =>
  Effect.runPromise(detectBaseBranch(path));

beforeEach(() => {
  execaMock.mockReset();
});

describe("detectBaseBranch", () => {
  it("returns the symbolic-ref branch name (fast path) when it succeeds", async () => {
    execaMock.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "origin/main\n",
    });

    await expect(run("/tmp/repo")).resolves.toBe("main");
    expect(execaMock).toHaveBeenCalledTimes(1);
    expect(execaMock).toHaveBeenCalledWith(
      "git",
      ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      expect.objectContaining({ cwd: "/tmp/repo", reject: false }),
    );
  });

  it("strips the `origin/` prefix from a `master` default", async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: "origin/master" });
    await expect(run("/tmp/repo")).resolves.toBe("master");
  });

  it("falls back to `git remote show origin` when symbolic-ref fails", async () => {
    execaMock
      .mockResolvedValueOnce({ exitCode: 128, stdout: "" })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: [
          "* remote origin",
          "  Fetch URL: git@github.com:org/repo.git",
          "  HEAD branch: develop",
          "  Remote branches:",
        ].join("\n"),
      });

    await expect(run("/tmp/repo")).resolves.toBe("develop");
    expect(execaMock).toHaveBeenCalledTimes(2);
    expect(execaMock.mock.calls[1]?.[1]).toEqual(["remote", "show", "origin"]);
  });

  it("throws a helpful error when both paths fail", async () => {
    execaMock
      .mockResolvedValueOnce({ exitCode: 128, stdout: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "no head branch line" });

    await expect(run("/tmp/repo")).rejects.toThrow(
      /Could not detect the default branch.*RUNWAY_BASE_BRANCH/s,
    );
  });

  it("propagates failure if both calls throw", async () => {
    execaMock.mockRejectedValue(new Error("git not installed"));

    await expect(run("/tmp/repo")).rejects.toThrow(
      /Could not detect the default branch/,
    );
  });
});

describe("hasCommits (VA-358)", () => {
  // hasCommits runs `git rev-list --count base..branch` with
  // reject:false — so the cases of interest are: positive count,
  // zero count, non-numeric / empty stdout (missing branch), and
  // execa throwing entirely (git binary missing).
  const runHc = (base = "main", branch = "agent/va-1") =>
    Effect.runPromise(hasCommits("/tmp/repo", base, branch));

  it("returns true when the branch has commits ahead of base", async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: "3\n" });
    await expect(runHc()).resolves.toBe(true);
    expect(execaMock).toHaveBeenCalledWith(
      "git",
      ["rev-list", "--count", "main..agent/va-1"],
      expect.objectContaining({ cwd: "/tmp/repo", reject: false }),
    );
  });

  it("returns false when the branch is at base (zero commits)", async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: "0\n" });
    await expect(runHc()).resolves.toBe(false);
  });

  it("returns false when rev-list exits non-zero with empty stdout (missing branch)", async () => {
    // With reject:false, a missing branch comes back as a non-zero
    // exitCode and empty stdout — NaN > 0 → false. Callers can route
    // to revert without an Effect failure.
    execaMock.mockResolvedValueOnce({ exitCode: 128, stdout: "" });
    await expect(runHc()).resolves.toBe(false);
  });

  it("fails the Effect when execa itself throws (e.g., git binary missing)", async () => {
    execaMock.mockRejectedValueOnce(new Error("git not installed"));
    await expect(runHc()).rejects.toThrow(/git not installed/);
  });
});
