import { IssueRef, Language, PrAnalysis, PullRequestFile, PullRequestSummary, SearchRepo } from "./types.js";
import { unique } from "./util.js";

const SOURCE_EXTENSIONS: Record<Language, string[]> = {
  python: [".py"],
  javascript: [".js", ".jsx", ".mjs", ".cjs"],
  typescript: [".ts", ".tsx", ".mts", ".cts"],
};

const TEST_HINTS = [/^tests\//i, /__tests__/i, /(^|[._-])(test|spec)([._-]|\.)/i, /test(s)?\//i];
const IGNORE_PATTERNS = [
  /^docs\//i,
  /^\.github\//i,
  /^examples\//i,
  /^fixtures\//i,
  /^coverage\//i,
  /^dist\//i,
  /^build\//i,
  /^vendor\//i,
  /^node_modules\//i,
  /\.(md|txt|rst)$/i,
  /(^|\/)package-lock\.json$/i,
  /(^|\/)pnpm-lock\.yaml$/i,
  /(^|\/)yarn\.lock$/i,
  /(^|\/)poetry\.lock$/i,
  /(^|\/)uv\.lock$/i,
  /(^|\/)bun\.lockb$/i,
  /\.(snap|png|jpg|jpeg|gif|svg|ico|map)$/i,
];

const CLOSING_KEYWORD_REGEX = /(close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#(\d+)/gi;
function extensionFor(path: string): string {
  const basename = path.split("/").at(-1) ?? path;
  const dot = basename.lastIndexOf(".");
  return dot >= 0 ? basename.slice(dot).toLowerCase() : "";
}

function isIgnored(path: string): boolean {
  return IGNORE_PATTERNS.some((pattern) => pattern.test(path));
}

function isTestFile(path: string): boolean {
  return TEST_HINTS.some((pattern) => pattern.test(path));
}

function isRelevantSource(path: string, language: Language): boolean {
  return SOURCE_EXTENSIONS[language].includes(extensionFor(path));
}

function touchedDirectory(path: string): string {
  const parts = path.split("/");
  return parts.length > 1 ? parts.slice(0, -1).join("/") : ".";
}

export function chooseLanguageBucket(repo: SearchRepo, requestedLanguages: Language[]): Language | undefined {
  const primary = repo.primaryLanguage?.toLowerCase();
  if (primary === "python" && requestedLanguages.includes("python")) return "python";
  if (primary === "javascript" && requestedLanguages.includes("javascript")) return "javascript";
  if (primary === "typescript" && requestedLanguages.includes("typescript")) return "typescript";
  return requestedLanguages[0];
}

export function analyzePullRequestFiles(files: PullRequestFile[], language: Language): PrAnalysis {
  const relevantSourceFiles: PullRequestFile[] = [];
  const relevantTestFiles: PullRequestFile[] = [];
  const ignoredFiles: string[] = [];
  const touchedDirectories: string[] = [];
  const scoreReasons: string[] = [];
  let score = 0;

  for (const file of files) {
    if (isIgnored(file.filename)) {
      ignoredFiles.push(file.filename);
      continue;
    }
    if (!isRelevantSource(file.filename, language)) {
      continue;
    }
    if (isTestFile(file.filename)) {
      relevantTestFiles.push(file);
    } else {
      relevantSourceFiles.push(file);
    }
    touchedDirectories.push(touchedDirectory(file.filename));
  }

  const uniqueDirs = unique(touchedDirectories);
  if (relevantSourceFiles.length >= 5) {
    score += 3;
    scoreReasons.push(`touches ${relevantSourceFiles.length} relevant source files`);
  }
  if (uniqueDirs.length >= 2) {
    score += 2;
    scoreReasons.push(`spans ${uniqueDirs.length} directories`);
  }
  if (relevantTestFiles.length > 0) {
    score += 2;
    scoreReasons.push(`changes ${relevantTestFiles.length} test files`);
  }
  if (relevantSourceFiles.length === 0 && relevantTestFiles.length > 0) {
    score -= 2;
    scoreReasons.push("test-only change");
  }
  if (ignoredFiles.length > files.length / 2) {
    score -= 3;
    scoreReasons.push("mostly docs, generated, or lock files");
  }
  if (/^(chore|docs|typo|format|lint|refactor)\b/i.test(relevantSourceFiles[0]?.filename ?? "")) {
    score -= 1;
    scoreReasons.push("looks mechanically scoped");
  }

  const accepted = relevantSourceFiles.length >= 5 && score >= 5;
  return {
    relevantSourceFiles,
    relevantTestFiles,
    touchedDirectories: uniqueDirs,
    ignoredFiles,
    nonTrivialScore: score,
    nonTrivialReasons: scoreReasons,
    accepted,
  };
}

export function extractIssueReferences(pr: PullRequestSummary, repo: SearchRepo): IssueRef[] {
  const found: IssueRef[] = [];
  const closingMatches = pr.body.matchAll(CLOSING_KEYWORD_REGEX);
  for (const match of closingMatches) {
    const repoRef = match[2];
    const number = Number(match[3]);
    const [owner, name] = repoRef ? repoRef.split("/") : [repo.owner, repo.name];
    found.push({ owner, repo: name, number, linkType: "pr_keyword" });
  }

  const seen = new Set<string>();
  return found.filter((ref) => {
    const key = `${ref.owner}/${ref.repo}#${ref.number}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
