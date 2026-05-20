import { execa, type ExecaError } from "execa";

/**
 * VA-393 (dashboard slice 8): `runway dash` subcommand. Wraps
 * `docker run` so users can operate the dashboard from any
 * runway-using project without cloning the runway repo or maintaining
 * a docker-compose file.
 *
 * Four verbs:
 *   up      pull the published image and run it as a detached
 *           container (`runway-dashboard`) with loopback ports and a
 *           named volume for the SQLite db.
 *   logs    stream `docker logs` for the container (`--follow` toggles
 *           `-f`; default tails recent output without following).
 *   stop    stop and `rm` the container. The named volume stays so
 *           history survives across restarts; explicit `--purge` drops
 *           the volume too.
 *   upgrade VA-451: pull a fresh image, then stop + `rm` the existing
 *           container and start a new one against the same named
 *           volume. The pull happens first so a failed pull leaves the
 *           existing dashboard running. Schema migrations on the
 *           SQLite db are idempotent (ALTER TABLE ADD COLUMN swallowed
 *           on duplicate), so column-add releases like VA-450 carry
 *           forward without operator intervention.
 *
 * Defaults to the `:latest` tag published by `.github/workflows/dashboard-image.yml`.
 * Override via `--image` or the `RUNWAY_DASHBOARD_IMAGE` env var.
 *
 * Verb-agnostic env passthrough: when set in the caller's environment,
 * `LINEAR_API_KEY`, `LINEAR_POLL_INTERVAL_SECONDS`, `RUNWAY_LINEAR_TEAM`,
 * `RUNWAY_READY_LABEL` are forwarded into the container via `-e`.
 * Absent → the container falls back to the same defaults as
 * `docker-compose.yml` (Linear sync disabled, etc.).
 */

const DEFAULT_IMAGE = "ghcr.io/valescoagency/runway-dashboard:latest";
const DEFAULT_CONTAINER_NAME = "runway-dashboard";
const DEFAULT_VOLUME_NAME = "runway-dashboard-data";
const DEFAULT_OTLP_PORT = "4318";
const DEFAULT_DASHBOARD_PORT = "3001";

/**
 * Linear sync envs we forward when present. Kept narrow on purpose —
 * the dashboard reads its own env at boot and we don't want a stray
 * shell variable leaking into the container.
 */
const FORWARDED_ENV_KEYS = [
  "LINEAR_API_KEY",
  "LINEAR_POLL_INTERVAL_SECONDS",
  "RUNWAY_LINEAR_TEAM",
  "RUNWAY_READY_LABEL",
] as const;

export interface DashOptions {
  readonly verb: "up" | "logs" | "stop" | "upgrade";
  readonly image: string;
  readonly containerName: string;
  readonly volumeName: string;
  readonly otlpPort: string;
  readonly dashboardPort: string;
  readonly follow: boolean;
  readonly purge: boolean;
}

export function printDashUsage(): void {
  console.log(`runway dash — operate the runway operations dashboard

Wraps \`docker run\` so the dashboard works from any runway-using
project without cloning the runway repo. The published image is
${DEFAULT_IMAGE}; override via --image or RUNWAY_DASHBOARD_IMAGE.

USAGE
  runway dash up      [--image=…] [--otlp-port=N] [--dashboard-port=N]
  runway dash upgrade [--image=…] [--otlp-port=N] [--dashboard-port=N]
  runway dash logs    [--follow]
  runway dash stop    [--purge]

VERBS
  up       Pull and start the dashboard as a detached container
           (\`${DEFAULT_CONTAINER_NAME}\`). Ports publish to 127.0.0.1
           only; a named volume (\`${DEFAULT_VOLUME_NAME}\`) persists
           the SQLite db across runs.
  upgrade  Pull a fresh image and replace the running container with
           one based on it. The pull runs first, so if it fails the
           existing container is left untouched. The named volume
           (\`${DEFAULT_VOLUME_NAME}\`) is preserved across the
           replacement — SQLite history + schema migrate forward.
  logs     Stream container logs (\`docker logs ${DEFAULT_CONTAINER_NAME}\`).
           Pass --follow to tail with -f.
  stop     Stop and remove the container. The named volume stays unless
           --purge is passed.

OPTIONS
  --image=REF         Override the dashboard image reference.
                      Default: ${DEFAULT_IMAGE} (env: RUNWAY_DASHBOARD_IMAGE).
  --otlp-port=N       Host port for the OTLP receiver. Default: ${DEFAULT_OTLP_PORT}.
  --dashboard-port=N  Host port for the dashboard UI. Default: ${DEFAULT_DASHBOARD_PORT}.
  --follow, -f        (logs) Tail container logs with -f.
  --purge             (stop) Also remove the named volume (deletes history).
  --help, -h          Show this help.

LINEAR SYNC (optional)
  When LINEAR_API_KEY is set in the caller's environment, \`runway dash
  up\` forwards it into the container so the dashboard polls Linear and
  surfaces the Todo queue. LINEAR_POLL_INTERVAL_SECONDS,
  RUNWAY_LINEAR_TEAM, and RUNWAY_READY_LABEL are forwarded too when
  set. Absent → the dashboard runs without Linear surfaces.

OTEL EXPORTER
  Point \`runway run\` at the dashboard by exporting:
    OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:${DEFAULT_OTLP_PORT}
`);
}

export interface ParsedDashArgs {
  readonly verb: "up" | "logs" | "stop" | "upgrade";
  readonly image?: string;
  readonly otlpPort?: string;
  readonly dashboardPort?: string;
  readonly follow: boolean;
  readonly purge: boolean;
}

export function parseDashArgs(argv: readonly string[]): ParsedDashArgs {
  if (argv.length === 0) {
    throw new Error(
      "missing verb — expected one of: up, upgrade, logs, stop. Run `runway dash --help`.",
    );
  }
  const [verbRaw, ...rest] = argv;
  if (verbRaw === "--help" || verbRaw === "-h") {
    printDashUsage();
    process.exit(0);
  }
  if (
    verbRaw !== "up" &&
    verbRaw !== "logs" &&
    verbRaw !== "stop" &&
    verbRaw !== "upgrade"
  ) {
    throw new Error(
      `unknown verb "${verbRaw}" — expected one of: up, upgrade, logs, stop.`,
    );
  }
  const verb = verbRaw;
  let image: string | undefined;
  let otlpPort: string | undefined;
  let dashboardPort: string | undefined;
  let follow = false;
  let purge = false;

  for (const arg of rest) {
    if (arg === "--help" || arg === "-h") {
      printDashUsage();
      process.exit(0);
    } else if (arg.startsWith("--image=")) {
      image = arg.slice("--image=".length);
    } else if (arg.startsWith("--otlp-port=")) {
      otlpPort = arg.slice("--otlp-port=".length);
    } else if (arg.startsWith("--dashboard-port=")) {
      dashboardPort = arg.slice("--dashboard-port=".length);
    } else if (arg === "--follow" || arg === "-f") {
      follow = true;
    } else if (arg === "--purge") {
      purge = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { verb, image, otlpPort, dashboardPort, follow, purge };
}

/**
 * Resolve effective options by layering CLI flags over env vars over
 * built-in defaults. The resolved shape is pure data so tests can
 * assert on the command we'd hand to docker without invoking it.
 */
export function resolveDashOptions(
  parsed: ParsedDashArgs,
  env: NodeJS.ProcessEnv = process.env,
): DashOptions {
  const image =
    parsed.image ?? env.RUNWAY_DASHBOARD_IMAGE ?? DEFAULT_IMAGE;
  const otlpPort = parsed.otlpPort ?? env.OTLP_PORT ?? DEFAULT_OTLP_PORT;
  const dashboardPort =
    parsed.dashboardPort ?? env.DASHBOARD_PORT ?? DEFAULT_DASHBOARD_PORT;
  return {
    verb: parsed.verb,
    image,
    containerName: DEFAULT_CONTAINER_NAME,
    volumeName: DEFAULT_VOLUME_NAME,
    otlpPort,
    dashboardPort,
    follow: parsed.follow,
    purge: parsed.purge,
  };
}

/**
 * Build the `docker run` argv for `runway dash up`. Extracted so
 * tests can assert the bindings (loopback prefixes, named volume,
 * forwarded env vars) without spawning docker. Caller decides how to
 * execute the args.
 */
export function buildDockerRunArgs(
  opts: DashOptions,
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  const args: string[] = [
    "run",
    "--detach",
    "--name",
    opts.containerName,
    "--restart",
    "unless-stopped",
    // VA-393: host-side bindings stay on 127.0.0.1 by default so the
    // dashboard is unreachable from the LAN. Container-side stays
    // 0.0.0.0 because the Dockerfile sets DASHBOARD_HOST=0.0.0.0 so
    // Docker's port-forward can reach the listener.
    "-p",
    `127.0.0.1:${opts.dashboardPort}:${opts.dashboardPort}`,
    "-p",
    `127.0.0.1:${opts.otlpPort}:${opts.otlpPort}`,
    "-v",
    `${opts.volumeName}:/data`,
    "-e",
    `DASHBOARD_PORT=${opts.dashboardPort}`,
    "-e",
    `OTLP_PORT=${opts.otlpPort}`,
  ];

  // VA-393: forward Linear-sync env keys when set in the caller's
  // environment. We pass each key with no value so docker reads the
  // current process env — that way the key never echoes through the
  // shell history.
  for (const key of FORWARDED_ENV_KEYS) {
    if (env[key] !== undefined && env[key] !== "") {
      args.push("-e", key);
    }
  }

  args.push(opts.image);
  return args;
}

export async function dashCommand(argv: readonly string[]): Promise<void> {
  const parsed = parseDashArgs(argv);
  const opts = resolveDashOptions(parsed);
  await ensureDockerAvailable();

  switch (opts.verb) {
    case "up":
      await dashUp(opts);
      return;
    case "upgrade":
      await dashUpgrade(opts);
      return;
    case "logs":
      await dashLogs(opts);
      return;
    case "stop":
      await dashStop(opts);
      return;
  }
}

/**
 * Surface a clear error when docker isn't on PATH or the daemon isn't
 * reachable, instead of letting an opaque ENOENT bubble. `docker info`
 * is the canonical "is the daemon up?" probe.
 */
async function ensureDockerAvailable(): Promise<void> {
  try {
    await execa("docker", ["info"], { stdio: "ignore" });
  } catch (err) {
    const e = err as ExecaError;
    if (e.code === "ENOENT") {
      throw new Error(
        "docker not found on PATH. Install Docker Desktop (or Podman with a `docker` shim) and retry.",
      );
    }
    throw new Error(
      "docker daemon not reachable (`docker info` failed). Start Docker and retry.",
    );
  }
}

async function dashUp(opts: DashOptions): Promise<void> {
  // If a container with this name already exists (running or stopped),
  // print a helpful hint instead of letting docker error with a
  // "container already in use" diagnostic. Up-on-running is a no-op.
  const existing = await containerState(opts.containerName);
  if (existing === "running") {
    console.log(
      `[runway dash] container ${opts.containerName} already running.`,
    );
    await printAccessHints(opts);
    return;
  }
  if (existing === "stopped") {
    console.log(
      `[runway dash] container ${opts.containerName} exists but is stopped — starting it.`,
    );
    await execa("docker", ["start", opts.containerName], {
      stdio: "inherit",
    });
    await printAccessHints(opts);
    return;
  }

  console.log(`[runway dash] pulling ${opts.image}`);
  try {
    await execa("docker", ["pull", opts.image], { stdio: "inherit" });
  } catch {
    throw new Error(
      `failed to pull ${opts.image}. ` +
        "If the image is private, run `docker login ghcr.io` first.",
    );
  }

  const args = buildDockerRunArgs(opts);
  console.log(`[runway dash] starting container ${opts.containerName}`);
  await execa("docker", args, { stdio: "inherit" });
  await printAccessHints(opts);
}

/**
 * VA-451: pull-then-replace. The pull runs BEFORE the stop so a
 * failed pull (network, auth, manifest mismatch) leaves the existing
 * container running — we never take the dashboard down on a failed
 * upgrade attempt. The named volume is preserved across the
 * replacement; the dashboard's idempotent ALTER TABLE migrations
 * handle any column adds on the new container's next boot.
 */
async function dashUpgrade(opts: DashOptions): Promise<void> {
  console.log(`[runway dash] upgrade: pulling ${opts.image}`);
  try {
    await execa("docker", ["pull", opts.image], { stdio: "inherit" });
  } catch {
    throw new Error(
      `failed to pull ${opts.image}. ` +
        "The existing container is unchanged. " +
        "If the image is private, run `docker login ghcr.io` first.",
    );
  }

  const existing = await containerState(opts.containerName);
  if (existing === "running") {
    console.log(
      `[runway dash] upgrade: stopping ${opts.containerName}`,
    );
    await execa("docker", ["stop", opts.containerName], {
      stdio: "inherit",
    });
  }
  if (existing !== "absent") {
    console.log(
      `[runway dash] upgrade: removing ${opts.containerName} (volume ${opts.volumeName} kept)`,
    );
    await execa("docker", ["rm", opts.containerName], { stdio: "inherit" });
  }

  const args = buildDockerRunArgs(opts);
  console.log(`[runway dash] starting container ${opts.containerName}`);
  await execa("docker", args, { stdio: "inherit" });
  await printAccessHints(opts);
}

async function dashLogs(opts: DashOptions): Promise<void> {
  const args = ["logs"];
  if (opts.follow) args.push("-f");
  args.push(opts.containerName);
  try {
    await execa("docker", args, { stdio: "inherit" });
  } catch (err) {
    const e = err as ExecaError;
    // SIGINT during `docker logs -f` returns a non-zero exit; treat
    // it as a clean operator-driven cancel rather than a failure.
    if (opts.follow && e.signal === "SIGINT") return;
    throw err;
  }
}

async function dashStop(opts: DashOptions): Promise<void> {
  const state = await containerState(opts.containerName);
  if (state === "absent") {
    console.log(
      `[runway dash] container ${opts.containerName} is not present — nothing to stop.`,
    );
  } else {
    if (state === "running") {
      await execa("docker", ["stop", opts.containerName], {
        stdio: "inherit",
      });
    }
    await execa("docker", ["rm", opts.containerName], { stdio: "inherit" });
  }

  if (opts.purge) {
    console.log(`[runway dash] --purge: removing volume ${opts.volumeName}`);
    try {
      await execa("docker", ["volume", "rm", opts.volumeName], {
        stdio: "inherit",
      });
    } catch {
      console.log(
        `[runway dash] volume ${opts.volumeName} not present (already removed).`,
      );
    }
  } else {
    console.log(
      `[runway dash] volume ${opts.volumeName} kept — pass --purge to delete history.`,
    );
  }
}

/**
 * `docker inspect` reports `.State.Status` (`running`, `exited`,
 * `created`, etc.) when the container exists, and exits non-zero
 * otherwise. We collapse the status set to three buckets.
 */
async function containerState(
  name: string,
): Promise<"running" | "stopped" | "absent"> {
  try {
    const { stdout } = await execa("docker", [
      "inspect",
      "--format",
      "{{.State.Status}}",
      name,
    ]);
    return stdout.trim() === "running" ? "running" : "stopped";
  } catch {
    return "absent";
  }
}

async function printAccessHints(opts: DashOptions): Promise<void> {
  console.log("");
  console.log(`[runway dash] dashboard:  http://localhost:${opts.dashboardPort}`);
  console.log(
    `[runway dash] OTLP endpoint: http://localhost:${opts.otlpPort} (set as OTEL_EXPORTER_OTLP_ENDPOINT)`,
  );
  console.log("[runway dash] stop with: runway dash stop");
}
