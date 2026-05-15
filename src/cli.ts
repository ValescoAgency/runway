#!/usr/bin/env node
import { dashCommand, printDashUsage } from "./commands/dash.js";
import { doctorCommand, printDoctorUsage } from "./commands/doctor.js";
import { initCommand, printInitUsage } from "./commands/init.js";
import { reviewCommand, printReviewUsage } from "./commands/review.js";
import { runCommand, printRunUsage } from "./commands/run.js";
import { upgradeCommand, printUpgradeUsage } from "./commands/upgrade.js";
import {
  upgradeRepoCommand,
  printUpgradeRepoUsage,
} from "./commands/upgrade-repo.js";

interface Subcommand {
  readonly name: string;
  readonly summary: string;
  readonly run: (argv: readonly string[]) => Promise<void>;
  readonly help: () => void;
}

const SUBCOMMANDS: readonly Subcommand[] = [
  {
    name: "dash",
    summary: "Operate the runway operations dashboard (up / logs / stop).",
    run: dashCommand,
    help: printDashUsage,
  },
  {
    name: "doctor",
    summary: "Read-only preflight: tooling, env, repo state, agent image.",
    run: doctorCommand,
    help: printDoctorUsage,
  },
  {
    name: "init",
    summary: "Scaffold a target repo (sandcastle init + varlock layer).",
    run: initCommand,
    help: printInitUsage,
  },
  {
    name: "review",
    summary: "Run an IRA retrospective pass (run / drain / weekly).",
    run: reviewCommand,
    help: printReviewUsage,
  },
  {
    name: "run",
    summary: "Drain a Linear queue against the cwd repo (default verb).",
    run: runCommand,
    help: printRunUsage,
  },
  {
    name: "upgrade",
    summary: "Update the runway CLI itself (git pull + pnpm install).",
    run: upgradeCommand,
    help: printUpgradeUsage,
  },
  {
    name: "upgrade-repo",
    summary: "Refresh a target repo's runway scaffold against current templates.",
    run: upgradeRepoCommand,
    help: printUpgradeRepoUsage,
  },
];

function printRootUsage(): void {
  console.log(`runway — Linear-driven coding agent orchestrator

USAGE
  runway <command> [options]

COMMANDS`);
  for (const cmd of SUBCOMMANDS) {
    console.log(`  ${cmd.name.padEnd(13)} ${cmd.summary}`);
  }
  console.log(`
  Run \`runway <command> --help\` for command-specific options.

GLOBAL
  --help, -h     Show this help.
  --version, -V  Show version.
`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    printRootUsage();
    process.exit(0);
  }
  if (argv[0] === "--version" || argv[0] === "-V") {
    // Read package.json at runtime — single source of truth.
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      await readFile(join(here, "..", "package.json"), "utf8"),
    );
    console.log(pkg.version);
    process.exit(0);
  }

  // First arg may be a subcommand name. If it isn't, treat the whole
  // argv as `run <argv>` (back-compat: `runway --max 3` still works).
  const first = argv[0];
  const matched = SUBCOMMANDS.find((c) => c.name === first);
  if (matched) {
    await matched.run(argv.slice(1));
  } else {
    // Implicit `run` — back-compat for old invocations.
    await runCommand(argv);
  }
}

main().catch((err) => {
  console.error("[runway] fatal:", err instanceof Error ? err.message : err);
  console.error("[runway:exit] status=failure");
  process.exit(1);
});
