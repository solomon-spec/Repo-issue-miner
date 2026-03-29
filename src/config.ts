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
    githubToken: process.env.GITHUB_TOKEN ?? byFlag.get("github-token"),
    geminiApiKey: process.env.GEMINI_API_KEY ?? byFlag.get("gemini-api-key"),
    geminiModel: process.env.GEMINI_MODEL ?? byFlag.get("gemini-model") ?? "gemini-2.5-flash",
    geminiApiBase: process.env.GEMINI_API_BASE ?? byFlag.get("gemini-api-base") ?? "https://generativelanguage.googleapis.com/v1beta",
    maxRepoSizeBytes: parseInteger(process.env.MAX_REPO_SIZE_BYTES ?? byFlag.get("max-repo-size-bytes"), 200 * 1024 * 1024),
    requestTimeoutMs: parseInteger(process.env.REQUEST_TIMEOUT_MS ?? byFlag.get("request-timeout-ms"), 45_000),
    buildTimeoutMs: parseInteger(process.env.BUILD_TIMEOUT_MS ?? byFlag.get("build-timeout-ms"), 20 * 60 * 1000),
    testTimeoutMs: parseInteger(process.env.TEST_TIMEOUT_MS ?? byFlag.get("test-timeout-ms"), 20 * 60 * 1000),
    workRoot: resolve(process.env.WORK_ROOT ?? byFlag.get("work-root") ?? `${homedir()}/repo-issue-miner-work`),
    outputRoot: resolve(process.env.OUTPUT_ROOT ?? byFlag.get("output-root") ?? `${process.cwd()}/output`),
    dbPath: resolve(process.env.DB_PATH ?? byFlag.get("db-path") ?? `${process.cwd()}/data/repo-miner.db`),
    port: parseInteger(process.env.PORT ?? byFlag.get("port"), 3000),
    minStars: parseInteger(process.env.MIN_STARS ?? byFlag.get("min-stars"), 50),
    repoLimit: parseInteger(process.env.REPO_LIMIT ?? byFlag.get("repo-limit"), 10),
    repoConcurrency: Math.max(1, parseInteger(process.env.REPO_CONCURRENCY ?? byFlag.get("repo-concurrency"), 2)),
    prLimit: parseInteger(process.env.PR_LIMIT ?? byFlag.get("pr-limit"), 10),
    mergedAfter: process.env.MERGED_AFTER ?? byFlag.get("merged-after"),
    languages: parseLanguages(process.env.LANGUAGES ?? byFlag.get("languages")),
    scanMode: parseScanMode(process.env.SCAN_MODE ?? byFlag.get("scan-mode")),
    targetRepo: process.env.TARGET_REPO ?? byFlag.get("target-repo"),
    dryRun: parseBooleanFlag(process.env.DRY_RUN ?? byFlag.get("dry-run"), false),
    keepWorktree: parseBooleanFlag(process.env.KEEP_WORKTREE ?? byFlag.get("keep-worktree"), false),
  };
}
