import { loadConfig } from "./config.js";
import { runScan } from "./pipeline.js";
import { createApp } from "./server.js";

function printUsage(): void {
  console.log(`repo-issue-miner

Usage:
  node dist/index.js [command] [options]

Commands:
  serve           Start the web dashboard (default)
  scan            Run a scan from the CLI

Scan Options:
  --languages python,javascript,typescript
  --repo-limit 10
  --repo-concurrency 2
  --pr-limit 10
  --min-stars 50
  --merged-after 2024-01-01
  --scan-mode issue-first|pr-first
  --target-repo owner/name
  --work-root /tmp/repo-issue-miner
  --output-root ./output
  --db-path ./data/repo-miner.db
  --dry-run
  --keep-worktree

Server Options:
  --port 3000
  --db-path ./data/repo-miner.db
`);
}

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  if (command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  const config = loadConfig(args);

  if (command === "scan") {
    const report = await runScan(config, (msg) => console.log(msg));

    console.log(JSON.stringify({
      scanId: report.scanId,
      startedAt: report.startedAt,
      finishedAt: report.finishedAt,
      totalDurationMs: report.totalDurationMs,
      performanceMetrics: report.performanceMetrics,
      accepted: report.accepted.length,
      rejected: report.rejected.length,
      acceptedRepos: report.accepted.map((item) => ({
        repo: item.repo.fullName,
        pr: item.pullRequest.number,
        issueCount: item.issueRefs.length,
        preFixSha: item.preFixSha,
        testsUnableToRun: item.testsUnableToRun,
        timings: item.timings,
      })),
    }, null, 2));
    return;
  }

  // Default: start web server
  const app = createApp(config);
  app.listen(config.port, () => {
    console.log(`🚀 repo-issue-miner dashboard running at http://localhost:${config.port}`);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
