import { networkInterfaces } from "node:os";
import { loadConfig } from "./config.js";
import { getDb, resetDatabase } from "./db.js";
import { runScan } from "./pipeline.js";
import { createApp } from "./server.js";

function printUsage(): void {
  console.log(`repo-issue-miner

Usage:
  node dist/index.js [command] [options]

Commands:
  serve           Start the web dashboard (default)
  scan            Run a scan from the CLI
  clean-db        Remove all persisted scan data from the configured SQLite DB

Scan Options:
  --languages python,javascript,typescript
  --repo-limit 10
  --repo-concurrency 2
  --pr-limit 10
  --min-stars 200
  --merged-after 2024-01-01
  --scan-mode issue-first|pr-first
  --target-repo owner/name
  --work-root /tmp/repo-issue-miner
  --output-root ./output
  --db-path ./data/repo-miner.db
  --dry-run [true|false]
  --keep-worktree

Server Options:
  --host 127.0.0.1
  --port 3000
  --db-path ./data/repo-miner.db
  --setup-clone-root ~/Documents/pr-writer-tasks
  --codex-cli-path /absolute/path/to/codex
`);
}

function displayServerUrls(host: string, port: number): string[] {
  if (host !== "0.0.0.0" && host !== "::") {
    const displayHost = host === "127.0.0.1" ? "localhost" : host;
    return [`http://${displayHost}:${port}`];
  }

  const urls = new Set<string>([`http://localhost:${port}`]);
  const interfaces = networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== "IPv4") {
        continue;
      }
      urls.add(`http://${entry.address}:${port}`);
    }
  }
  return Array.from(urls);
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const firstArg = rawArgs[0];
  if (firstArg === "--help" || firstArg === "-h") {
    printUsage();
    return;
  }

  const command = firstArg === "scan" || firstArg === "serve" || firstArg === "clean-db" || firstArg === "reset-db"
    ? firstArg
    : undefined;
  const args = command ? rawArgs.slice(1) : rawArgs;
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

  if (command === "clean-db" || command === "reset-db") {
    const db = getDb(config.dbPath);
    resetDatabase(db);
    console.log(`Cleared database at ${config.dbPath}`);
    return;
  }

  // Default: start web server
  const app = createApp(config);
  app.listen(config.port, config.host, () => {
    const urls = displayServerUrls(config.host, config.port);
    console.log("🚀 repo-issue-miner dashboard running at:");
    for (const url of urls) {
      console.log(`   ${url}`);
    }
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
