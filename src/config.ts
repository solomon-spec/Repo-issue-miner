import { homedir } from "node:os";
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { Config, Language, ScanMode } from "./types.js";
import { parseBooleanFlag, parseInteger } from "./util.js";

loadDotenv();

function parseLanguages(raw: string | undefined): Language[] {
  const value = (raw ?? "python,javascript,typescript").toLowerCase();
  const items = value.split(",").map((part) => part.trim()).filter(Boolean);
  const valid: Language[] = [];
  for (const item of items) {
    if (item === "python" || item === "javascript" || item === "typescript") {
      valid.push(item);
    }
  }
  return valid.length > 0 ? valid : ["python", "javascript", "typescript"];
}

function parseScanMode(raw: string | undefined): ScanMode {
  return raw === "pr-first" ? "pr-first" : "issue-first";
}

export function loadConfig(argv: string[] = []): Config {
  const byFlag = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];
    if (current?.startsWith("--") && next && !next.startsWith("--")) {
      byFlag.set(current.slice(2), next);
    }
    if (current?.startsWith("--") && (!next || next.startsWith("--"))) {
      byFlag.set(current.slice(2), "true");
    }
  }

  return {
    githubToken: byFlag.get("github-token") ?? process.env.GITHUB_TOKEN,
    geminiApiKey: byFlag.get("gemini-api-key") ?? process.env.GEMINI_API_KEY,
    geminiModel: byFlag.get("gemini-model") ?? process.env.GEMINI_MODEL ?? "gemini-2.5-flash",
    geminiApiBase: byFlag.get("gemini-api-base") ?? process.env.GEMINI_API_BASE ?? "https://generativelanguage.googleapis.com/v1beta",
    maxRepoSizeBytes: parseInteger(byFlag.get("max-repo-size-bytes") ?? process.env.MAX_REPO_SIZE_BYTES, 200 * 1024 * 1024),
    requestTimeoutMs: parseInteger(byFlag.get("request-timeout-ms") ?? process.env.REQUEST_TIMEOUT_MS, 45_000),
    buildTimeoutMs: parseInteger(byFlag.get("build-timeout-ms") ?? process.env.BUILD_TIMEOUT_MS, 20 * 60 * 1000),
    testTimeoutMs: parseInteger(byFlag.get("test-timeout-ms") ?? process.env.TEST_TIMEOUT_MS, 20 * 60 * 1000),
    workRoot: resolve(byFlag.get("work-root") ?? process.env.WORK_ROOT ?? `${homedir()}/repo-issue-miner-work`),
    outputRoot: resolve(byFlag.get("output-root") ?? process.env.OUTPUT_ROOT ?? `${process.cwd()}/output`),
    dbPath: resolve(byFlag.get("db-path") ?? process.env.DB_PATH ?? `${process.cwd()}/data/repo-miner.db`),
    host: byFlag.get("host") ?? process.env.HOST ?? "127.0.0.1",
    port: parseInteger(byFlag.get("port") ?? process.env.PORT, 3000),
    minStars: parseInteger(byFlag.get("min-stars") ?? process.env.MIN_STARS, 50),
    repoLimit: parseInteger(byFlag.get("repo-limit") ?? process.env.REPO_LIMIT, 10),
    repoConcurrency: Math.max(1, parseInteger(byFlag.get("repo-concurrency") ?? process.env.REPO_CONCURRENCY, 2)),
    prLimit: parseInteger(byFlag.get("pr-limit") ?? process.env.PR_LIMIT, 10),
    mergedAfter: byFlag.get("merged-after") ?? process.env.MERGED_AFTER,
    languages: parseLanguages(byFlag.get("languages") ?? process.env.LANGUAGES),
    scanMode: parseScanMode(byFlag.get("scan-mode") ?? process.env.SCAN_MODE),
    targetRepo: byFlag.get("target-repo") ?? process.env.TARGET_REPO,
    dryRun: parseBooleanFlag(byFlag.get("dry-run") ?? process.env.DRY_RUN, false),
    keepWorktree: parseBooleanFlag(byFlag.get("keep-worktree") ?? process.env.KEEP_WORKTREE, false),
  };
}
