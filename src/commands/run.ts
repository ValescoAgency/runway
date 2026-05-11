import { loadConfig } from "../config.js";
import { createLinearGateway } from "../linear.js";
import { createGithubGateway } from "../github.js";
import {
  assertSandcastleInitialised,
  drainQueue,
} from "../orchestrator.js";

export interface RunOptions {
  readonly max?: number;
  readonly project?: string;
  readonly allowPaths?: readonly string[];
}

export function parseRunArgs(argv: readonly string[]): RunOptions {
  const opts: {
    max?: number;
    project?: string;
    allowPaths?: string[];
  } = {};
  const collectAllow = (raw: string): void => {
    const paths = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (paths.length === 0) {
      throw new Error("--allow-paths requires at least one glob");
    }
    opts.allowPaths = [...(opts.allowPaths ?? []), ...paths];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--max" || a === "-n") {
      const v = argv[i + 1];
      if (!v) throw new Error("--max requires a number");
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`--max must be a positive integer, got "${v}"`);
      }
      opts.max = n;
      i += 1;
    } else if (a === "--project") {
      const v = argv[i + 1];
      if (!v) throw new Error("--project requires a value");
      opts.project = v;
      i += 1;
    } else if (a?.startsWith("--project=")) {
      opts.project = a.slice("--project=".length);
    } else if (a === "--allow-paths") {
      const v = argv[i + 1];
      if (!v) throw new Error("--allow-paths requires a value");
      collectAllow(v);
      i += 1;
    } else if (a?.startsWith("--allow-paths=")) {
      collectAllow(a.slice("--allow-paths=".length));
    } else if (a === "--help" || a === "-h") {
      printRunUsage();
      process.exit(0);
    } else if (a) {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return opts;
}

export function printRunUsage(): void {
  console.log(`runway run — drain a Linear queue against the cwd repo

USAGE
  cd /path/to/your/repo
  runway run [--max N]

OPTIONS
  --max, -n N     Attempt at most N issues then exit (counts every
                  attempt — success, HITL, or revert-to-Todo).
                  Default: drain queue.
  --project ID    Scope the queue to a single Linear project under the
                  team. Accepts project UUID, slug, or name. Overrides
                  RUNWAY_LINEAR_PROJECT. Default: team-wide.
  --allow-paths GLOBS
                  Comma-separated globs removed from the impl policy's
                  forbidden-paths list for this invocation only.
                  Example: --allow-paths='.github/workflows/**' lets
                  the agent touch CI for issues whose AC require it.
                  Repeatable; pairs with .runway/policy.yml.
  --help, -h      Show this help.

ENVIRONMENT
  LINEAR_API_KEY              required
  RUNWAY_LINEAR_TEAM          default "VA"
  RUNWAY_LINEAR_PROJECT       optional — scope to one project
  RUNWAY_BASE_BRANCH          optional — override the auto-detected base
                              branch (the branch runway diffs against
                              and targets with PRs). Detected from
                              origin/HEAD when unset.
  RUNWAY_READY_STATUS         default "Todo"
  RUNWAY_IN_PROGRESS_STATUS   default "In Progress"
  RUNWAY_IN_REVIEW_STATUS     default "In Review"
  RUNWAY_HITL_LABEL           default "ready-for-human"
  RUNWAY_MAX_ITERATIONS       default 5
`);
}

export async function runCommand(argv: readonly string[]): Promise<void> {
  const opts = parseRunArgs(argv);
  const cwd = process.cwd();
  assertSandcastleInitialised(cwd);

  const baseConfig = loadConfig();
  const config = opts.project
    ? { ...baseConfig, linearProject: opts.project }
    : baseConfig;
  const linear = createLinearGateway(config);
  const github = createGithubGateway();

  const scope = config.linearProject
    ? `team ${config.linearTeam} / project ${config.linearProject}`
    : `team ${config.linearTeam}`;
  console.log(
    `[runway] draining queue from ${scope} (status="${config.readyStatus}") against ${cwd}`,
  );
  const result = await drainQueue(
    { config, linear, github, cwd },
    { max: opts.max, allowPaths: opts.allowPaths },
  );
  console.log(
    `[runway] done — attempts=${result.attempts} opened=${result.opened} hitl=${result.hitl} errored=${result.errored}`,
  );
}
