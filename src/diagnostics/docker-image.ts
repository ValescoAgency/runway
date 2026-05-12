import { execa } from "execa";
import { basename } from "node:path";
import {
  type CheckResult,
  type Diagnostic,
  type DoctorContext,
  errMsg,
} from "./index.js";

/**
 * Multi-result adapter. `docker image inspect` produces the imageUser
 * value that the user-match check needs; the runtime probe `docker
 * run --rm ... bash -lc ...` checks that pnpm + HOME + cache env
 * vars are baked into the image. Splitting these would re-run
 * `inspect` per sub-check (wasteful) or thread state through the
 * registry (complex), so they live as one adapter.
 */
export const dockerImageDiagnostic: Diagnostic = {
  name: "docker-image",
  section: "Docker image",
  tier: "both",
  async run(ctx: DoctorContext): Promise<readonly CheckResult[]> {
    const imageName = expectedImageName(ctx.cwd);
    const results: CheckResult[] = [];

    let imageUser: string | undefined;
    try {
      const { stdout } = await execa(
        "docker",
        ["image", "inspect", imageName, "--format", "{{.Config.User}}"],
        { reject: true },
      );
      imageUser = (stdout as string).trim();
      results.push({
        status: "ok",
        label: `image ${imageName}`,
        detail: "present",
      });
    } catch (err) {
      results.push({
        status: "fail",
        label: `image ${imageName}`,
        detail: `not built — ${errMsg(err)}`,
      });
      return results;
    }

    // User mismatch warning per sandcastle's pre-flight diagnostic:
    // image was built for one UID:GID; if the host UID:GID differs the
    // bind-mount permissions will be off.
    const hostUid = process.getuid?.() ?? 1000;
    const hostGid = process.getgid?.() ?? 1000;
    const expected = `${hostUid}:${hostGid}`;
    if (imageUser && imageUser !== expected) {
      results.push({
        status: "warn",
        label: "image user matches host UID:GID",
        detail: `image User=${imageUser}, host=${expected} — rebuild with --build-arg AGENT_UID/AGENT_GID`,
      });
    } else {
      results.push({
        status: "ok",
        label: "image user matches host UID:GID",
        detail: imageUser
          ? `User=${imageUser}`
          : `User unset (root); host=${expected}`,
      });
    }

    // VA-351: container readiness — pnpm on PATH + HOME/cache env
    // baked in. Cheap one-shot run; fails fast if the image is stale.
    try {
      const probe = await execa(
        "docker",
        [
          "run",
          "--rm",
          "--entrypoint",
          "bash",
          imageName,
          "-lc",
          'set -e; which pnpm >/dev/null && printf "HOME=%s\\nXDG_CACHE_HOME=%s\\nTURBO_CACHE_DIR=%s\\n" "$HOME" "$XDG_CACHE_HOME" "$TURBO_CACHE_DIR"',
        ],
        { reject: false },
      );
      const out = (probe.stdout as string) ?? "";
      const missing: string[] = [];
      if (probe.exitCode !== 0) missing.push("pnpm");
      if (!/^HOME=\/home\/agent\s*$/m.test(out)) missing.push("HOME");
      if (!/^XDG_CACHE_HOME=\/home\/agent\/.cache\s*$/m.test(out)) {
        missing.push("XDG_CACHE_HOME");
      }
      if (!/^TURBO_CACHE_DIR=\/tmp\/turbo-cache\s*$/m.test(out)) {
        missing.push("TURBO_CACHE_DIR");
      }
      if (missing.length === 0) {
        results.push({
          status: "ok",
          label: "container readiness",
          detail: "pnpm on PATH; HOME, XDG_CACHE_HOME, TURBO_CACHE_DIR set",
        });
      } else {
        results.push({
          status: "warn",
          label: "container readiness",
          detail: `missing or wrong inside container: ${missing.join(", ")} — rebuild via \`runway upgrade-repo && docker build .sandcastle -t ${imageName}\``,
        });
      }
    } catch (err) {
      results.push({
        status: "warn",
        label: "container readiness",
        detail: `probe failed: ${errMsg(err)}`,
      });
    }

    return results;
  },
};

/**
 * Sanitize the cwd's basename the same way sandcastle's
 * `defaultImageName` does, so doctor's expected name matches what
 * `runway upgrade-repo` actually builds.
 */
function expectedImageName(cwd: string): string {
  const slug = basename(cwd)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `sandcastle-${slug || "repo"}`;
}
