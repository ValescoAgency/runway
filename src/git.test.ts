import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock execa BEFORE importing the module under test, so `detectBaseBranch`
// picks up the stub instead of shelling out to a real git binary.
const execaMock = vi.fn();
vi.mock("execa", () => ({ execa: execaMock }));

const {
  detectBaseBranch,
  hasCommits,
  pruneStaleAgentBranch,
  rebaseOntoBase,
  remoteRefExists,
} = await import("./git.js");

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

describe("remoteRefExists (VA-421)", () => {
  const runRre = (branch = "agent/va-417") =>
    Effect.runPromise(remoteRefExists("/tmp/repo", branch));

  it("returns true when ls-remote prints a matching ref line", async () => {
    execaMock.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "abc123\trefs/heads/agent/va-417\n",
    });
    await expect(runRre()).resolves.toBe(true);
    expect(execaMock).toHaveBeenCalledWith(
      "git",
      ["ls-remote", "--heads", "origin", "agent/va-417"],
      expect.objectContaining({ cwd: "/tmp/repo" }),
    );
  });

  it("returns false when ls-remote prints nothing (no matching ref)", async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: "" });
    await expect(runRre()).resolves.toBe(false);
  });

  it("fails the Effect when execa rejects (network down, auth failure, no remote)", async () => {
    execaMock.mockRejectedValueOnce(new Error("could not resolve host"));
    await expect(runRre()).rejects.toThrow(/could not resolve host/);
  });
});

describe("pruneStaleAgentBranch (VA-366 + VA-417)", () => {
  const runPrune = (base = "main", branch = "agent/va-1") =>
    Effect.runPromise(pruneStaleAgentBranch("/tmp/repo", base, branch));

  it("is a no-op when the branch doesn't exist (rev-parse exits non-zero)", async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 128, stdout: "" }); // rev-parse --verify
    await runPrune();
    expect(execaMock).toHaveBeenCalledTimes(1);
    expect(execaMock.mock.calls[0]?.[1]).toEqual([
      "rev-parse",
      "--verify",
      "refs/heads/agent/va-1",
    ]);
  });

  it("VA-417: resets the branch to origin/<base> when it has commits ahead", async () => {
    // The HITL-retry case. agent/va-1 carries a rejected prior diff;
    // we move the ref to origin/main so the impl agent re-runs from a
    // clean tree instead of treating the rejected commits as
    // authoritative.
    execaMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: "abc123\n" }) // rev-parse: branch exists
      .mockResolvedValueOnce({ exitCode: 0, stdout: "3\n" }) // rev-list count > 0
      .mockResolvedValueOnce({ exitCode: 0, stdout: "def456\n" }) // rev-parse: origin/main reachable
      .mockResolvedValueOnce({ exitCode: 0, stdout: "" }) // worktree list — no attached worktree
      .mockResolvedValueOnce({ exitCode: 0, stdout: "" }); // update-ref
    await runPrune();
    const updateRefCall = execaMock.mock.calls.find(
      (c) => c[1]?.[0] === "update-ref",
    );
    expect(updateRefCall?.[1]).toEqual([
      "update-ref",
      "refs/heads/agent/va-1",
      "refs/remotes/origin/main",
    ]);
    // No `git branch -D` — the commits are a discarded prior attempt,
    // not state we want to delete the ref over.
    expect(
      execaMock.mock.calls.find((c) => c[1]?.[0] === "branch"),
    ).toBeUndefined();
  });

  it("VA-417: removes any worktree attached to the branch before resetting the ref", async () => {
    // If sandcastle's prior-run cleanup left a worktree dangling on
    // the branch, sandcastle's reuse path would see a dirty worktree
    // (HEAD ref moved out from under the working tree) and warn-and-
    // reuse instead of forking fresh. Remove first.
    const worktreePath = "/tmp/repo/.sandcastle/worktrees/agent-va-1";
    const porcelain = [
      "worktree /tmp/repo",
      "HEAD aaa",
      "branch refs/heads/main",
      "",
      `worktree ${worktreePath}`,
      "HEAD bbb",
      "branch refs/heads/agent/va-1",
      "",
    ].join("\n");
    execaMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: "abc123\n" }) // rev-parse: branch exists
      .mockResolvedValueOnce({ exitCode: 0, stdout: "1\n" }) // rev-list count > 0
      .mockResolvedValueOnce({ exitCode: 0, stdout: "def456\n" }) // origin/main reachable
      .mockResolvedValueOnce({ exitCode: 0, stdout: porcelain }) // worktree list
      .mockResolvedValueOnce({ exitCode: 0, stdout: "" }) // worktree remove --force
      .mockResolvedValueOnce({ exitCode: 0, stdout: "" }); // update-ref
    await runPrune();
    const removeCall = execaMock.mock.calls.find(
      (c) =>
        Array.isArray(c[1]) &&
        (c[1] as string[])[0] === "worktree" &&
        (c[1] as string[])[1] === "remove",
    );
    expect(removeCall?.[1]).toEqual([
      "worktree",
      "remove",
      "--force",
      worktreePath,
    ]);
  });

  it("VA-417: falls back to local <base> when origin/<base> is unreachable", async () => {
    execaMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: "abc123\n" }) // rev-parse: branch exists
      .mockResolvedValueOnce({ exitCode: 0, stdout: "2\n" }) // rev-list count > 0
      .mockResolvedValueOnce({ exitCode: 128, stdout: "" }) // rev-parse: origin/main missing
      .mockResolvedValueOnce({ exitCode: 0, stdout: "def456\n" }) // rev-parse: local main reachable
      .mockResolvedValueOnce({ exitCode: 0, stdout: "" }) // worktree list
      .mockResolvedValueOnce({ exitCode: 0, stdout: "" }); // update-ref
    await runPrune();
    const updateRefCall = execaMock.mock.calls.find(
      (c) => c[1]?.[0] === "update-ref",
    );
    expect(updateRefCall?.[1]).toEqual([
      "update-ref",
      "refs/heads/agent/va-1",
      "refs/heads/main",
    ]);
  });

  it("VA-417: surfaces a typed error when neither origin/<base> nor local <base> resolve", async () => {
    execaMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: "abc123\n" }) // branch exists
      .mockResolvedValueOnce({ exitCode: 0, stdout: "1\n" }) // commits ahead
      .mockResolvedValueOnce({ exitCode: 128, stdout: "" }) // origin/main missing
      .mockResolvedValueOnce({ exitCode: 128, stdout: "" }); // local main missing too
    await expect(runPrune()).rejects.toThrow(
      /Cannot reset stale agent branch.*neither.*origin\/main.*nor.*refs\/heads\/main/s,
    );
    // Bailed before touching update-ref or worktree state.
    expect(
      execaMock.mock.calls.find((c) => c[1]?.[0] === "update-ref"),
    ).toBeUndefined();
    expect(
      execaMock.mock.calls.find(
        (c) =>
          Array.isArray(c[1]) &&
          (c[1] as string[])[0] === "worktree" &&
          (c[1] as string[])[1] === "remove",
      ),
    ).toBeUndefined();
  });

  it("VA-366: deletes the branch via `git branch -D` when it exists with zero commits ahead", async () => {
    execaMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: "abc123\n" }) // rev-parse exists
      .mockResolvedValueOnce({ exitCode: 0, stdout: "0\n" }) // rev-list count == 0
      .mockResolvedValueOnce({ exitCode: 0, stdout: "" }); // branch -D
    await runPrune();
    const branchCall = execaMock.mock.calls.find(
      (c) => c[1]?.[0] === "branch",
    );
    expect(branchCall?.[1]).toEqual(["branch", "-D", "agent/va-1"]);
    // Did NOT take the VA-417 reset path.
    expect(
      execaMock.mock.calls.find((c) => c[1]?.[0] === "update-ref"),
    ).toBeUndefined();
  });

  it("preserves the branch (safe default) when hasCommits can't determine state", async () => {
    // exists check succeeds, but hasCommits throws — we bail rather
    // than risk either destroying work (VA-417 reset) or losing a
    // valid stale-tip branch (VA-366 delete) on uncertain state.
    execaMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: "abc123\n" }) // rev-parse exists
      .mockRejectedValueOnce(new Error("git not installed")); // rev-list throws
    await runPrune();
    expect(
      execaMock.mock.calls.find((c) => c[1]?.[0] === "branch"),
    ).toBeUndefined();
    expect(
      execaMock.mock.calls.find((c) => c[1]?.[0] === "update-ref"),
    ).toBeUndefined();
  });
});

describe("rebaseOntoBase (VA-419 / VA-424)", () => {
  const runRebase = (base = "master", branch = "agent/va-419") =>
    Effect.runPromise(rebaseOntoBase("/tmp/repo", base, branch));

  it("returns `ok` for a no-op rebase (exit 0, branch already at base)", async () => {
    // Real-world: branch ref equals origin/<base> tip — git prints
    // "Current branch ... is up to date." and exits 0. No replayed
    // commits, but still an `ok` outcome → finalize opens the PR.
    execaMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: "" }) // fetch
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "Current branch agent/va-419 is up to date.\n",
      });
    await expect(runRebase()).resolves.toEqual({ kind: "ok" });
    // No diff or --abort calls — the no-op path is straight-through.
    expect(execaMock).toHaveBeenCalledTimes(2);
  });

  it("returns `ok` for a clean fast-forward / replay (exit 0 with replayed commits)", async () => {
    execaMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: "" }) // fetch
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "Successfully rebased and updated refs/heads/agent/va-419.\n",
      });
    await expect(runRebase()).resolves.toEqual({ kind: "ok" });

    expect(execaMock.mock.calls[0]?.[1]).toEqual([
      "fetch",
      "origin",
      "master",
    ]);
    expect(execaMock.mock.calls[1]?.[1]).toEqual([
      "rebase",
      "origin/master",
      "agent/va-419",
    ]);
    expect(execaMock).toHaveBeenCalledTimes(2);
  });

  it("returns `conflict` with the unmerged file list when git reports unmerged paths", async () => {
    execaMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: "" }) // fetch
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: "",
        stderr: "CONFLICT (content): Merge conflict in src/dashboard/storage.ts\n",
      }) // rebase fails
      .mockResolvedValueOnce({
        // diff --name-only --diff-filter=U
        exitCode: 0,
        stdout: "src/dashboard/storage.ts\nsrc/dashboard/storage.test.ts\n",
      })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "" }); // rebase --abort

    await expect(runRebase()).resolves.toEqual({
      kind: "conflict",
      conflictedFiles: [
        "src/dashboard/storage.ts",
        "src/dashboard/storage.test.ts",
      ],
    });

    // Confirm we asked git for the unmerged file list, then aborted.
    expect(execaMock.mock.calls[2]?.[1]).toEqual([
      "diff",
      "--name-only",
      "--diff-filter=U",
    ]);
    expect(execaMock.mock.calls[3]?.[1]).toEqual(["rebase", "--abort"]);
  });

  it("returns `failure` (with stderr) when rebase exits non-zero but git reports no unmerged files", async () => {
    // VA-424: non-conflict failure path — e.g., dirty host worktree,
    // signing hook, lock contention. Mode A from the live evidence.
    execaMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: "" }) // fetch
      .mockResolvedValueOnce({
        exitCode: 128,
        stdout: "",
        stderr: "error: cannot rebase: You have unstaged changes.\n",
      }) // rebase fails for non-conflict reason
      .mockResolvedValueOnce({ exitCode: 0, stdout: "" }) // diff probe empty
      .mockResolvedValueOnce({ exitCode: 128, stdout: "" }); // rebase --abort (no-op, no rebase in progress)

    await expect(runRebase()).resolves.toEqual({
      kind: "failure",
      stderr: "error: cannot rebase: You have unstaged changes.\n",
      stdout: "",
    });
  });

  it("returns `failure` when the diff probe throws (no unmerged-file evidence available)", async () => {
    execaMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: "" }) // fetch
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: "",
        stderr: "fatal: some other rebase failure\n",
      })
      .mockRejectedValueOnce(new Error("git broke")) // diff probe throws
      .mockResolvedValueOnce({ exitCode: 0, stdout: "" }); // rebase --abort

    await expect(runRebase()).resolves.toEqual({
      kind: "failure",
      stderr: "fatal: some other rebase failure\n",
      stdout: "",
    });
  });

  it("propagates a fetch failure — finalize routes it through processIssue's failure path", async () => {
    execaMock.mockRejectedValueOnce(new Error("origin unreachable"));
    await expect(runRebase()).rejects.toThrow(/origin unreachable/);
  });
});
