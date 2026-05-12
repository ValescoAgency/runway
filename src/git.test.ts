import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock execa BEFORE importing the module under test, so `detectBaseBranch`
// picks up the stub instead of shelling out to a real git binary.
const execaMock = vi.fn();
vi.mock("execa", () => ({ execa: execaMock }));

const { detectBaseBranch } = await import("./git.js");

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
