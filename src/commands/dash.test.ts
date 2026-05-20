import { describe, expect, it } from "vitest";
import {
  buildDockerRunArgs,
  parseDashArgs,
  printDashUsage,
  resolveDashOptions,
} from "./dash.js";

describe("parseDashArgs (VA-393)", () => {
  it("requires a verb", () => {
    expect(() => parseDashArgs([])).toThrow(/missing verb/);
  });

  it("rejects unknown verbs", () => {
    expect(() => parseDashArgs(["foo"])).toThrow(/unknown verb/);
  });

  it("accepts the four canonical verbs", () => {
    expect(parseDashArgs(["up"]).verb).toBe("up");
    expect(parseDashArgs(["logs"]).verb).toBe("logs");
    expect(parseDashArgs(["stop"]).verb).toBe("stop");
    // VA-451
    expect(parseDashArgs(["upgrade"]).verb).toBe("upgrade");
  });

  // VA-451
  it("accepts --image / --otlp-port / --dashboard-port on upgrade", () => {
    const parsed = parseDashArgs([
      "upgrade",
      "--image=ghcr.io/x/y:0.12.0",
      "--otlp-port=4318",
      "--dashboard-port=3001",
    ]);
    expect(parsed.verb).toBe("upgrade");
    expect(parsed.image).toBe("ghcr.io/x/y:0.12.0");
    expect(parsed.otlpPort).toBe("4318");
    expect(parsed.dashboardPort).toBe("3001");
  });

  it("parses --image, --otlp-port, --dashboard-port", () => {
    const parsed = parseDashArgs([
      "up",
      "--image=ghcr.io/x/y:tag",
      "--otlp-port=9999",
      "--dashboard-port=8888",
    ]);
    expect(parsed.image).toBe("ghcr.io/x/y:tag");
    expect(parsed.otlpPort).toBe("9999");
    expect(parsed.dashboardPort).toBe("8888");
  });

  it("parses --follow / -f on logs", () => {
    expect(parseDashArgs(["logs", "--follow"]).follow).toBe(true);
    expect(parseDashArgs(["logs", "-f"]).follow).toBe(true);
    expect(parseDashArgs(["logs"]).follow).toBe(false);
  });

  it("parses --purge on stop", () => {
    expect(parseDashArgs(["stop", "--purge"]).purge).toBe(true);
    expect(parseDashArgs(["stop"]).purge).toBe(false);
  });

  it("rejects unknown flags", () => {
    expect(() => parseDashArgs(["up", "--nope"])).toThrow(/unknown argument/);
  });
});

describe("resolveDashOptions (VA-393)", () => {
  const baseParsed = {
    verb: "up" as const,
    follow: false,
    purge: false,
  };

  it("falls back to the published :latest tag with an empty env", () => {
    const opts = resolveDashOptions(baseParsed, {});
    expect(opts.image).toBe("ghcr.io/valescoagency/runway-dashboard:latest");
  });

  it("honors RUNWAY_DASHBOARD_IMAGE", () => {
    const opts = resolveDashOptions(baseParsed, {
      RUNWAY_DASHBOARD_IMAGE: "ghcr.io/x/y:dev",
    });
    expect(opts.image).toBe("ghcr.io/x/y:dev");
  });

  it("CLI --image wins over the env var", () => {
    const opts = resolveDashOptions(
      { ...baseParsed, image: "explicit:ref" },
      { RUNWAY_DASHBOARD_IMAGE: "ghcr.io/x/y:dev" },
    );
    expect(opts.image).toBe("explicit:ref");
  });

  it("defaults the ports to 4318 (OTLP) and 3001 (dashboard)", () => {
    const opts = resolveDashOptions(baseParsed, {});
    expect(opts.otlpPort).toBe("4318");
    expect(opts.dashboardPort).toBe("3001");
  });

  it("CLI port flags override env-var defaults", () => {
    const opts = resolveDashOptions(
      { ...baseParsed, otlpPort: "5000", dashboardPort: "5001" },
      { OTLP_PORT: "4000", DASHBOARD_PORT: "4001" },
    );
    expect(opts.otlpPort).toBe("5000");
    expect(opts.dashboardPort).toBe("5001");
  });
});

describe("buildDockerRunArgs (VA-393)", () => {
  const baseOpts = {
    verb: "up" as const,
    image: "ghcr.io/valescoagency/runway-dashboard:latest",
    containerName: "runway-dashboard",
    volumeName: "runway-dashboard-data",
    otlpPort: "4318",
    dashboardPort: "3001",
    follow: false,
    purge: false,
  };

  it("binds host-side ports to 127.0.0.1 only (loopback enforcement)", () => {
    const args = buildDockerRunArgs(baseOpts, {});
    expect(args).toContain("127.0.0.1:3001:3001");
    expect(args).toContain("127.0.0.1:4318:4318");
    // Nothing should expose to 0.0.0.0 from this argv.
    expect(args.some((a) => a.startsWith("0.0.0.0:"))).toBe(false);
  });

  it("runs detached with --restart unless-stopped", () => {
    const args = buildDockerRunArgs(baseOpts, {});
    expect(args[0]).toBe("run");
    expect(args).toContain("--detach");
    expect(args).toContain("unless-stopped");
  });

  it("mounts a named volume at /data", () => {
    const args = buildDockerRunArgs(baseOpts, {});
    expect(args).toContain("runway-dashboard-data:/data");
  });

  it("uses the container name from options", () => {
    const args = buildDockerRunArgs(
      { ...baseOpts, containerName: "alt-name" },
      {},
    );
    const nameIdx = args.indexOf("--name");
    expect(nameIdx).toBeGreaterThanOrEqual(0);
    expect(args[nameIdx + 1]).toBe("alt-name");
  });

  it("forwards Linear sync env keys without echoing their values", () => {
    const args = buildDockerRunArgs(baseOpts, {
      LINEAR_API_KEY: "secret-value",
      RUNWAY_LINEAR_TEAM: "VA",
    });
    // `-e LINEAR_API_KEY` (no value) → docker reads it from the
    // calling process env, so the secret stays out of argv.
    const lkeyIdx = args.indexOf("LINEAR_API_KEY");
    expect(lkeyIdx).toBeGreaterThanOrEqual(0);
    expect(args[lkeyIdx - 1]).toBe("-e");
    expect(args).toContain("RUNWAY_LINEAR_TEAM");
    expect(args).not.toContain("secret-value");
  });

  // VA-452
  it("forwards RUNWAY_LINEAR_WORKSPACE into the container when set", () => {
    const args = buildDockerRunArgs(baseOpts, {
      RUNWAY_LINEAR_WORKSPACE: "valescoagency",
    });
    const idx = args.indexOf("RUNWAY_LINEAR_WORKSPACE");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx - 1]).toBe("-e");
  });

  it("skips forwarded env keys that are unset or empty", () => {
    const args = buildDockerRunArgs(baseOpts, { LINEAR_API_KEY: "" });
    expect(args).not.toContain("LINEAR_API_KEY");
  });

  it("places the image reference as the last argument", () => {
    const args = buildDockerRunArgs(baseOpts, {});
    expect(args[args.length - 1]).toBe(
      "ghcr.io/valescoagency/runway-dashboard:latest",
    );
  });

  it("exposes OTLP_PORT and DASHBOARD_PORT as inline env so the container honors them", () => {
    const args = buildDockerRunArgs(
      { ...baseOpts, otlpPort: "9999", dashboardPort: "8888" },
      {},
    );
    expect(args).toContain("OTLP_PORT=9999");
    expect(args).toContain("DASHBOARD_PORT=8888");
  });
});

describe("printDashUsage (VA-393)", () => {
  it("documents the four verbs", () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (s: string) => lines.push(s);
    try {
      printDashUsage();
    } finally {
      console.log = orig;
    }
    const out = lines.join("\n");
    expect(out).toContain("runway dash up");
    expect(out).toContain("runway dash upgrade");
    expect(out).toContain("runway dash logs");
    expect(out).toContain("runway dash stop");
  });

  it("documents the default published image reference", () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (s: string) => lines.push(s);
    try {
      printDashUsage();
    } finally {
      console.log = orig;
    }
    expect(lines.join("\n")).toContain(
      "ghcr.io/valescoagency/runway-dashboard:latest",
    );
  });
});
