import { describe, expect, it, vi } from "vitest";

// Mock the diagnostics registry so the command tests don't drag in
// every adapter's execa shell-out. We only care here about argv
// parsing, --check validation, and render-shape (the per-adapter
// behaviour is covered by src/diagnostics/*.test.ts).
vi.mock("../diagnostics/index.js", async () => {
  return {
    DIAGNOSTICS: [
      { name: "node", section: "Host tooling", tier: "both" },
      { name: "docker", section: "Host tooling", tier: "both" },
      { name: "linear-config", section: "Linear configuration", tier: "both" },
    ],
    runDiagnostics: vi.fn(async () => []),
  };
});

const { printDoctorUsage } = await import("./doctor.js");

describe("printDoctorUsage", () => {
  it("documents the --check flag", () => {
    const out: string[] = [];
    const origLog = console.log;
    console.log = (msg: unknown) => {
      out.push(String(msg));
    };
    try {
      printDoctorUsage();
    } finally {
      console.log = origLog;
    }
    const combined = out.join("\n");
    expect(combined).toContain("--check=NAME");
    expect(combined).toContain("Run only diagnostics with the given name");
  });

  it("documents all five canonical sections", () => {
    const out: string[] = [];
    const origLog = console.log;
    console.log = (msg: unknown) => {
      out.push(String(msg));
    };
    try {
      printDoctorUsage();
    } finally {
      console.log = origLog;
    }
    const combined = out.join("\n");
    for (const section of [
      "Host tooling",
      "Environment",
      "Repo state",
      "Docker image",
      "Linear config",
    ]) {
      expect(combined).toContain(section);
    }
  });
});
