import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

// Treat the vendored Dockerfile as a tested artifact: its shape is what
// every `runway init` and `runway upgrade-repo` writes into a target
// repo's `.sandcastle/Dockerfile`. VA-351 specifically requires that
// the container env (HOME, XDG_CACHE_HOME, TURBO_CACHE_DIR, pnpm via
// corepack, pre-created cache dirs) ships baked in — drift here would
// reintroduce the per-iteration workarounds the agent had to do by
// hand.

const __dirname = dirname(fileURLToPath(import.meta.url));
const dockerfile = readFileSync(
  join(__dirname, "..", "templates", "Dockerfile.claude-code.base"),
  "utf8",
);

describe("Dockerfile.claude-code.base (VA-351)", () => {
  it("sets HOME=/home/agent (root cause of the turbo cache leak)", () => {
    expect(dockerfile).toMatch(/^ENV HOME=\/home\/agent$/m);
  });

  it("sets XDG_CACHE_HOME under the agent's home", () => {
    expect(dockerfile).toMatch(
      /^ENV XDG_CACHE_HOME=\/home\/agent\/.cache$/m,
    );
  });

  it("points TURBO_CACHE_DIR at an in-container path", () => {
    expect(dockerfile).toMatch(/^ENV TURBO_CACHE_DIR=\/tmp\/turbo-cache$/m);
  });

  it("redirects npm cache into the agent's cache dir", () => {
    expect(dockerfile).toMatch(
      /^ENV npm_config_cache=\/home\/agent\/.cache\/npm$/m,
    );
  });

  it("pre-creates cache dirs with agent ownership", () => {
    expect(dockerfile).toMatch(/mkdir -p \/home\/agent\/\.cache/);
    expect(dockerfile).toMatch(/mkdir -p .*\/tmp\/turbo-cache/);
    expect(dockerfile).toMatch(
      /chown -R \$AGENT_UID:\$AGENT_GID \/home\/agent\/\.cache \/tmp\/turbo-cache/,
    );
  });

  it("bakes pnpm via corepack at build time", () => {
    expect(dockerfile).toMatch(/corepack enable/);
    expect(dockerfile).toMatch(/corepack prepare pnpm@\d/);
  });

  it("does the env setup BEFORE switching to the unprivileged USER", () => {
    const corepackIdx = dockerfile.indexOf("corepack");
    const userIdx = dockerfile.indexOf("USER ${AGENT_UID}");
    expect(corepackIdx).toBeGreaterThan(-1);
    expect(userIdx).toBeGreaterThan(-1);
    expect(corepackIdx).toBeLessThan(userIdx);
  });
});
