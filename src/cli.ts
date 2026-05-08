import { loadConfig } from "./config.js";
import { createLinearGateway } from "./linear.js";
import { createGithubGateway } from "./github.js";
import { drainQueue } from "./orchestrator.js";

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
  runway [run] [--max N]

OPTIONS
  --max, -n N     Process at most N issues then exit. Default: drain queue.
  --help, -h      Show this help.

ENVIRONMENT
  See .sandcastle/.env.example for required + optional vars.
`);
}

async function main(): Promise<void> {
  // Allow `runway run` and bare `runway`. Drop the verb if present.
  const argv = process.argv.slice(2);
  const args = argv[0] === "run" ? argv.slice(1) : argv;

  const opts = parseArgs(args);
  const config = loadConfig();
  const linear = createLinearGateway(config);
  const github = createGithubGateway();

  console.log(
    `[runway] draining queue from team ${config.linearTeam} (status="${config.readyStatus}") against ${config.targetRepo}`,
  );
  const result = await drainQueue(
    { config, linear, github },
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
