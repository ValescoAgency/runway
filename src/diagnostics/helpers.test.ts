import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const execaMock = vi.fn();
vi.mock("execa", () => ({ execa: execaMock }));

const { checkBinaryVersion, envSet, errMsg, runDiagnostics } = await import(
  "./index.js"
);

beforeEach(() => {
  execaMock.mockReset();
});

describe("checkBinaryVersion", () => {
  it("returns ok with the first line of stdout when the binary is present", async () => {
    execaMock.mockResolvedValueOnce({
      stdout: "git version 2.43.0\n(extra)",
      stderr: "",
    });
    const res = await checkBinaryVersion("git", ["--version"]);
    expect(res).toEqual({
      status: "ok",
      label: "git",
      detail: "git version 2.43.0",
    });
  });

  it("falls back to stderr when stdout is empty", async () => {
    execaMock.mockResolvedValueOnce({
      stdout: "",
      stderr: "varlock 0.5.1",
    });
    const res = await checkBinaryVersion("varlock", ["--version"]);
    expect(res).toEqual({
      status: "ok",
      label: "varlock",
      detail: "varlock 0.5.1",
    });
  });

  it("returns ok with `(installed)` when both streams are empty", async () => {
    execaMock.mockResolvedValueOnce({ stdout: "", stderr: "" });
    const res = await checkBinaryVersion("foo", ["--version"]);
    expect(res.status).toBe("ok");
    expect(res.detail).toBe("(installed)");
  });

  it("returns fail when execa throws (binary not on PATH)", async () => {
    execaMock.mockRejectedValueOnce(new Error("spawn ENOENT"));
    const res = await checkBinaryVersion("notarealbinary", ["--version"]);
    expect(res).toEqual({
      status: "fail",
      label: "notarealbinary",
      detail: "notarealbinary not on PATH",
    });
  });
});

describe("envSet", () => {
  const orig = process.env.RUNWAY_DOCTOR_TEST_VAR;
  beforeEach(() => {
    delete process.env.RUNWAY_DOCTOR_TEST_VAR;
  });
  afterAll(() => {
    if (orig === undefined) delete process.env.RUNWAY_DOCTOR_TEST_VAR;
    else process.env.RUNWAY_DOCTOR_TEST_VAR = orig;
  });

  it("returns ok=set when the var is non-empty", () => {
    process.env.RUNWAY_DOCTOR_TEST_VAR = "hello";
    expect(envSet("RUNWAY_DOCTOR_TEST_VAR", "fail")).toEqual({
      status: "ok",
      label: "RUNWAY_DOCTOR_TEST_VAR",
      detail: "set",
    });
  });

  it("returns the configured missingStatus when the var is unset", () => {
    expect(envSet("RUNWAY_DOCTOR_TEST_VAR", "fail")).toMatchObject({
      status: "fail",
      label: "RUNWAY_DOCTOR_TEST_VAR",
      detail: "unset",
    });
    expect(envSet("RUNWAY_DOCTOR_TEST_VAR", "warn")).toMatchObject({
      status: "warn",
    });
  });

  it("treats whitespace-only as unset", () => {
    process.env.RUNWAY_DOCTOR_TEST_VAR = "   ";
    expect(envSet("RUNWAY_DOCTOR_TEST_VAR", "fail").status).toBe("fail");
  });
});

describe("errMsg", () => {
  it("trims an Error message to its first line", () => {
    expect(errMsg(new Error("line one\nline two"))).toBe("line one");
  });
  it("stringifies non-Error values", () => {
    expect(errMsg("plain string")).toBe("plain string");
    expect(errMsg(42)).toBe("42");
  });
});

describe("runDiagnostics filtering", () => {
  // Smoke test the registry-level filters: --check, tier, and the
  // no-scaffold gate. Mocks every adapter's execa call to keep this
  // a unit test rather than an integration run.
  //
  // The full set of diagnostics has 16 entries; we don't assert on
  // each one — we assert on the *shape* of the SectionResult[] under
  // various filter inputs.
  it("returns one SectionResult per canonical section, always", async () => {
    // Default execa: any binary call resolves so we don't blow up.
    execaMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const sections = await runDiagnostics({
      cwd: "/tmp/repo",
      tier: 1,
      repo: {
        tier: 1,
        hasDockerfile: true,
        hasSchema: false,
        authMode: null,
        hasConflictingAuthVars: false,
      },
      options: { detailed: false, json: false },
    });
    expect(sections.map((s) => s.title)).toEqual([
      "Host tooling",
      "Environment",
      "Repo state",
      "Docker image",
      "Linear configuration",
    ]);
  });

  it("filters by --check name — only matching diagnostics contribute", async () => {
    execaMock.mockResolvedValue({ exitCode: 0, stdout: "1.0.0", stderr: "" });
    const sections = await runDiagnostics({
      cwd: "/tmp/repo",
      tier: 2,
      repo: {
        tier: 2,
        hasDockerfile: true,
        hasSchema: true,
        authMode: "api-key",
        hasConflictingAuthVars: false,
      },
      options: { detailed: false, json: false, checks: ["node"] },
    });
    // Only the host-tooling section has a check result; other
    // sections are present but empty (filtered out by --check).
    const host = sections.find((s) => s.title === "Host tooling");
    expect(host?.ran).toBe(true);
    expect([...(host?.checks.values() ?? [])].map((c) => c.label)).toEqual([
      "node",
    ]);
    const env = sections.find((s) => s.title === "Environment");
    expect(env?.ran).toBe(false);
  });

  it("skips non-host sections when there's no scaffold and no --tier override", async () => {
    execaMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const sections = await runDiagnostics({
      cwd: "/tmp/repo",
      tier: 2,
      repo: {
        tier: null,
        hasDockerfile: false,
        hasSchema: false,
        authMode: null,
        hasConflictingAuthVars: false,
      },
      options: { detailed: false, json: false },
    });
    const env = sections.find((s) => s.title === "Environment");
    expect(env?.ran).toBe(false);
    const host = sections.find((s) => s.title === "Host tooling");
    expect(host?.ran).toBe(true);
  });
});

