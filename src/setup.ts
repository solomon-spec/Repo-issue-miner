import { RepoSnapshot, SearchRepo, SetupProfile, SetupTargetType } from "./types.js";
import { runCommand } from "./util.js";

type SetupPromptTarget = {
  targetType: SetupTargetType;
  targetLabel: string;
  issueNumber?: number;
  issueTitle?: string;
  issueBody?: string;
  issueUrl?: string;
  pullRequestNumber?: number;
  pullRequestTitle?: string;
  pullRequestUrl?: string;
};

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

export function normalizeRelativeSetupPath(raw: string): string {
  const unixPath = raw.trim().replace(/\\/g, "/");
  if (!unixPath) {
    throw new Error("path cannot be empty");
  }
  if (unixPath.startsWith("/") || /^[A-Za-z]:\//.test(unixPath)) {
    throw new Error(`path must be relative: ${raw}`);
  }
  const segments = unixPath.split("/").filter(Boolean);
  if (!segments.length || segments.some((segment) => segment === "..")) {
    throw new Error(`path must stay inside the repository: ${raw}`);
  }
  return segments.filter((segment) => segment !== ".").join("/");
}

export function parseSetupPathList(value: unknown): string[] {
  const source = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : (typeof value === "string" ? value.split(/\r?\n/g) : []);
  const unique = new Set<string>();
  for (const item of source) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    unique.add(normalizeRelativeSetupPath(trimmed));
  }
  return [...unique];
}

function globToRegExp(pattern: string): RegExp {
  const normalized = normalizeRelativeSetupPath(pattern);
  const parts: string[] = ["^"];
  for (let index = 0; index < normalized.length; index += 1) {
    const current = normalized[index];
    const next = normalized[index + 1];
    if (current === "*" && next === "*") {
      parts.push(".*");
      index += 1;
      continue;
    }
    if (current === "*") {
      parts.push("[^/]*");
      continue;
    }
    parts.push(escapeRegExp(current));
  }
  parts.push("$");
  return new RegExp(parts.join(""));
}

function patternMatchesPath(pattern: string, file: string): boolean {
  if (!pattern.includes("*")) {
    return normalizeRelativeSetupPath(pattern) === file;
  }
  return globToRegExp(pattern).test(file);
}

export function expandSetupPathPatterns(files: string[], patterns: string[]): string[] {
  if (!patterns.length) return [];
  const matches = new Set<string>();
  for (const pattern of patterns) {
    for (const file of files) {
      if (patternMatchesPath(pattern, file)) {
        matches.add(file);
      }
    }
  }
  return [...matches].sort((left, right) => left.localeCompare(right));
}

export function isPathAllowedByPatterns(file: string, patterns: string[]): boolean {
  if (!patterns.length) return true;
  return patterns.some((pattern) => patternMatchesPath(pattern, file));
}

export function buildSetupPrompt(
  repo: SearchRepo,
  snapshot: RepoSnapshot,
  profile: Pick<SetupProfile, "prompt" | "contextPaths" | "writablePaths" | "validationPrompt">,
  target: SetupPromptTarget,
): string {
  const contextFiles = expandSetupPathPatterns(snapshot.files, profile.contextPaths).slice(0, 80);
  const missingPatterns = profile.contextPaths.filter((pattern) => !contextFiles.some((file) => patternMatchesPath(pattern, file)));

  const sections = [
    `You are working in a local checkout of the GitHub repository ${repo.fullName}.`,
    `The checkout is already positioned at commit ${snapshot.sha}.`,
    `Setup target: ${target.targetLabel}.`,
    "This is the setup phase only. Do not implement the issue itself.",
    "Do not create commits yourself. The platform will configure git author details and create the setup commit after validation.",
    "",
    "Goal:",
    profile.prompt.trim(),
  ];

  if (target.targetType === "issue") {
    if (target.pullRequestNumber) {
      sections.push(
        "",
        `This setup snapshot intentionally uses the linked fix PR base/pre-fix commit from PR #${target.pullRequestNumber}${target.pullRequestTitle ? `: ${target.pullRequestTitle}` : ""}${target.pullRequestUrl ? ` (${target.pullRequestUrl})` : ""}.`,
      );
    }
  }

  if (contextFiles.length) {
    sections.push("", "Read these files first before making changes:");
    sections.push(...contextFiles.map((file) => `- ${file}`));
  }

  if (missingPatterns.length) {
    sections.push("", "These requested context paths were not present in the checkout:");
    sections.push(...missingPatterns.map((file) => `- ${file}`));
  }

  if (profile.writablePaths.length) {
    sections.push("", "Only create or modify files that match these paths or glob patterns:");
    sections.push(...profile.writablePaths.map((file) => `- ${file}`));
    sections.push("If you believe another file must change, explain that in the final summary instead of editing it.");
  }

  if (profile.validationPrompt.trim()) {
    sections.push("", "Before finishing, validate your work using this guidance:");
    sections.push(profile.validationPrompt.trim());
  }

  sections.push(
    "",
    "Finish with a concise summary that includes:",
    "1. Files changed",
    "2. Commands run and whether they passed",
    "3. Any remaining blockers or manual follow-up",
  );

  return `${sections.join("\n")}\n`;
}

export async function collectChangedFiles(worktreePath: string): Promise<string[]> {
  const result = await runCommand({
    cmd: "git",
    args: ["status", "--short"],
    cwd: worktreePath,
  });
  if (result.code !== 0) {
    throw new Error(`git status failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

export async function writeGitDiff(worktreePath: string, diffPath: string, options: { cached?: boolean } = {}): Promise<void> {
  const result = await runCommand({
    cmd: "git",
    args: ["diff", "--no-ext-diff", "--binary", ...(options.cached ? ["--cached"] : [])],
    cwd: worktreePath,
    stdoutPath: diffPath,
  });
  if (result.code !== 0) {
    throw new Error(`git diff failed: ${result.stderr || result.stdout}`);
  }
}
