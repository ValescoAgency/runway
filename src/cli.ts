import { loadConfig } from "./config.js";
import { createLinearGateway } from "./linear.js";
import { createGithubGateway } from "./github.js";
import {
  assertSandcastleInitialised,
  drainQueue,
} from "./orchestrator.js";

interface CliOptions {
  readonly max?: number;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const opts: { max?: number } = {};
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
    } else if (a === "--help" || a === "-h") {
      printUsage();
      process.exit(0);
    } else if (a) {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return opts;
}

function printUsage(): void {
  console.log(`runway — Linear-driven coding agent orchestrator

USAGE
  cd /path/to/your/repo
  runway [run] [--max N]

PREREQUISITES
  - The current directory must be a git repo with a .sandcastle/
    directory. Run \`npx sandcastle init\` once per target repo.
  - Docker Desktop (or Podman) running.
  - \`gh\` CLI authenticated (\`gh auth status\`).
  - LINEAR_API_KEY exported in your shell.

OPTIONS
  --max, -n N     Process at most N issues then exit. Default: drain queue.
  --help, -h      Show this help.

ENVIRONMENT
  LINEAR_API_KEY              required
  RUNWAY_LINEAR_TEAM          default "VA"
  RUNWAY_READY_STATUS         default "Todo"
  RUNWAY_IN_PROGRESS_STATUS   default "In Progress"
  RUNWAY_IN_REVIEW_STATUS     default "In Review"
  RUNWAY_HITL_LABEL           default "needs-human"
  RUNWAY_MAX_ITERATIONS       default 5
`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = argv[0] === "run" ? argv.slice(1) : argv;

  const opts = parseArgs(args);
  const cwd = process.cwd();
  assertSandcastleInitialised(cwd);

  const config = loadConfig();
  const linear = createLinearGateway(config);
  const github = createGithubGateway();

  console.log(
    `[runway] draining queue from team ${config.linearTeam} (status="${config.readyStatus}") against ${cwd}`,
  );
  const result = await drainQueue(
    { config, linear, github, cwd },
    { max: opts.max },
  );
  console.log(
    `[runway] done — processed=${result.processed} opened=${result.opened} hitl=${result.hitl} errored=${result.errored}`,
  );
}

main().catch((err) => {
  console.error("[runway] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
