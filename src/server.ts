import express from "express";
import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CodexAxisName,
  CodexAxisPreference,
  CodexIssueSource,
  CodexPrContext,
  CodexReviewDraft,
  CodexTaskRound,
  CodexTaskState,
  Config,
  ExecutionResult,
  Language,
  PromptDraft,
  ScanConfigOverrides,
  ScanLiveProgress,
  ScanPerformanceMetrics,
  ScanStatus,
  SearchRepo,
  TestPlan,
} from "./types.js";
import { runScan } from "./pipeline.js";
import { cleanupSnapshot, prepareSnapshot } from "./git.js";
import { executeTestPlan, executeTestPlanWithTests } from "./docker.js";
import { fixDockerfileForTestFailure, generateDockerfileForTests, resolveTestPlan } from "./gemini.js";
import { GitHubClient } from "./github.js";
import {
  createSetupProfile,
  createSetupRun,
  deleteRepo,
  deleteSetupProfile,
  getAcceptedCandidates,
  getDb,
  getIssueRecordById,
  getIssues,
  getIssuesForCandidate,
  getIssuesForCandidateIds,
  getRepoById,
  getRepoRecordById,
  getRepos,
  getScanById,
  getScanCandidateById,
  getScans,
  getSetupProfileById,
  getSetupProfiles,
  getSetupRunById,
  getSetupRuns,
  getStats,
  getTestsUnableCandidates,
  refreshScanCounts,
  updateScanCandidateState,
  updateSetupProfile,
} from "./db.js";
import {
  buildCodexReviewPrompt,
  buildFollowUpPrompt,
  buildPromptOne,
  buildTmuxSessionInfo,
  CODEX_AXIS_NAMES,
  CODEX_TASK_MAX_PROMPTS,
  createFallbackReviewDraft,
  makePromptDraft,
  parseCodexReviewOutput,
  summarizePullRequestFiles,
  writeReviewBundle,
} from "./codex-task.js";
import { parseSetupPathList } from "./setup.js";
import { pickPreferredSetupProfile } from "./setup-profiles.js";
import { ActiveSetupRunState, appendSetupRunLog, runSetupTask, setupRunStateToApi, type SetupTaskTarget } from "./setup-runner.js";
import { cleanupProjectStorage } from "./storage.js";
import { CommandAbortedError, ensureDir, readUtf8Safe, runCommand, unique, writeJson } from "./util.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

type ActiveScanState = {
  promise?: Promise<unknown>;
  logs: string[];
  status: ScanStatus;
  currentStage: string;
  summary: ScanLiveProgress;
  startedAt: string;
  finishedAt?: string;
  scanId?: number;
  metrics?: ScanPerformanceMetrics;
};

type ActiveTestRerunState = {
  candidateId: number;
  status: "running" | "completed" | "failed" | "stopped";
  stage: string;
  startedAt: string;
  finishedAt?: string;
  logs: string[];
  liveOutput: string;
  stopRequested: boolean;
  abortController: AbortController;
  dockerfileOverride?: { path: string; contentBytes: number; sha256: string } | null;
  error?: string;
};

type ActiveAcceptedTestRunState = ActiveTestRerunState;

type ActiveCodexReviewRunState = {
  candidateId: number;
  round: number;
  status: "running" | "completed" | "failed";
  stage: string;
  startedAt: string;
  finishedAt?: string;
  logs: string[];
  liveOutput: string;
  artifactDir?: string;
  error?: string;
};

let activeScan: ActiveScanState | undefined;
const activeTestRerunStates = new Map<number, ActiveTestRerunState>();
const activeAcceptedTestRunStates = new Map<number, ActiveAcceptedTestRunState>();
const activeCodexReviewRunStates = new Map<string, ActiveCodexReviewRunState>();
const activeSetupRunStates = new Map<number, ActiveSetupRunState>();
const EXECUTION_REASON_PREFIXES = [
  "failed to prepare snapshot",
  "snapshot exceeds max size:",
  "could not infer a Docker build plan",
  "could not infer safe Docker test plan",
  "Docker build failed at pre-fix snapshot",
  "tests failed at pre-fix snapshot",
];

class RequestValidationError extends Error {}

function appendScanLog(scan: ActiveScanState, msg: string): void {
  const timestamp = new Date().toISOString();
  scan.logs.push(`[${timestamp}] ${msg}`);
  scan.currentStage = msg;

  if (!scan.scanId) {
    const match = msg.match(/Scan #(\d+)/);
    if (match) {
      scan.scanId = Number(match[1]);
    }
  }
}

function emptyScanSummary(): ScanLiveProgress {
  return {
    totalReposDiscovered: 0,
    totalReposProcessed: 0,
    totalPullRequestsAnalyzed: 0,
    totalCandidatesRecorded: 0,
    acceptedCount: 0,
    rejectedCount: 0,
  };
}

function appendTestRerunLog(rerun: ActiveTestRerunState, msg: string): void {
  const timestamp = new Date().toISOString();
  rerun.logs.push(`[${timestamp}] ${msg}`);
  rerun.stage = msg;
  if (rerun.logs.length > 200) {
    rerun.logs.splice(0, rerun.logs.length - 200);
  }
}

function appendTestRerunOutput(
  rerun: ActiveTestRerunState,
  phase: "build" | "test",
  stream: "stdout" | "stderr",
  chunk: string,
): void {
  const text = chunk.replace(/\r\n/g, "\n");
  const prefixed = text
    .split("\n")
    .map((line, index, items) => {
      if (!line && index === items.length - 1) return "";
      return `[${phase}:${stream}] ${line}`;
    })
    .join("\n");
  rerun.liveOutput = `${rerun.liveOutput}${prefixed}${prefixed.endsWith("\n") ? "" : "\n"}`.slice(-120_000);
}

function codexReviewRunKey(candidateId: number, round: number): string {
  return `${candidateId}:${round}`;
}

function appendCodexReviewLog(run: ActiveCodexReviewRunState, msg: string): void {
  const timestamp = new Date().toISOString();
  run.logs.push(`[${timestamp}] ${msg}`);
  run.stage = msg;
  if (run.logs.length > 300) {
    run.logs.splice(0, run.logs.length - 300);
  }
}

function appendCodexReviewOutput(run: ActiveCodexReviewRunState, stream: "stdout" | "stderr", chunk: string): void {
  const text = chunk.replace(/\r\n/g, "\n");
  const prefixed = text
    .split("\n")
    .map((line, index, items) => {
      if (!line && index === items.length - 1) return "";
      return `[codex:${stream}] ${line}`;
    })
    .join("\n");
  run.liveOutput = `${run.liveOutput}${prefixed}${prefixed.endsWith("\n") ? "" : "\n"}`.slice(-120_000);
}

function codexReviewStateToApi(run: ActiveCodexReviewRunState): Record<string, unknown> {
  return {
    candidateId: run.candidateId,
    round: run.round,
    running: run.status === "running",
    status: run.status,
    stage: run.stage,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt ?? null,
    logs: run.logs,
    liveOutput: run.liveOutput,
    artifactDir: run.artifactDir ?? null,
    error: run.error ?? null,
  };
}

function rerunStateToApi(rerun: ActiveTestRerunState): Record<string, unknown> {
  return {
    candidateId: rerun.candidateId,
    running: rerun.status === "running",
    status: rerun.status,
    stage: rerun.stage,
    startedAt: rerun.startedAt,
    finishedAt: rerun.finishedAt ?? null,
    logs: rerun.logs,
    liveOutput: rerun.liveOutput,
    stopRequested: rerun.stopRequested,
    dockerfileOverride: rerun.dockerfileOverride ?? null,
    error: rerun.error ?? null,
  };
}

function safeParseJson<T>(value: string | undefined | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function readLogExcerpt(path: string | undefined, maxChars = 6000): string | undefined {
  if (!path) return undefined;
  const text = readUtf8Safe(path);
  if (!text) return undefined;
  if (text.length <= maxChars) return text;
  return `... [showing last ${maxChars} chars]\n${text.slice(-maxChars)}`;
}

function latestExecutionDetails(details: Record<string, unknown>): Record<string, unknown> {
  const acceptedTest = asRecord(details.acceptedTest);
  const acceptedLastRun = asRecord(acceptedTest?.lastRun);
  const acceptedExecution = asRecord(acceptedLastRun?.execution);
  const rerun = asRecord(details.rerun);
  const rerunExecution = asRecord(rerun?.execution);
  return acceptedExecution ?? rerunExecution ?? (asRecord(details.execution) ?? {});
}

function candidateRowToApi(row: any): any {
  const details = safeParseJson<Record<string, unknown>>(row.details_json, {});
  const execution = latestExecutionDetails(details);
  const logFiles = [
    { label: "Build stderr", path: typeof execution.buildStderrPath === "string" ? execution.buildStderrPath : undefined },
    { label: "Build stdout", path: typeof execution.buildStdoutPath === "string" ? execution.buildStdoutPath : undefined },
    { label: "Test stderr", path: typeof execution.testStderrPath === "string" ? execution.testStderrPath : undefined },
    { label: "Test stdout", path: typeof execution.testStdoutPath === "string" ? execution.testStdoutPath : undefined },
  ]
    .map((item) => ({ ...item, excerpt: readLogExcerpt(item.path) }))
    .filter((item) => item.excerpt);

  return {
    ...row,
    rejection_reasons: safeParseJson<string[]>(row.rejection_reasons, []),
    details,
    logFiles,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => typeof item === "string" ? item.trim() : "")
    .filter(Boolean);
}

function normalizeCodexAxisPreference(
  value: unknown,
  fallbackWinner: "A" | "B",
): CodexAxisPreference {
  if (
    value === "slight_a"
    || value === "a"
    || value === "strong_a"
    || value === "slight_b"
    || value === "b"
    || value === "strong_b"
  ) {
    return value;
  }
  return fallbackWinner === "A" ? "slight_a" : "slight_b";
}

function normalizeCodexReviewDraft(value: unknown): CodexReviewDraft | undefined {
  const draft = asRecord(value);
  if (!draft) return undefined;
  const winner = draft.winner === "B" ? "B" : "A";
  const modelA = asRecord(draft.modelA);
  const modelB = asRecord(draft.modelB);
  const axesRaw = asRecord(draft.axes) ?? {};
  const axes = Object.fromEntries(
    CODEX_AXIS_NAMES.map((axis) => [axis, normalizeCodexAxisPreference(axesRaw[axis], winner)]),
  ) as Record<CodexAxisName, CodexAxisPreference>;
  return {
    winner,
    modelA: {
      pros: asNonEmptyString(modelA?.pros) ?? "",
      cons: asNonEmptyString(modelA?.cons) ?? "",
    },
    modelB: {
      pros: asNonEmptyString(modelB?.pros) ?? "",
      cons: asNonEmptyString(modelB?.cons) ?? "",
    },
    axes,
    overallJustification: asNonEmptyString(draft.overallJustification) ?? "",
    winnerUnresolvedCons: asStringArray(draft.winnerUnresolvedCons),
    nextPrompt: asNonEmptyString(draft.nextPrompt) ?? "",
    confidenceNotes: asNonEmptyString(draft.confidenceNotes) ?? "",
    generatedAt: asNonEmptyString(draft.generatedAt) ?? new Date().toISOString(),
    artifactDir: asNonEmptyString(draft.artifactDir),
  };
}

function normalizeCodexTaskState(details: Record<string, unknown>): CodexTaskState | undefined {
  const raw = asRecord(details.codexTask);
  const issue = asRecord(raw?.issue);
  if (!raw || !issue || !asNonEmptyString(raw.hfiUuid) || !asNonEmptyString(issue.title)) {
    return undefined;
  }
  const promptsRaw = Array.isArray(raw.prompts) ? raw.prompts : [];
  const prompts = promptsRaw
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item): PromptDraft => ({
      round: Math.max(1, Math.min(CODEX_TASK_MAX_PROMPTS, Number(item.round) || 1)),
      prompt: asNonEmptyString(item.prompt) ?? "",
      source: item.source === "review_follow_up" ? "review_follow_up" : "issue_rewrite",
      generatedAt: asNonEmptyString(item.generatedAt) ?? new Date().toISOString(),
    }))
    .filter((item) => item.prompt);
  const roundsRaw = Array.isArray(raw.rounds) ? raw.rounds : [];
  const rounds = roundsRaw
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item) => ({
      round: Math.max(1, Math.min(CODEX_TASK_MAX_PROMPTS, Number(item.round) || 1)),
      notesA: asNonEmptyString(item.notesA),
      notesB: asNonEmptyString(item.notesB),
      reviewDraft: normalizeCodexReviewDraft(item.reviewDraft),
      artifactDir: asNonEmptyString(item.artifactDir),
      generatedAt: asNonEmptyString(item.generatedAt),
      promptGeneratedForNextRound: Number.isFinite(Number(item.promptGeneratedForNextRound))
        ? Number(item.promptGeneratedForNextRound)
        : undefined,
    }))
    .sort((left, right) => left.round - right.round);
  return {
    hfiUuid: asNonEmptyString(raw.hfiUuid) ?? "",
    originalRepoPath: asNonEmptyString(raw.originalRepoPath) ?? "",
    worktreeAPath: asNonEmptyString(raw.worktreeAPath) ?? "",
    worktreeBPath: asNonEmptyString(raw.worktreeBPath) ?? "",
    testCommand: asNonEmptyString(raw.testCommand),
    currentRound: Math.max(1, Math.min(CODEX_TASK_MAX_PROMPTS, Number(raw.currentRound) || 1)),
    maxPrompts: CODEX_TASK_MAX_PROMPTS,
    startedAt: asNonEmptyString(raw.startedAt) ?? new Date().toISOString(),
    updatedAt: asNonEmptyString(raw.updatedAt) ?? new Date().toISOString(),
    issue: {
      owner: asNonEmptyString(issue.owner),
      repo: asNonEmptyString(issue.repo),
      number: Number.isFinite(Number(issue.number)) ? Number(issue.number) : undefined,
      url: asNonEmptyString(issue.url),
      title: asNonEmptyString(issue.title) ?? "Unknown issue",
      body: asNonEmptyString(issue.body),
      selectedFromCount: Math.max(1, Number(issue.selectedFromCount) || 1),
    },
    prContext: asRecord(raw.prContext)
      ? {
          number: Number.isFinite(Number((raw.prContext as Record<string, unknown>).number))
            ? Number((raw.prContext as Record<string, unknown>).number)
            : undefined,
          url: asNonEmptyString((raw.prContext as Record<string, unknown>).url),
          title: asNonEmptyString((raw.prContext as Record<string, unknown>).title),
          body: asNonEmptyString((raw.prContext as Record<string, unknown>).body),
          mergedAt: asNonEmptyString((raw.prContext as Record<string, unknown>).mergedAt),
          changedFilesCount: Number.isFinite(Number((raw.prContext as Record<string, unknown>).changedFilesCount))
            ? Number((raw.prContext as Record<string, unknown>).changedFilesCount)
            : undefined,
          changedFiles: Array.isArray((raw.prContext as Record<string, unknown>).changedFiles)
            ? ((raw.prContext as Record<string, unknown>).changedFiles as Array<Record<string, unknown>>).map((file) => ({
                filename: asNonEmptyString(file.filename) ?? "unknown",
                additions: Number(file.additions ?? 0),
                deletions: Number(file.deletions ?? 0),
                changes: Number(file.changes ?? 0),
                status: asNonEmptyString(file.status) ?? "modified",
              }))
            : [],
          fetchedAt: asNonEmptyString((raw.prContext as Record<string, unknown>).fetchedAt) ?? new Date().toISOString(),
        }
      : undefined,
    prompts,
    rounds,
  };
}

function updateCodexTaskState(details: Record<string, unknown>, task: CodexTaskState): Record<string, unknown> {
  details.codexTask = task;
  return details;
}

function upsertPromptDraft(task: CodexTaskState, draft: PromptDraft): CodexTaskState {
  const prompts = task.prompts.filter((item) => item.round !== draft.round);
  prompts.push(draft);
  prompts.sort((left, right) => left.round - right.round);
  return {
    ...task,
    prompts,
    updatedAt: new Date().toISOString(),
  };
}

function upsertTaskRound(task: CodexTaskState, round: CodexTaskRound): CodexTaskState {
  const rounds = task.rounds.filter((item) => item.round !== round.round);
  rounds.push(round);
  rounds.sort((left, right) => left.round - right.round);
  return {
    ...task,
    rounds,
    updatedAt: new Date().toISOString(),
  };
}

function promptForRound(task: CodexTaskState, round: number): string | undefined {
  return task.prompts.find((item) => item.round === round)?.prompt;
}

function roundForTask(task: CodexTaskState, round: number): CodexTaskRound | undefined {
  return task.rounds.find((item) => item.round === round);
}

function pickPrimaryIssue(issues: any[], row: any): CodexIssueSource {
  const source = issues[0];
  if (source) {
    return {
      owner: asNonEmptyString(source.owner),
      repo: asNonEmptyString(source.repo),
      number: Number.isFinite(Number(source.number)) ? Number(source.number) : undefined,
      url: asNonEmptyString(source.url),
      title: asNonEmptyString(source.title) ?? `Issue #${source.number}`,
      body: asNonEmptyString(source.body),
      selectedFromCount: issues.length,
    };
  }
  return {
    title: asNonEmptyString(row.pr_title) ?? "Resolve the linked issue",
    body: undefined,
    selectedFromCount: 1,
  };
}

async function resolveCodexPrContext(github: GitHubClient, row: any): Promise<CodexPrContext | undefined> {
  if (!row.pr_number) {
    return undefined;
  }
  const repo = toSearchRepo(row);
  const [pullRequest, files] = await Promise.all([
    github.getPullRequest(repo, Number(row.pr_number)),
    github.listPullRequestFiles(repo, Number(row.pr_number)).catch(() => []),
  ]);
  if (!pullRequest && files.length === 0) {
    if (!row.pr_title && !row.pr_url) return undefined;
  }
  return {
    number: Number(row.pr_number),
    url: pullRequest?.url ?? asNonEmptyString(row.pr_url),
    title: pullRequest?.title ?? asNonEmptyString(row.pr_title),
    body: pullRequest?.body,
    mergedAt: pullRequest?.mergedAt ?? undefined,
    changedFilesCount: pullRequest?.changedFilesCount ?? files.length,
    changedFiles: summarizePullRequestFiles(files),
    fetchedAt: new Date().toISOString(),
  };
}

function reviewArtifactDir(config: Config, candidateId: number, round: number): string {
  return resolve(config.outputRoot, "codex-reviews", `candidate-${candidateId}`, `round-${round}`);
}

function assertAbsoluteExistingPath(pathValue: unknown, label: string): string {
  const value = asNonEmptyString(pathValue);
  if (!value) {
    throw new RequestValidationError(`${label} is required`);
  }
  if (!isAbsolute(value)) {
    throw new RequestValidationError(`${label} must be an absolute path`);
  }
  if (!existsSync(value)) {
    throw new RequestValidationError(`${label} does not exist`);
  }
  return value;
}

async function assertGitRepository(pathValue: string, label: string): Promise<void> {
  const result = await runCommand({
    cmd: "git",
    args: ["-C", pathValue, "rev-parse", "--show-toplevel"],
    timeoutMs: 15_000,
  });
  if (result.code !== 0) {
    throw new RequestValidationError(`${label} is not a git repository`);
  }
}

async function readCommandOutput(
  cmd: string,
  args: string[],
  options: {
    cwd?: string;
    timeoutMs?: number;
  } = {},
): Promise<string> {
  const result = await runCommand({
    cmd,
    args,
    cwd: options.cwd,
    timeoutMs: options.timeoutMs ?? 60_000,
  });
  const combined = `${result.stdout}\n${result.stderr}`.trim();
  if (result.code !== 0) {
    throw new Error(combined || `${cmd} ${args.join(" ")} failed`);
  }
  return result.stdout.trim() || combined;
}

function normalizeReviewStatus(value: unknown): "new" | "reviewing" | "approved" | "follow_up" {
  if (value === "reviewing" || value === "approved" || value === "follow_up") {
    return value;
  }
  return "new";
}

function listDockerfilePaths(files: string[]): string[] {
  return files.filter((file) => /(^|\/)Dockerfile(\.[^/]+)?$/i.test(file) && !file.startsWith("docs/") && !file.startsWith("examples/"));
}

function preferredDockerfilePath(details: Record<string, unknown>, files: string[]): string | undefined {
  const acceptedTest = asRecord(details.acceptedTest);
  const acceptedDockerfile = asRecord(acceptedTest?.dockerfile);
  const rerun = asRecord(details.rerun);
  const rerunOverride = asRecord(rerun?.dockerfileOverride);
  const rerunPlan = asRecord(rerun?.testPlan);
  const initialPlan = asRecord(details.testPlan);
  const preferred = [
    asNonEmptyString(acceptedDockerfile?.path),
    asNonEmptyString(rerunOverride?.path),
    asNonEmptyString(rerunPlan?.dockerfilePath),
    asNonEmptyString(initialPlan?.dockerfilePath),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of preferred) {
    if (files.includes(candidate)) {
      return candidate;
    }
  }

  const dockerfilePaths = listDockerfilePaths(files);
  return dockerfilePaths.find((path) => path === "Dockerfile") ?? dockerfilePaths[0];
}

function normalizeRelativeFilePath(value: string): string {
  const unixPath = value.trim().replace(/\\/g, "/");
  if (!unixPath) {
    throw new RequestValidationError("dockerfile path cannot be empty");
  }
  if (unixPath.startsWith("/") || /^[A-Za-z]:\//.test(unixPath)) {
    throw new RequestValidationError("dockerfile path must be relative to the repository root");
  }

  const segments = unixPath.split("/").filter(Boolean);
  if (segments.length === 0) {
    throw new RequestValidationError("dockerfile path cannot be empty");
  }
  if (segments.some((segment) => segment === "..")) {
    throw new RequestValidationError("dockerfile path cannot escape the repository root");
  }

  return segments.filter((segment) => segment !== ".").join("/");
}

function resolveSnapshotFilePath(rootDir: string, relativePath: string): string {
  const fullPath = resolve(rootDir, relativePath);
  const rel = relative(rootDir, fullPath);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new RequestValidationError("dockerfile path resolves outside the repository root");
  }
  return fullPath;
}

function applyDockerfileOverride(
  snapshot: Awaited<ReturnType<typeof prepareSnapshot>>,
  details: Record<string, unknown>,
  requestedPath: string | undefined,
  content: string,
): { path: string; contentBytes: number; sha256: string } {
  const relativePath = requestedPath
    ? normalizeRelativeFilePath(requestedPath)
    : (preferredDockerfilePath(details, snapshot.files) ?? "Dockerfile");
  const fullPath = resolveSnapshotFilePath(snapshot.rootDir, relativePath);
  ensureDir(dirname(fullPath));
  writeFileSync(fullPath, content, "utf8");
  if (!snapshot.files.includes(relativePath)) {
    snapshot.files.push(relativePath);
  }
  return {
    path: relativePath,
    contentBytes: Buffer.byteLength(content, "utf8"),
    sha256: createHash("sha256").update(content, "utf8").digest("hex"),
  };
}

function makeDockerfileState(
  path: string,
  content: string,
  source: "source" | "gemini" | "gemini_fix" | "manual",
  reasoningSummary?: string,
): Record<string, unknown> {
  return {
    path,
    content,
    source,
    reasoningSummary: reasoningSummary ?? null,
    contentBytes: Buffer.byteLength(content, "utf8"),
    sha256: createHash("sha256").update(content, "utf8").digest("hex"),
    updatedAt: new Date().toISOString(),
  };
}

function acceptedTestDockerfile(details: Record<string, unknown>): Record<string, unknown> | undefined {
  return asRecord(asRecord(details.acceptedTest)?.dockerfile);
}

function acceptedTestLastRun(details: Record<string, unknown>): Record<string, unknown> | undefined {
  return asRecord(asRecord(details.acceptedTest)?.lastRun);
}

function acceptedTestFailureOutput(details: Record<string, unknown>): string | undefined {
  const lastRun = acceptedTestLastRun(details);
  const execution = asRecord(lastRun?.execution);
  const liveOutputTail = asNonEmptyString(lastRun?.liveOutputTail);
  const fragments = [
    liveOutputTail ? `LIVE OUTPUT\n${liveOutputTail}` : "",
    execution?.buildStderrPath ? `BUILD STDERR\n${readLogExcerpt(String(execution.buildStderrPath), 8000) ?? ""}` : "",
    execution?.buildStdoutPath ? `BUILD STDOUT\n${readLogExcerpt(String(execution.buildStdoutPath), 8000) ?? ""}` : "",
    execution?.testStderrPath ? `TEST STDERR\n${readLogExcerpt(String(execution.testStderrPath), 8000) ?? ""}` : "",
    execution?.testStdoutPath ? `TEST STDOUT\n${readLogExcerpt(String(execution.testStdoutPath), 8000) ?? ""}` : "",
  ].filter(Boolean);
  return fragments.length ? fragments.join("\n\n") : undefined;
}

async function loadCandidateDockerfilePayload(
  github: GitHubClient,
  config: Config,
  row: any,
  details: Record<string, unknown>,
  requestedPath?: string,
): Promise<Record<string, unknown>> {
  if (!row.pre_fix_sha) {
    throw new RequestValidationError("candidate is missing the pre-fix SHA needed to load its Dockerfile");
  }

  const repo = toSearchRepo(row);
  const savedDockerfile = acceptedTestDockerfile(details);

  try {
    const tree = await github.getRepoTree(repo, String(row.pre_fix_sha));
    const files = tree
      .filter((item) => item.type === "blob")
      .map((item) => item.path);
    const availablePaths = unique([
      ...listDockerfilePaths(files),
      ...(asNonEmptyString(savedDockerfile?.path) ? [String(savedDockerfile?.path)] : []),
    ]);
    const resolvedPath = requestedPath ?? (preferredDockerfilePath(details, files) ?? "Dockerfile");
    const savedPath = asNonEmptyString(savedDockerfile?.path);
    const savedContent = typeof savedDockerfile?.content === "string" ? savedDockerfile.content : undefined;
    const useSaved = savedPath === resolvedPath && savedContent !== undefined;
    const exists = useSaved || files.includes(resolvedPath);
    const content = useSaved
      ? savedContent
      : (exists ? (await github.getFile(repo, resolvedPath, String(row.pre_fix_sha)) ?? "") : "");
    return {
      path: resolvedPath,
      content,
      exists,
      availablePaths,
      source: useSaved ? "saved" : "github",
      reasoningSummary: asNonEmptyString(savedDockerfile?.reasoningSummary) ?? null,
    };
  } catch (err) {
    if (err instanceof RequestValidationError) {
      throw err;
    }

    let snapshot: Awaited<ReturnType<typeof prepareSnapshot>> | undefined;
    try {
      snapshot = await prepareSnapshot(config, repo, String(row.pre_fix_sha));
      const availablePaths = unique([
        ...listDockerfilePaths(snapshot.files),
        ...(asNonEmptyString(savedDockerfile?.path) ? [String(savedDockerfile?.path)] : []),
      ]);
      const resolvedPath = requestedPath ?? (preferredDockerfilePath(details, snapshot.files) ?? "Dockerfile");
      const fullPath = resolveSnapshotFilePath(snapshot.rootDir, resolvedPath);
      const savedPath = asNonEmptyString(savedDockerfile?.path);
      const savedContent = typeof savedDockerfile?.content === "string" ? savedDockerfile.content : undefined;
      const useSaved = savedPath === resolvedPath && savedContent !== undefined;
      const exists = useSaved || snapshot.files.includes(resolvedPath);
      const content = useSaved ? savedContent : (exists ? (readUtf8Safe(fullPath) ?? "") : "");
      return {
        path: resolvedPath,
        content,
        exists,
        availablePaths,
        source: useSaved ? "saved" : "snapshot",
        reasoningSummary: asNonEmptyString(savedDockerfile?.reasoningSummary) ?? null,
      };
    } finally {
      if (snapshot) {
        cleanupSnapshot(config, snapshot, { force: true });
      }
    }
  }
}

function forceDockerfileOnPlan(plan: TestPlan, dockerfilePath: string): TestPlan {
  if (plan.runner === "compose-run") {
    return {
      ...plan,
      runner: "docker-run",
      composeFilePath: undefined,
      composeService: undefined,
      composeBuildServices: undefined,
      dockerfilePath,
      reasoningSummary: `${plan.reasoningSummary} | rerun forced direct Docker build with edited ${dockerfilePath}`,
    };
  }
  if (plan.dockerfilePath === dockerfilePath) {
    return plan;
  }
  return {
    ...plan,
    dockerfilePath,
    reasoningSummary: `${plan.reasoningSummary} | rerun forced edited ${dockerfilePath}`,
  };
}

function isExecutionRelatedReason(reason: string): boolean {
  return EXECUTION_REASON_PREFIXES.some((prefix) => reason.startsWith(prefix));
}

function toSearchRepo(row: any): SearchRepo {
  return {
    owner: String(row.repo_owner),
    name: String(row.repo_name),
    fullName: String(row.repo_full_name),
    url: String(row.repo_url),
    isArchived: Boolean(row.repo_is_archived),
    stars: Number(row.repo_stars ?? 0),
    primaryLanguage: typeof row.repo_primary_language === "string" ? row.repo_primary_language : undefined,
    defaultBranch: typeof row.repo_default_branch === "string" ? row.repo_default_branch : "main",
    pushedAt: typeof row.repo_pushed_at === "string" ? row.repo_pushed_at : undefined,
    diskUsageKb: typeof row.repo_disk_usage_kb === "number" ? row.repo_disk_usage_kb : undefined,
    description: typeof row.repo_description === "string" ? row.repo_description : row.repo_description ?? undefined,
  };
}

function repoRecordToSearchRepo(row: any): SearchRepo {
  return {
    owner: String(row.owner),
    name: String(row.name),
    fullName: String(row.full_name),
    url: String(row.url),
    isArchived: Boolean(row.is_archived),
    stars: Number(row.stars ?? 0),
    primaryLanguage: typeof row.primary_language === "string" ? row.primary_language : undefined,
    defaultBranch: typeof row.default_branch === "string" ? row.default_branch : "main",
    pushedAt: typeof row.pushed_at === "string" ? row.pushed_at : undefined,
    diskUsageKb: typeof row.disk_usage_kb === "number" ? row.disk_usage_kb : undefined,
    description: typeof row.description === "string" ? row.description : row.description ?? undefined,
  };
}

function repoRowToSetupTarget(row: any): SetupTaskTarget {
  const repo = repoRecordToSearchRepo(row);
  return {
    targetType: "repo",
    targetLabel: repo.fullName,
    repoId: Number(row.id),
    repo,
  };
}

function issueRowToSetupTarget(row: any): SetupTaskTarget {
  return {
    targetType: "issue",
    targetLabel: `${String(row.repo_full_name)} issue #${String(row.number)}${row.title ? `: ${String(row.title)}` : ""}`,
    repoId: Number(row.repo_id),
    repo: {
      owner: String(row.repo_owner),
      name: String(row.repo_name),
      fullName: String(row.repo_full_name),
      url: String(row.repo_url),
      isArchived: Boolean(row.repo_is_archived),
      stars: Number(row.repo_stars ?? 0),
      primaryLanguage: typeof row.repo_primary_language === "string" ? row.repo_primary_language : undefined,
      defaultBranch: typeof row.repo_default_branch === "string" ? row.repo_default_branch : "main",
      pushedAt: typeof row.repo_pushed_at === "string" ? row.repo_pushed_at : undefined,
      diskUsageKb: typeof row.repo_disk_usage_kb === "number" ? row.repo_disk_usage_kb : undefined,
      description: typeof row.repo_description === "string" ? row.repo_description : row.repo_description ?? undefined,
    },
    checkoutSha: typeof row.pr_base_ref_oid === "string" ? row.pr_base_ref_oid : undefined,
    issueId: Number(row.id),
    issueNumber: Number(row.number),
    issueTitle: typeof row.title === "string" ? row.title : undefined,
    issueBody: typeof row.body === "string" ? row.body : undefined,
    issueUrl: typeof row.url === "string" ? row.url : undefined,
    pullRequestNumber: typeof row.pr_number === "number" ? row.pr_number : undefined,
    pullRequestTitle: typeof row.pr_title === "string" ? row.pr_title : undefined,
    pullRequestUrl: typeof row.pr_url === "string" ? row.pr_url : undefined,
  };
}

function parseSetupProfilePayload(body: any, defaultCloneRoot: string): {
  name: string;
  prompt: string;
  contextPaths: string[];
  writablePaths: string[];
  validationPrompt: string;
  cloneRootPath: string;
  model?: string;
  sandboxMode: "workspace-write" | "danger-full-access";
} {
  const name = asNonEmptyString(body?.name);
  const prompt = asNonEmptyString(body?.prompt);
  if (!name) {
    throw new RequestValidationError("profile name is required");
  }
  if (!prompt) {
    throw new RequestValidationError("profile prompt is required");
  }

  const contextPaths = parseSetupPathList(body?.contextPaths);
  const writablePaths = parseSetupPathList(body?.writablePaths);
  const validationPrompt = typeof body?.validationPrompt === "string" ? body.validationPrompt.trim() : "";
  const cloneRootPath = asNonEmptyString(body?.cloneRootPath) ?? defaultCloneRoot;

  return {
    name,
    prompt,
    contextPaths,
    writablePaths,
    validationPrompt,
    cloneRootPath,
    model: asNonEmptyString(body?.model),
    sandboxMode: body?.sandboxMode === "danger-full-access" ? "danger-full-access" : "workspace-write",
  };
}

function isUniqueSetupProfileNameError(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed: setup_profiles\.name/.test(error.message);
}

async function measureAsyncStep<T>(step: string, fn: () => Promise<T>): Promise<{ result: T; timing: { step: string; durationMs: number } }> {
  const started = performance.now();
  const result = await fn();
  return {
    result,
    timing: {
      step,
      durationMs: Math.round(performance.now() - started),
    },
  };
}

export function createApp(config: Config): express.Express {
  const app = express();
  app.use(express.json());

  cleanupProjectStorage(config);

  // Serve static frontend
  const publicDir = resolve(join(__dirname, "..", "public"));
  app.use(express.static(publicDir));

  const db = getDb(config.dbPath);
  const github = new GitHubClient(config);

  const scheduleActiveTestRerunCleanup = (candidateId: number): void => {
    setTimeout(() => {
      const rerun = activeTestRerunStates.get(candidateId);
      if (rerun && rerun.status !== "running") {
        activeTestRerunStates.delete(candidateId);
      }
    }, 15 * 60 * 1000);
  };

  const scheduleActiveAcceptedTestRunCleanup = (candidateId: number): void => {
    setTimeout(() => {
      const run = activeAcceptedTestRunStates.get(candidateId);
      if (run && run.status !== "running") {
        activeAcceptedTestRunStates.delete(candidateId);
      }
    }, 15 * 60 * 1000);
  };

  const scheduleActiveCodexReviewCleanup = (candidateId: number, round: number): void => {
    setTimeout(() => {
      const key = codexReviewRunKey(candidateId, round);
      const run = activeCodexReviewRunStates.get(key);
      if (run && run.status !== "running") {
        activeCodexReviewRunStates.delete(key);
      }
    }, 15 * 60 * 1000);
  };

  const persistCodexTask = (row: any, details: Record<string, unknown>, task: CodexTaskState): void => {
    updateCodexTaskState(details, task);
    updateScanCandidateState(db, Number(row.id), {
      accepted: Boolean(row.accepted),
      rejectionReasons: safeParseJson<string[]>(row.rejection_reasons, []),
      testsUnableToRun: Boolean(row.tests_unable_to_run),
      testsUnableToRunReason: typeof row.tests_unable_to_run_reason === "string" ? row.tests_unable_to_run_reason : undefined,
      detailsJson: JSON.stringify(details),
    });
  };

  const codexTaskPayload = (row: any, details: Record<string, unknown>) => {
    const task = normalizeCodexTaskState(details);
    return {
      task,
      activeReview: task
        ? (activeCodexReviewRunStates.get(codexReviewRunKey(Number(row.id), task.currentRound))
          ? codexReviewStateToApi(activeCodexReviewRunStates.get(codexReviewRunKey(Number(row.id), task.currentRound)) as ActiveCodexReviewRunState)
          : null)
        : null,
    };
  };

  const collectCodexReviewEvidence = async (
    task: CodexTaskState,
    label: "A" | "B",
    repoPath: string,
    baselineHead: string,
    testCommand: string | undefined,
    notes: string | undefined,
  ) => {
    const warnings: string[] = [];
    const safeRead = async (step: string, fn: () => Promise<string>, fallback = `${step} unavailable`): Promise<string> => {
      try {
        return await fn();
      } catch (err) {
        warnings.push(`${step}: ${err instanceof Error ? err.message : String(err)}`);
        return fallback;
      }
    };

    const gitStatus = await safeRead("git status", () => readCommandOutput("git", ["-C", repoPath, "status", "--short", "--branch"]));
    const branch = await safeRead("branch", () => readCommandOutput("git", ["-C", repoPath, "rev-parse", "--abbrev-ref", "HEAD"]));
    const head = await safeRead("head", () => readCommandOutput("git", ["-C", repoPath, "rev-parse", "HEAD"]));
    const diffStat = await safeRead("diff stat", () => readCommandOutput("git", ["-C", repoPath, "diff", "--stat", baselineHead, "--", "."]), "diff stat unavailable");
    const diffPatch = await safeRead("diff patch", () => readCommandOutput("git", ["-C", repoPath, "diff", "--binary", baselineHead, "--", "."]), "diff patch unavailable");
    const log = await safeRead("git log", () => readCommandOutput("git", ["-C", repoPath, "log", "--oneline", "--decorate", "-5"]), "git log unavailable");
    const tmuxCapture = await safeRead(
      "tmux capture",
      () => readCommandOutput("tmux", ["capture-pane", "-p", "-t", `${task.hfiUuid}-${label}`], { timeoutMs: 15_000 }),
      "tmux capture unavailable",
    );

    let testExitCode: number | null | undefined;
    let testOutput: string | undefined;
    if (testCommand) {
      const testResult = await runCommand({
        cmd: "zsh",
        args: ["-lc", testCommand],
        cwd: repoPath,
        timeoutMs: config.testTimeoutMs,
      });
      testExitCode = testResult.code;
      testOutput = [
        `$ ${testCommand}`,
        "",
        testResult.stdout ? `STDOUT\n${testResult.stdout.trim()}` : "",
        testResult.stderr ? `STDERR\n${testResult.stderr.trim()}` : "",
        `exit_code=${testResult.code}`,
        testResult.timedOut ? "timed_out=true" : "",
      ].filter(Boolean).join("\n\n");
    }

    return {
      label,
      repoPath,
      gitStatus,
      branch,
      head,
      diffStat,
      diffPatch,
      log,
      tmuxCapture,
      testCommand,
      testExitCode,
      testOutput,
      notes,
      warnings,
    };
  };

  const runCodexTaskReview = async (
    row: any,
    runState: ActiveCodexReviewRunState,
    details: Record<string, unknown>,
    task: CodexTaskState,
    notesA: string | undefined,
    notesB: string | undefined,
  ): Promise<void> => {
    const round = runState.round;
    const artifactDir = reviewArtifactDir(config, runState.candidateId, round);
    runState.artifactDir = artifactDir;
    appendCodexReviewLog(runState, `Preparing Codex review bundle for round ${round}`);

    try {
      const baselineHead = await readCommandOutput("git", ["-C", task.originalRepoPath, "rev-parse", "HEAD"]);
      const currentPrompt = promptForRound(task, round) ?? buildFollowUpPrompt(round, []);
      appendCodexReviewLog(runState, "Collecting A/B evidence");

      const [responseA, responseB, prContext] = await Promise.all([
        collectCodexReviewEvidence(task, "A", task.worktreeAPath, baselineHead, task.testCommand, notesA),
        collectCodexReviewEvidence(task, "B", task.worktreeBPath, baselineHead, task.testCommand, notesB),
        task.prContext ? Promise.resolve(task.prContext) : resolveCodexPrContext(github, row),
      ]);

      writeReviewBundle(artifactDir, {
        round,
        maxPrompts: task.maxPrompts,
        issue: task.issue,
        prContext,
        currentPrompt,
        originalRepoPath: task.originalRepoPath,
        worktreeAPath: task.worktreeAPath,
        worktreeBPath: task.worktreeBPath,
        testCommand: task.testCommand,
        screening: asRecord(details.screening) ?? null,
        analysis: asRecord(details.analysis) ?? null,
        previousRound: round > 1 ? roundForTask(task, round - 1) : undefined,
        responseA,
        responseB,
      });
      appendCodexReviewLog(runState, "Evidence bundle saved");

      const schemaPath = join(artifactDir, "review-output.schema.json");
      const outputPath = join(artifactDir, "codex-last-message.json");
      const promptPath = join(artifactDir, "codex-instructions.txt");
      const codexPrompt = buildCodexReviewPrompt({
        round,
        maxPrompts: task.maxPrompts,
        issue: task.issue,
        prContext,
        currentPrompt,
        originalRepoPath: task.originalRepoPath,
        worktreeAPath: task.worktreeAPath,
        worktreeBPath: task.worktreeBPath,
        testCommand: task.testCommand,
        screening: asRecord(details.screening) ?? null,
        analysis: asRecord(details.analysis) ?? null,
        previousRound: round > 1 ? roundForTask(task, round - 1) : undefined,
        responseA,
        responseB,
      });
      writeFileSync(promptPath, codexPrompt, "utf8");
      appendCodexReviewLog(runState, "Running local Codex review");

      const codexResult = await runCommand({
        cmd: "codex",
        args: [
          "exec",
          "-C",
          artifactDir,
          "-s",
          "read-only",
          "--skip-git-repo-check",
          "--output-schema",
          schemaPath,
          "-o",
          outputPath,
          "--add-dir",
          task.originalRepoPath,
          "--add-dir",
          task.worktreeAPath,
          "--add-dir",
          task.worktreeBPath,
          "-",
        ],
        stdinText: codexPrompt,
        timeoutMs: Math.max(config.testTimeoutMs, 10 * 60 * 1000),
        onStdoutChunk: (chunk) => appendCodexReviewOutput(runState, "stdout", chunk),
        onStderrChunk: (chunk) => appendCodexReviewOutput(runState, "stderr", chunk),
      });

      if (codexResult.code !== 0) {
        throw new Error(`${codexResult.stderr || codexResult.stdout || "codex exec failed"}`.trim());
      }

      const rawOutput = readUtf8Safe(outputPath) ?? codexResult.stdout;
      let reviewDraft: CodexReviewDraft;
      try {
        reviewDraft = parseCodexReviewOutput(rawOutput);
      } catch (err) {
        appendCodexReviewLog(runState, `Codex output parsing failed, generating fallback draft: ${err instanceof Error ? err.message : String(err)}`);
        reviewDraft = createFallbackReviewDraft(
          round,
          "A",
          round > 1 ? (roundForTask(task, round - 1)?.reviewDraft?.winnerUnresolvedCons ?? []) : [],
        );
      }

      reviewDraft.artifactDir = artifactDir;
      reviewDraft.generatedAt = new Date().toISOString();
      if (round < CODEX_TASK_MAX_PROMPTS && !reviewDraft.nextPrompt.trim()) {
        reviewDraft.nextPrompt = buildFollowUpPrompt(round + 1, reviewDraft.winnerUnresolvedCons);
      }
      writeJson(join(artifactDir, "review-draft.json"), reviewDraft);

      let updatedTask: CodexTaskState = {
        ...task,
        currentRound: round < CODEX_TASK_MAX_PROMPTS ? round + 1 : task.currentRound,
        prContext,
        updatedAt: new Date().toISOString(),
      };
      updatedTask = upsertTaskRound(updatedTask, {
        round,
        notesA,
        notesB,
        reviewDraft,
        artifactDir,
        generatedAt: reviewDraft.generatedAt,
        promptGeneratedForNextRound: round < CODEX_TASK_MAX_PROMPTS ? round + 1 : undefined,
      });
      if (round < CODEX_TASK_MAX_PROMPTS) {
        updatedTask = upsertPromptDraft(updatedTask, makePromptDraft(round + 1, reviewDraft.nextPrompt, "review_follow_up"));
      }
      persistCodexTask(row, details, updatedTask);

      runState.status = "completed";
      runState.finishedAt = new Date().toISOString();
      appendCodexReviewLog(runState, "Codex review completed");
    } catch (err) {
      runState.status = "failed";
      runState.finishedAt = new Date().toISOString();
      runState.error = err instanceof Error ? err.message : String(err);
      appendCodexReviewLog(runState, `Codex review failed: ${runState.error}`);
    } finally {
      scheduleActiveCodexReviewCleanup(runState.candidateId, round);
    }
  };

  const scheduleActiveSetupRunCleanup = (runId: number): void => {
    setTimeout(() => {
      const run = activeSetupRunStates.get(runId);
      if (run && run.status !== "running") {
        activeSetupRunStates.delete(runId);
      }
    }, 30 * 60 * 1000);
  };

  const queueSetupTask = (target: SetupTaskTarget, profile: NonNullable<ReturnType<typeof getSetupProfileById>>, runState: ActiveSetupRunState): void => {
    void runSetupTask({ config, db, github }, target, profile, runState)
      .finally(() => {
        scheduleActiveSetupRunCleanup(runState.runId);
      });
  };

  const startSetupTarget = (target: SetupTaskTarget, profileId: number | undefined): Record<string, unknown> => {
    const existing = [...activeSetupRunStates.values()].find((run) => {
      if (run.status !== "running") return false;
      if (target.targetType === "issue") {
        return run.targetType === "issue" && run.issueId === target.issueId;
      }
      return run.targetType === "repo" && run.repoId === target.repoId;
    });
    if (existing) {
      throw new RequestValidationError(
        target.targetType === "issue"
          ? "this issue already has a setup task running"
          : "this repo already has a setup task running",
      );
    }

    const profile = typeof profileId === "number"
      ? getSetupProfileById(db, profileId)
      : pickPreferredSetupProfile(getSetupProfiles(db), target.repo.primaryLanguage);
    if (!profile) {
      throw new RequestValidationError("no setup profile is available; create one first");
    }

    const runId = createSetupRun(db, {
      targetType: target.targetType,
      targetLabel: target.targetLabel,
      repoId: target.repoId,
      issueId: target.issueId,
      issueNumber: target.issueNumber,
      issueTitle: target.issueTitle,
      profileId: profile.id,
      prompt: profile.prompt,
      contextPaths: profile.contextPaths,
      writablePaths: profile.writablePaths,
      validationPrompt: profile.validationPrompt,
      cloneRootPath: profile.cloneRootPath,
      model: profile.model,
      sandboxMode: profile.sandboxMode,
    });

    const runRecord = getSetupRunById(db, runId);
    if (!runRecord) {
      throw new Error("failed to create setup task");
    }

    const runState: ActiveSetupRunState = {
      runId,
      targetType: target.targetType,
      targetLabel: target.targetLabel,
      repoId: target.repoId,
      repoFullName: target.repo.fullName,
      issueId: target.issueId,
      profileId: profile.id,
      profileName: profile.name,
      status: "running",
      stage: "Queued setup task",
      startedAt: runRecord.startedAt,
      logs: [],
      liveOutput: "",
      stopRequested: false,
      abortController: new AbortController(),
      changedFiles: [],
      violationFiles: [],
    };
    activeSetupRunStates.set(runId, runState);
    appendSetupRunLog(runState, `Queued setup task using profile ${profile.name}`);
    queueSetupTask(target, profile, runState);

    return setupRunStateToApi(runRecord, runState);
  };

  const runAcceptedTestRun = async (
    row: any,
    runState: ActiveAcceptedTestRunState,
    options: {
      dockerfilePath: string;
      dockerfileContent: string;
      dockerfileSource?: "source" | "gemini" | "gemini_fix" | "manual";
      reasoningSummary?: string;
    },
  ): Promise<void> => {
    const candidateId = runState.candidateId;
    const runConfig: Config = { ...config, dryRun: false };
    const repo = toSearchRepo(row);
    const details = safeParseJson<Record<string, unknown>>(row.details_json, {});
    const startedAt = runState.startedAt;

    let snapshot: Awaited<ReturnType<typeof prepareSnapshot>> | undefined;
    let testPlan: TestPlan | undefined;
    let execution: ExecutionResult | undefined;
    let dockerfileOverride: { path: string; contentBytes: number; sha256: string } | undefined;
    const timings: Array<{ step: string; durationMs: number }> = [];
    let summary = "Docker test run did not complete";

    appendTestRerunLog(runState, `Docker test run started for ${repo.fullName}`);

    try {
      appendTestRerunLog(runState, "Preparing snapshot");
      const prepared = await measureAsyncStep(
        "snapshot",
        () => prepareSnapshot(runConfig, repo, String(row.pre_fix_sha), { signal: runState.abortController.signal }),
      );
      snapshot = prepared.result;
      timings.push(prepared.timing);

      if (snapshot.sizeBytes > runConfig.maxRepoSizeBytes) {
        summary = `Snapshot exceeds max size: ${snapshot.sizeBytes} bytes`;
        appendTestRerunLog(runState, summary);
      } else {
        dockerfileOverride = applyDockerfileOverride(snapshot, details, options.dockerfilePath, options.dockerfileContent);
        runState.dockerfileOverride = dockerfileOverride;
        appendTestRerunLog(
          runState,
          `Applied Dockerfile override ${dockerfileOverride.path} (${dockerfileOverride.contentBytes} bytes, sha256=${dockerfileOverride.sha256.slice(0, 12)})`,
        );

        appendTestRerunLog(runState, "Resolving Docker test plan");
        const planned = await measureAsyncStep(
          "test_plan",
          () => resolveTestPlan(runConfig, snapshot as Awaited<ReturnType<typeof prepareSnapshot>>, dockerfileOverride?.path),
        );
        testPlan = planned.result;
        timings.push(planned.timing);

        if (testPlan && dockerfileOverride) {
          testPlan = forceDockerfileOnPlan(testPlan, dockerfileOverride.path);
          appendTestRerunLog(runState, `Using Dockerfile ${dockerfileOverride.path} for manual Docker test run`);
        }

        if (!testPlan) {
          summary = "No Docker build plan could be inferred";
          appendTestRerunLog(runState, summary);
        } else if (!testPlan.testCommand.length) {
          summary = "No safe test command could be inferred for this repository";
          appendTestRerunLog(runState, summary);
        } else {
          appendTestRerunLog(runState, `Executing Docker build and test command: ${testPlan.testCommand.join(" ")}`);
          const executed = await measureAsyncStep(
            "docker_exec",
            () => executeTestPlanWithTests(runConfig, snapshot as Awaited<ReturnType<typeof prepareSnapshot>>, testPlan as TestPlan, {
              signal: runState.abortController.signal,
              onStage: (stage) => appendTestRerunLog(runState, stage),
              onOutput: (phase, stream, chunk) => appendTestRerunOutput(runState, phase, stream, chunk),
            }),
          );
          execution = executed.result;
          timings.push(executed.timing);

          if (!execution.buildPassed) {
            summary = "Docker build failed";
          } else if (!execution.testsPassed) {
            summary = "Tests failed inside Docker";
          } else {
            summary = "Docker tests passed";
          }
          appendTestRerunLog(runState, summary);
        }
      }

      const previousDockerfile = acceptedTestDockerfile(details);
      const persistedDockerfile = makeDockerfileState(
        dockerfileOverride?.path ?? options.dockerfilePath,
        options.dockerfileContent,
        options.dockerfileSource
          ?? (typeof previousDockerfile?.source === "string" && String(previousDockerfile.source) !== "source"
            ? (String(previousDockerfile.source) as "source" | "gemini" | "gemini_fix" | "manual")
            : "manual"),
        options.reasoningSummary
          ?? asNonEmptyString(previousDockerfile?.reasoningSummary)
          ?? undefined,
      );
      const currentAcceptedTest = asRecord(details.acceptedTest) ?? {};
      details.acceptedTest = {
        ...currentAcceptedTest,
        dockerfile: persistedDockerfile,
        testPlan: testPlan ?? null,
        lastRun: {
          startedAt,
          finishedAt: new Date().toISOString(),
          success: Boolean(execution?.buildPassed && execution?.testsPassed),
          summary,
          timings,
          testCommand: testPlan?.testCommand ?? [],
          dockerfile: {
            path: persistedDockerfile.path,
            sha256: persistedDockerfile.sha256,
            contentBytes: persistedDockerfile.contentBytes,
            source: persistedDockerfile.source,
          },
          liveOutputTail: runState.liveOutput.slice(-16_000),
          execution: execution
            ? {
                ...execution,
                notes: [
                  ...execution.notes,
                  `manual Docker test run used ${String(persistedDockerfile.path)} sha256=${String(persistedDockerfile.sha256).slice(0, 12)}`,
                ],
              }
            : null,
        },
      };

      updateScanCandidateState(db, candidateId, {
        accepted: Boolean(row.accepted),
        rejectionReasons: safeParseJson<string[]>(row.rejection_reasons, []),
        testsUnableToRun: Boolean(row.tests_unable_to_run),
        testsUnableToRunReason: typeof row.tests_unable_to_run_reason === "string" ? row.tests_unable_to_run_reason : undefined,
        detailsJson: JSON.stringify(details),
      });

      runState.status = "completed";
      runState.finishedAt = new Date().toISOString();
      appendTestRerunLog(runState, execution?.buildPassed && execution?.testsPassed ? "Manual Docker test run completed successfully" : summary);
    } catch (err) {
      if (err instanceof CommandAbortedError || runState.stopRequested || runState.abortController.signal.aborted) {
        runState.status = "stopped";
        runState.finishedAt = new Date().toISOString();
        runState.error = undefined;
        appendTestRerunLog(runState, "Manual Docker test run stopped by user");
        return;
      }
      runState.status = "failed";
      runState.finishedAt = new Date().toISOString();
      runState.error = err instanceof Error ? err.message : String(err);
      appendTestRerunLog(runState, `Manual Docker test run failed: ${runState.error}`);
    } finally {
      if (snapshot) {
        cleanupSnapshot(runConfig, snapshot, { force: true });
      }
      scheduleActiveAcceptedTestRunCleanup(candidateId);
    }
  };

  const runTestsUnableRerun = async (
    row: any,
    rerunState: ActiveTestRerunState,
    options: {
      dockerfilePath?: string;
      dockerfileContent?: string;
    },
  ): Promise<void> => {
    const candidateId = rerunState.candidateId;
    const rerunConfig: Config = { ...config, dryRun: false };
    const repo = toSearchRepo(row);
    const details = safeParseJson<Record<string, unknown>>(row.details_json, {});
    const baseReasons = safeParseJson<string[]>(row.rejection_reasons, []).filter((reason) => !isExecutionRelatedReason(reason));
    const rerunStartedAt = rerunState.startedAt;

    let testPlan: TestPlan | undefined;
    let execution: ExecutionResult | undefined;
    let snapshot: Awaited<ReturnType<typeof prepareSnapshot>> | undefined;
    let testsUnableToRun = true;
    let testsUnableToRunReason: string | undefined;
    let executionReasons: string[] = [];
    let dockerfileOverride: { path: string; contentBytes: number; sha256: string } | undefined;
    const timings: Array<{ step: string; durationMs: number }> = [];

    appendTestRerunLog(rerunState, `Rerun started for ${repo.fullName}`);

    try {
      try {
        appendTestRerunLog(rerunState, "Preparing snapshot");
        const prepared = await measureAsyncStep(
          "snapshot",
          () => prepareSnapshot(rerunConfig, repo, String(row.pre_fix_sha), { signal: rerunState.abortController.signal }),
        );
        snapshot = prepared.result;
        timings.push(prepared.timing);
      } catch (err) {
        if (err instanceof CommandAbortedError) {
          throw err;
        }
        testsUnableToRunReason = "Snapshot preparation failed";
        executionReasons = ["failed to prepare snapshot"];
        const updatedDetails = {
          ...details,
          testPlan: null,
          execution: null,
          rerun: {
            startedAt: rerunStartedAt,
            finishedAt: new Date().toISOString(),
            success: false,
            testsUnableToRun: true,
            testsUnableToRunReason,
            rejectionReasons: [...baseReasons, ...executionReasons],
            timings,
            dockerfileOverride: null,
            testPlan: null,
            execution: null,
          },
        };
        updateScanCandidateState(db, candidateId, {
          accepted: false,
          rejectionReasons: [...baseReasons, ...executionReasons],
          testsUnableToRun: true,
          testsUnableToRunReason,
          detailsJson: JSON.stringify(updatedDetails),
        });
        refreshScanCounts(db, Number(row.scan_id));
        rerunState.status = "completed";
        rerunState.finishedAt = new Date().toISOString();
        appendTestRerunLog(rerunState, testsUnableToRunReason);
        return;
      }

      const preparedSnapshot = snapshot;
      if (!preparedSnapshot) {
        throw new Error("snapshot preparation did not produce a snapshot");
      }

      if (preparedSnapshot.sizeBytes > rerunConfig.maxRepoSizeBytes) {
        testsUnableToRunReason = "Snapshot too large";
        executionReasons = [`snapshot exceeds max size: ${preparedSnapshot.sizeBytes} bytes`];
        appendTestRerunLog(rerunState, testsUnableToRunReason);
      } else {
        if (options.dockerfileContent !== undefined) {
          dockerfileOverride = applyDockerfileOverride(preparedSnapshot, details, options.dockerfilePath, options.dockerfileContent);
          rerunState.dockerfileOverride = dockerfileOverride;
          appendTestRerunLog(
            rerunState,
            `Applied Dockerfile override ${dockerfileOverride.path} (${dockerfileOverride.contentBytes} bytes, sha256=${dockerfileOverride.sha256.slice(0, 12)})`,
          );
        }

        appendTestRerunLog(rerunState, "Resolving Docker build plan");
        const planned = await measureAsyncStep(
          "test_plan",
          () => resolveTestPlan(rerunConfig, preparedSnapshot, dockerfileOverride?.path),
        );
        testPlan = planned.result;
        timings.push(planned.timing);

        if (testPlan && dockerfileOverride) {
          testPlan = forceDockerfileOnPlan(testPlan, dockerfileOverride.path);
          appendTestRerunLog(rerunState, `Using edited Dockerfile ${dockerfileOverride.path} for rerun`);
        }

        if (!testPlan) {
          testsUnableToRunReason = "No Docker build plan could be inferred";
          executionReasons = ["could not infer a Docker build plan"];
          appendTestRerunLog(rerunState, testsUnableToRunReason);
        } else {
          appendTestRerunLog(rerunState, `Executing ${testPlan.runner} Docker build validation`);
          const executed = await measureAsyncStep(
            "docker_exec",
            () => executeTestPlan(rerunConfig, preparedSnapshot, testPlan as TestPlan, {
              signal: rerunState.abortController.signal,
              onStage: (stage) => appendTestRerunLog(rerunState, stage),
              onOutput: (phase, stream, chunk) => appendTestRerunOutput(rerunState, phase, stream, chunk),
            }),
          );
          execution = executed.result;
          timings.push(executed.timing);

          if (!execution.buildPassed) {
            testsUnableToRun = true;
            testsUnableToRunReason = "Docker build failed";
            executionReasons = ["Docker build failed at pre-fix snapshot"];
            appendTestRerunLog(rerunState, testsUnableToRunReason);
          } else {
            testsUnableToRun = false;
            executionReasons = [];
            appendTestRerunLog(rerunState, "Docker build passed for the pre-fix snapshot");
          }
        }
      }

      const rejectionReasons = [...baseReasons, ...executionReasons];
      const accepted = rejectionReasons.length === 0;
      const rerunExecution = execution
        ? {
            ...execution,
            notes: dockerfileOverride
              ? [...execution.notes, `edited dockerfile override: ${dockerfileOverride.path} sha256=${dockerfileOverride.sha256.slice(0, 12)}`]
              : execution.notes,
          }
        : null;
      const updatedDetails = {
        ...details,
        testPlan: testPlan ?? null,
        execution: rerunExecution,
        rerun: {
          startedAt: rerunStartedAt,
          finishedAt: new Date().toISOString(),
          success: accepted,
          testsUnableToRun,
          testsUnableToRunReason,
          rejectionReasons,
          timings,
          dockerfileOverride: dockerfileOverride ?? null,
          testPlan: testPlan ?? null,
          execution: rerunExecution,
        },
      };

      updateScanCandidateState(db, candidateId, {
        accepted,
        rejectionReasons,
        testsUnableToRun,
        testsUnableToRunReason,
        detailsJson: JSON.stringify(updatedDetails),
      });
      refreshScanCounts(db, Number(row.scan_id));
      rerunState.status = "completed";
      rerunState.finishedAt = new Date().toISOString();
      appendTestRerunLog(
        rerunState,
        accepted
          ? "Rerun completed successfully"
          : (testsUnableToRunReason ?? (rejectionReasons.length ? rejectionReasons.join(" · ") : "Rerun completed with rejection")),
      );
    } catch (err) {
      if (err instanceof CommandAbortedError || rerunState.stopRequested || rerunState.abortController.signal.aborted) {
        rerunState.status = "stopped";
        rerunState.finishedAt = new Date().toISOString();
        rerunState.error = undefined;
        appendTestRerunLog(rerunState, "Rerun stopped by user");
        return;
      }
      rerunState.status = "failed";
      rerunState.finishedAt = new Date().toISOString();
      rerunState.error = err instanceof Error ? err.message : String(err);
      appendTestRerunLog(rerunState, `Rerun failed: ${rerunState.error}`);
    } finally {
      if (snapshot) {
        cleanupSnapshot(rerunConfig, snapshot, { force: true });
      }
      scheduleActiveTestRerunCleanup(candidateId);
    }
  };

  /* ---------------------------------------------------------------- */
  /* Stats                                                             */
  /* ---------------------------------------------------------------- */
  app.get("/api/stats", (_req, res) => {
    res.json(getStats(db));
  });

  /* ---------------------------------------------------------------- */
  /* Repos                                                             */
  /* ---------------------------------------------------------------- */
  app.get("/api/repos", (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Number(req.query.offset) || 0;
    const search = typeof req.query.search === "string" ? req.query.search : undefined;
    res.json(getRepos(db, { search, limit, offset }));
  });

  app.get("/api/repos/:id", (req, res) => {
    const data = getRepoById(db, Number(req.params.id));
    if (!data) return res.status(404).json({ error: "repo not found" });
    res.json(data);
  });

  app.delete("/api/repos/:id", (req, res) => {
    const ok = deleteRepo(db, Number(req.params.id));
    if (!ok) return res.status(404).json({ error: "repo not found" });
    res.json({ deleted: true });
  });

  app.post("/api/repos/:id/setup", (req, res) => {
    const repoId = Number(req.params.id);
    if (!Number.isFinite(repoId)) {
      return res.status(400).json({ error: "invalid repo id" });
    }

    const repoRow = getRepoRecordById(db, repoId);
    if (!repoRow) {
      return res.status(404).json({ error: "repo not found" });
    }

    const requestBody = asRecord(req.body) ?? {};
    const requestedProfileId = Number(requestBody.profileId);
    try {
      return res.status(202).json(startSetupTarget(repoRowToSetupTarget(repoRow), Number.isFinite(requestedProfileId) ? requestedProfileId : undefined));
    } catch (err) {
      const status = err instanceof RequestValidationError ? 400 : 500;
      return res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/issues/:id/setup", (req, res) => {
    const issueId = Number(req.params.id);
    if (!Number.isFinite(issueId)) {
      return res.status(400).json({ error: "invalid issue id" });
    }

    const issueRow = getIssueRecordById(db, issueId);
    if (!issueRow) {
      return res.status(404).json({ error: "issue not found" });
    }

    const requestBody = asRecord(req.body) ?? {};
    const requestedProfileId = Number(requestBody.profileId);
    try {
      return res.status(202).json(startSetupTarget(issueRowToSetupTarget(issueRow), Number.isFinite(requestedProfileId) ? requestedProfileId : undefined));
    } catch (err) {
      const status = err instanceof RequestValidationError ? 400 : 500;
      return res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /* ---------------------------------------------------------------- */
  /* Setup                                                             */
  /* ---------------------------------------------------------------- */
  app.get("/api/setup/profiles", (_req, res) => {
    res.json(getSetupProfiles(db));
  });

  app.post("/api/setup/profiles", (req, res) => {
    try {
      const input = parseSetupProfilePayload(req.body, config.setupDefaultCloneRoot);
      const id = createSetupProfile(db, input);
      const profile = getSetupProfileById(db, id);
      return res.status(201).json(profile);
    } catch (err) {
      if (err instanceof RequestValidationError) {
        return res.status(400).json({ error: err.message });
      }
      if (isUniqueSetupProfileNameError(err)) {
        return res.status(409).json({ error: "a setup profile with that name already exists" });
      }
      return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.put("/api/setup/profiles/:id", (req, res) => {
    const profileId = Number(req.params.id);
    if (!Number.isFinite(profileId)) {
      return res.status(400).json({ error: "invalid profile id" });
    }
    if (!getSetupProfileById(db, profileId)) {
      return res.status(404).json({ error: "setup profile not found" });
    }

    try {
      const input = parseSetupProfilePayload(req.body, config.setupDefaultCloneRoot);
      updateSetupProfile(db, profileId, input);
      return res.json(getSetupProfileById(db, profileId));
    } catch (err) {
      if (err instanceof RequestValidationError) {
        return res.status(400).json({ error: err.message });
      }
      if (isUniqueSetupProfileNameError(err)) {
        return res.status(409).json({ error: "a setup profile with that name already exists" });
      }
      return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete("/api/setup/profiles/:id", (req, res) => {
    const profileId = Number(req.params.id);
    if (!Number.isFinite(profileId)) {
      return res.status(400).json({ error: "invalid profile id" });
    }
    const ok = deleteSetupProfile(db, profileId);
    if (!ok) {
      return res.status(404).json({ error: "setup profile not found" });
    }
    return res.json({ deleted: true });
  });

  app.get("/api/setup/runs", (req, res) => {
    const repoId = typeof req.query.repoId === "string" && req.query.repoId.trim()
      ? Number(req.query.repoId)
      : undefined;
    const issueId = typeof req.query.issueId === "string" && req.query.issueId.trim()
      ? Number(req.query.issueId)
      : undefined;
    if (req.query.repoId !== undefined && !Number.isFinite(repoId)) {
      return res.status(400).json({ error: "invalid repo id" });
    }
    if (req.query.issueId !== undefined && !Number.isFinite(issueId)) {
      return res.status(400).json({ error: "invalid issue id" });
    }
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const offset = Number(req.query.offset) || 0;
    const data = getSetupRuns(db, { repoId, issueId, limit, offset });
    return res.json({
      total: data.total,
      rows: data.rows.map((row) => setupRunStateToApi(row, activeSetupRunStates.get(row.id))),
    });
  });

  app.get("/api/setup/runs/:id", (req, res) => {
    const runId = Number(req.params.id);
    if (!Number.isFinite(runId)) {
      return res.status(400).json({ error: "invalid setup run id" });
    }
    const run = getSetupRunById(db, runId);
    if (!run) {
      return res.status(404).json({ error: "setup run not found" });
    }
    const active = activeSetupRunStates.get(runId);
    const stdoutPath = active?.stdoutPath ?? run.stdoutPath;
    const stderrPath = active?.stderrPath ?? run.stderrPath;
    const lastMessagePath = active?.lastMessagePath ?? run.lastMessagePath;
    const diffPath = active?.diffPath ?? run.diffPath;
    return res.json({
      ...setupRunStateToApi(run, active),
      stdoutExcerpt: readLogExcerpt(stdoutPath, 12_000) ?? "",
      stderrExcerpt: readLogExcerpt(stderrPath, 12_000) ?? "",
      lastMessage: readUtf8Safe(lastMessagePath ?? "") ?? "",
      diffExcerpt: readLogExcerpt(diffPath, 20_000) ?? "",
    });
  });

  app.post("/api/setup/runs/:id/stop", (req, res) => {
    const runId = Number(req.params.id);
    if (!Number.isFinite(runId)) {
      return res.status(400).json({ error: "invalid setup run id" });
    }
    const active = activeSetupRunStates.get(runId);
    if (!active || active.status !== "running") {
      return res.status(409).json({ error: "this setup task is not currently running" });
    }
    const run = getSetupRunById(db, runId);
    if (!run) {
      return res.status(404).json({ error: "setup run not found" });
    }
    active.stopRequested = true;
    appendSetupRunLog(active, "Stop requested by user");
    active.abortController.abort();
    return res.json(setupRunStateToApi(run, active));
  });

  /* ---------------------------------------------------------------- */
  /* Issues                                                            */
  /* ---------------------------------------------------------------- */
  app.get("/api/issues", (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Number(req.query.offset) || 0;
    res.json(getIssues(db, { limit, offset }));
  });

  app.get("/api/accepted", (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const offset = Number(req.query.offset) || 0;
    const reviewStatus = typeof req.query.reviewStatus === "string" ? req.query.reviewStatus : "all";
    const data = getAcceptedCandidates(db, { limit, offset, reviewStatus });
    const issuesByCandidate = getIssuesForCandidateIds(db, data.rows.map((row) => Number(row.id)));
    const rows = data.rows.map((row) => ({
      ...candidateRowToApi(row),
      issues: issuesByCandidate[Number(row.id)] ?? [],
      activeTestRun: activeAcceptedTestRunStates.has(Number(row.id))
        ? rerunStateToApi(activeAcceptedTestRunStates.get(Number(row.id)) as ActiveAcceptedTestRunState)
        : null,
      activeCodexReview: (() => {
        const details = safeParseJson<Record<string, unknown>>(row.details_json, {});
        const task = normalizeCodexTaskState(details);
        if (!task) return null;
        const active = activeCodexReviewRunStates.get(codexReviewRunKey(Number(row.id), task.currentRound));
        return active ? codexReviewStateToApi(active) : null;
      })(),
    }));
    res.json({
      total: data.total,
      rows,
    });
  });

  app.post("/api/accepted/:id/start-task", async (req, res) => {
    const candidateId = Number(req.params.id);
    if (!Number.isFinite(candidateId)) {
      return res.status(400).json({ error: "invalid candidate id" });
    }

    const row = getScanCandidateById(db, candidateId);
    if (!row) {
      return res.status(404).json({ error: "accepted candidate not found" });
    }
    if (!row.accepted) {
      return res.status(409).json({ error: "candidate is not currently accepted" });
    }

    const requestBody = asRecord(req.body) ?? {};
    const hfiUuid = asNonEmptyString(requestBody.hfiUuid);
    if (!hfiUuid) {
      return res.status(400).json({ error: "HFI UUID is required" });
    }

    try {
      const originalRepoPath = assertAbsoluteExistingPath(requestBody.originalRepoPath, "Original repo path");
      const worktreeAPath = assertAbsoluteExistingPath(requestBody.worktreeAPath, "Worktree A path");
      const worktreeBPath = assertAbsoluteExistingPath(requestBody.worktreeBPath, "Worktree B path");
      const testCommand = asNonEmptyString(requestBody.testCommand);
      if (worktreeAPath === worktreeBPath) {
        throw new RequestValidationError("Worktree A path and Worktree B path must be different");
      }
      if (originalRepoPath === worktreeAPath || originalRepoPath === worktreeBPath) {
        throw new RequestValidationError("Original repo path must be different from the A and B worktree paths");
      }

      await Promise.all([
        assertGitRepository(originalRepoPath, "Original repo path"),
        assertGitRepository(worktreeAPath, "Worktree A path"),
        assertGitRepository(worktreeBPath, "Worktree B path"),
      ]);

      const details = safeParseJson<Record<string, unknown>>(row.details_json, {});
      const issues = getIssuesForCandidate(db, candidateId);
      const issue = pickPrimaryIssue(issues, row);
      const prContext = await resolveCodexPrContext(github, row);
      const promptOne = buildPromptOne(issue);
      const task: CodexTaskState = {
        hfiUuid,
        originalRepoPath,
        worktreeAPath,
        worktreeBPath,
        testCommand,
        currentRound: 1,
        maxPrompts: CODEX_TASK_MAX_PROMPTS,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        issue,
        prContext,
        prompts: [makePromptDraft(1, promptOne, "issue_rewrite")],
        rounds: [],
      };
      persistCodexTask(row, details, task);
      const updated = getScanCandidateById(db, candidateId);
      const updatedDetails = safeParseJson<Record<string, unknown>>(updated.details_json, {});
      return res.json({
        ...codexTaskPayload(updated, updatedDetails),
        tmux: buildTmuxSessionInfo(hfiUuid),
      });
    } catch (err) {
      const status = err instanceof RequestValidationError ? 400 : 500;
      return res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/accepted/:id/codex-task", (req, res) => {
    const candidateId = Number(req.params.id);
    if (!Number.isFinite(candidateId)) {
      return res.status(400).json({ error: "invalid candidate id" });
    }
    const row = getScanCandidateById(db, candidateId);
    if (!row) {
      return res.status(404).json({ error: "accepted candidate not found" });
    }
    const details = safeParseJson<Record<string, unknown>>(row.details_json, {});
    const payload = codexTaskPayload(row, details);
    if (!payload.task) {
      return res.status(404).json({ error: "codex task has not been started for this candidate" });
    }
    return res.json({
      ...payload,
      tmux: buildTmuxSessionInfo(payload.task.hfiUuid),
    });
  });

  app.post("/api/accepted/:id/codex-task/round/:round/review", async (req, res) => {
    const candidateId = Number(req.params.id);
    const round = Number(req.params.round);
    if (!Number.isFinite(candidateId) || !Number.isFinite(round)) {
      return res.status(400).json({ error: "invalid candidate id or round" });
    }
    if (round < 1 || round > CODEX_TASK_MAX_PROMPTS) {
      return res.status(400).json({ error: `round must be between 1 and ${CODEX_TASK_MAX_PROMPTS}` });
    }
    const key = codexReviewRunKey(candidateId, round);
    const existing = activeCodexReviewRunStates.get(key);
    if (existing?.status === "running") {
      return res.status(409).json({ error: "a Codex review is already running for this round" });
    }

    const codexCheck = await runCommand({ cmd: "which", args: ["codex"], timeoutMs: 15_000 });
    if (codexCheck.code !== 0) {
      return res.status(400).json({ error: "local codex CLI was not found in PATH" });
    }

    const row = getScanCandidateById(db, candidateId);
    if (!row) {
      return res.status(404).json({ error: "accepted candidate not found" });
    }
    const details = safeParseJson<Record<string, unknown>>(row.details_json, {});
    const task = normalizeCodexTaskState(details);
    if (!task) {
      return res.status(409).json({ error: "start the Codex task before generating a review" });
    }
    if (round !== task.currentRound) {
      return res.status(409).json({ error: `round ${task.currentRound} is the next available review round` });
    }
    if (!promptForRound(task, round)) {
      return res.status(409).json({ error: `no prompt is saved for round ${round}` });
    }

    const requestBody = asRecord(req.body) ?? {};
    const notesA = asNonEmptyString(requestBody.notesA);
    const notesB = asNonEmptyString(requestBody.notesB);
    const runState: ActiveCodexReviewRunState = {
      candidateId,
      round,
      status: "running",
      stage: "Queued Codex review",
      startedAt: new Date().toISOString(),
      logs: [],
      liveOutput: "",
    };
    activeCodexReviewRunStates.set(key, runState);
    appendCodexReviewLog(runState, "Queued Codex review");

    void runCodexTaskReview(row, runState, details, task, notesA, notesB);
    return res.status(202).json(codexReviewStateToApi(runState));
  });

  app.post("/api/accepted/:id/codex-task/round/:round/save-draft", (req, res) => {
    const candidateId = Number(req.params.id);
    const round = Number(req.params.round);
    if (!Number.isFinite(candidateId) || !Number.isFinite(round)) {
      return res.status(400).json({ error: "invalid candidate id or round" });
    }

    const row = getScanCandidateById(db, candidateId);
    if (!row) {
      return res.status(404).json({ error: "accepted candidate not found" });
    }
    const details = safeParseJson<Record<string, unknown>>(row.details_json, {});
    const task = normalizeCodexTaskState(details);
    if (!task) {
      return res.status(409).json({ error: "start the Codex task before saving a draft" });
    }

    const requestBody = asRecord(req.body) ?? {};
    const winner = requestBody.winner === "B" ? "B" : "A";
    const draft = normalizeCodexReviewDraft({
      winner,
      modelA: asRecord(requestBody.modelA) ?? {},
      modelB: asRecord(requestBody.modelB) ?? {},
      axes: asRecord(requestBody.axes) ?? {},
      overallJustification: requestBody.overallJustification,
      winnerUnresolvedCons: requestBody.winnerUnresolvedCons,
      nextPrompt: requestBody.nextPrompt,
      confidenceNotes: requestBody.confidenceNotes,
      generatedAt: new Date().toISOString(),
      artifactDir: requestBody.artifactDir,
    });
    if (!draft) {
      return res.status(400).json({ error: "review draft payload is invalid" });
    }

    let updatedTask = upsertTaskRound(task, {
      round,
      notesA: roundForTask(task, round)?.notesA,
      notesB: roundForTask(task, round)?.notesB,
      reviewDraft: draft,
      artifactDir: draft.artifactDir,
      generatedAt: new Date().toISOString(),
      promptGeneratedForNextRound: round < CODEX_TASK_MAX_PROMPTS ? round + 1 : undefined,
    });
    if (round < CODEX_TASK_MAX_PROMPTS && draft.nextPrompt.trim()) {
      updatedTask = upsertPromptDraft(updatedTask, makePromptDraft(round + 1, draft.nextPrompt, "review_follow_up"));
    }
    persistCodexTask(row, details, updatedTask);
    const updated = getScanCandidateById(db, candidateId);
    const updatedDetails = safeParseJson<Record<string, unknown>>(updated.details_json, {});
    return res.json({
      ...codexTaskPayload(updated, updatedDetails),
      tmux: buildTmuxSessionInfo(updatedTask.hfiUuid),
    });
  });

  app.get("/api/accepted/:id/codex-task/round/:round/status", (req, res) => {
    const candidateId = Number(req.params.id);
    const round = Number(req.params.round);
    if (!Number.isFinite(candidateId) || !Number.isFinite(round)) {
      return res.status(400).json({ error: "invalid candidate id or round" });
    }
    const run = activeCodexReviewRunStates.get(codexReviewRunKey(candidateId, round));
    if (!run) {
      return res.json({ candidateId, round, running: false, status: "idle", logs: [], liveOutput: "" });
    }
    return res.json(codexReviewStateToApi(run));
  });

  app.get("/api/accepted/:id/dockerfile", async (req, res) => {
    const candidateId = Number(req.params.id);
    if (!Number.isFinite(candidateId)) {
      return res.status(400).json({ error: "invalid candidate id" });
    }

    const row = getScanCandidateById(db, candidateId);
    if (!row) {
      return res.status(404).json({ error: "accepted candidate not found" });
    }
    if (!row.accepted) {
      return res.status(409).json({ error: "candidate is not currently accepted" });
    }

    const details = safeParseJson<Record<string, unknown>>(row.details_json, {});
    const requestedPath = typeof req.query.path === "string" && req.query.path.trim()
      ? normalizeRelativeFilePath(req.query.path)
      : undefined;

    try {
      return res.json(await loadCandidateDockerfilePayload(github, config, row, details, requestedPath));
    } catch (err) {
      const status = err instanceof RequestValidationError ? 400 : 500;
      return res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/accepted/:id/generate-test-dockerfile", async (req, res) => {
    const candidateId = Number(req.params.id);
    if (!Number.isFinite(candidateId)) {
      return res.status(400).json({ error: "invalid candidate id" });
    }
    if (!config.geminiApiKey) {
      return res.status(400).json({ error: "Gemini is not configured for Dockerfile generation" });
    }

    const row = getScanCandidateById(db, candidateId);
    if (!row) {
      return res.status(404).json({ error: "accepted candidate not found" });
    }
    if (!row.accepted) {
      return res.status(409).json({ error: "candidate is not currently accepted" });
    }
    if (!row.pre_fix_sha) {
      return res.status(400).json({ error: "candidate is missing the pre-fix SHA needed to generate a Dockerfile" });
    }

    const requestBody = asRecord(req.body) ?? {};
    let requestedDockerfilePath: string | undefined;
    try {
      requestedDockerfilePath = asNonEmptyString(requestBody.dockerfilePath)
        ? normalizeRelativeFilePath(String(requestBody.dockerfilePath))
        : undefined;
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }

    const repo = toSearchRepo(row);
    const details = safeParseJson<Record<string, unknown>>(row.details_json, {});
    let snapshot: Awaited<ReturnType<typeof prepareSnapshot>> | undefined;

    try {
      snapshot = await prepareSnapshot(config, repo, String(row.pre_fix_sha));
      const dockerfilePath = requestedDockerfilePath ?? (preferredDockerfilePath(details, snapshot.files) ?? "Dockerfile");
      const sourceFullPath = resolveSnapshotFilePath(snapshot.rootDir, dockerfilePath);
      const sourceContent = readUtf8Safe(sourceFullPath);
      if (sourceContent === undefined) {
        return res.status(404).json({ error: `Dockerfile ${dockerfilePath} was not found in the pre-fix snapshot` });
      }

      let plan = await resolveTestPlan(config, snapshot, dockerfilePath);
      if (!plan) {
        return res.status(400).json({ error: "No Docker build plan could be inferred for this candidate" });
      }
      plan = forceDockerfileOnPlan(plan, dockerfilePath);
      if (!plan.testCommand.length) {
        return res.status(400).json({ error: "No safe test command could be inferred for this repository" });
      }

      const suggestion = await generateDockerfileForTests(config, snapshot, plan, dockerfilePath);
      if (!suggestion?.dockerfileContent?.trim()) {
        return res.status(500).json({ error: "Gemini could not produce a Dockerfile for running tests" });
      }

      const currentAcceptedTest = asRecord(details.acceptedTest) ?? {};
      details.acceptedTest = {
        ...currentAcceptedTest,
        dockerfile: makeDockerfileState(dockerfilePath, suggestion.dockerfileContent, "gemini", suggestion.reasoningSummary),
        testPlan: plan,
      };

      updateScanCandidateState(db, candidateId, {
        accepted: Boolean(row.accepted),
        rejectionReasons: safeParseJson<string[]>(row.rejection_reasons, []),
        testsUnableToRun: Boolean(row.tests_unable_to_run),
        testsUnableToRunReason: typeof row.tests_unable_to_run_reason === "string" ? row.tests_unable_to_run_reason : undefined,
        detailsJson: JSON.stringify(details),
      });

      return res.json({
        path: dockerfilePath,
        content: suggestion.dockerfileContent,
        source: "gemini",
        reasoningSummary: suggestion.reasoningSummary,
        availablePaths: unique([...listDockerfilePaths(snapshot.files), dockerfilePath]),
      });
    } catch (err) {
      return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      if (snapshot) {
        cleanupSnapshot(config, snapshot, { force: true });
      }
    }
  });

  app.post("/api/accepted/:id/fix-test-dockerfile", async (req, res) => {
    const candidateId = Number(req.params.id);
    if (!Number.isFinite(candidateId)) {
      return res.status(400).json({ error: "invalid candidate id" });
    }
    if (!config.geminiApiKey) {
      return res.status(400).json({ error: "Gemini is not configured for Dockerfile fixing" });
    }

    const row = getScanCandidateById(db, candidateId);
    if (!row) {
      return res.status(404).json({ error: "accepted candidate not found" });
    }
    if (!row.accepted) {
      return res.status(409).json({ error: "candidate is not currently accepted" });
    }
    if (!row.pre_fix_sha) {
      return res.status(400).json({ error: "candidate is missing the pre-fix SHA needed to fix a Dockerfile" });
    }

    const details = safeParseJson<Record<string, unknown>>(row.details_json, {});
    const requestBody = asRecord(req.body) ?? {};
    let requestedDockerfilePath: string | undefined;
    try {
      requestedDockerfilePath = asNonEmptyString(requestBody.dockerfilePath)
        ? normalizeRelativeFilePath(String(requestBody.dockerfilePath))
        : undefined;
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }

    const currentDockerfileContent = typeof requestBody.dockerfileContent === "string"
      ? requestBody.dockerfileContent
      : undefined;
    const failureOutput = typeof requestBody.errorOutput === "string" && requestBody.errorOutput.trim()
      ? requestBody.errorOutput.trim()
      : acceptedTestFailureOutput(details);
    if (!currentDockerfileContent?.trim()) {
      return res.status(400).json({ error: "dockerfile content is required before asking Gemini to fix it" });
    }
    if (!failureOutput?.trim()) {
      return res.status(400).json({ error: "no Docker test failure output is available to send to Gemini" });
    }

    const repo = toSearchRepo(row);
    let snapshot: Awaited<ReturnType<typeof prepareSnapshot>> | undefined;

    try {
      snapshot = await prepareSnapshot(config, repo, String(row.pre_fix_sha));
      const dockerfilePath = requestedDockerfilePath
        ?? asNonEmptyString(acceptedTestDockerfile(details)?.path)
        ?? (preferredDockerfilePath(details, snapshot.files) ?? "Dockerfile");
      applyDockerfileOverride(snapshot, details, dockerfilePath, currentDockerfileContent);

      let plan = await resolveTestPlan(config, snapshot, dockerfilePath);
      if (!plan) {
        return res.status(400).json({ error: "No Docker build plan could be inferred for this candidate" });
      }
      plan = forceDockerfileOnPlan(plan, dockerfilePath);
      if (!plan.testCommand.length) {
        return res.status(400).json({ error: "No safe test command could be inferred for this repository" });
      }

      const suggestion = await fixDockerfileForTestFailure(config, snapshot, plan, dockerfilePath, currentDockerfileContent, failureOutput);
      if (!suggestion?.dockerfileContent?.trim()) {
        return res.status(500).json({ error: "Gemini could not propose a Dockerfile fix from that failure" });
      }

      const currentAcceptedTest = asRecord(details.acceptedTest) ?? {};
      details.acceptedTest = {
        ...currentAcceptedTest,
        dockerfile: makeDockerfileState(dockerfilePath, suggestion.dockerfileContent, "gemini_fix", suggestion.reasoningSummary),
        testPlan: plan,
      };

      updateScanCandidateState(db, candidateId, {
        accepted: Boolean(row.accepted),
        rejectionReasons: safeParseJson<string[]>(row.rejection_reasons, []),
        testsUnableToRun: Boolean(row.tests_unable_to_run),
        testsUnableToRunReason: typeof row.tests_unable_to_run_reason === "string" ? row.tests_unable_to_run_reason : undefined,
        detailsJson: JSON.stringify(details),
      });

      return res.json({
        path: dockerfilePath,
        content: suggestion.dockerfileContent,
        source: "gemini_fix",
        reasoningSummary: suggestion.reasoningSummary,
      });
    } catch (err) {
      return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      if (snapshot) {
        cleanupSnapshot(config, snapshot, { force: true });
      }
    }
  });

  app.post("/api/accepted/:id/run-tests", async (req, res) => {
    const candidateId = Number(req.params.id);
    if (!Number.isFinite(candidateId)) {
      return res.status(400).json({ error: "invalid candidate id" });
    }
    const existing = activeAcceptedTestRunStates.get(candidateId);
    if (existing?.status === "running") {
      return res.status(409).json({ error: "this accepted candidate is already running Docker tests" });
    }

    const row = getScanCandidateById(db, candidateId);
    if (!row) {
      return res.status(404).json({ error: "accepted candidate not found" });
    }
    if (!row.accepted) {
      return res.status(409).json({ error: "candidate is not currently accepted" });
    }
    if (!row.pre_fix_sha) {
      return res.status(400).json({ error: "candidate is missing the pre-fix SHA needed to run Docker tests" });
    }

    const details = safeParseJson<Record<string, unknown>>(row.details_json, {});
    const requestBody = asRecord(req.body) ?? {};
    let dockerfilePath: string | undefined;
    try {
      dockerfilePath = asNonEmptyString(requestBody.dockerfilePath)
        ? normalizeRelativeFilePath(String(requestBody.dockerfilePath))
        : asNonEmptyString(acceptedTestDockerfile(details)?.path);
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
    const dockerfileContent = typeof requestBody.dockerfileContent === "string"
      ? requestBody.dockerfileContent
      : (typeof acceptedTestDockerfile(details)?.content === "string" ? String(acceptedTestDockerfile(details)?.content) : undefined);
    if (!dockerfilePath || !dockerfileContent?.trim()) {
      return res.status(400).json({ error: "load or generate a Dockerfile before running tests" });
    }

    const dockerfileSource = requestBody.dockerfileSource === "source"
      || requestBody.dockerfileSource === "gemini"
      || requestBody.dockerfileSource === "gemini_fix"
      || requestBody.dockerfileSource === "manual"
      ? requestBody.dockerfileSource
      : undefined;
    const reasoningSummary = typeof requestBody.reasoningSummary === "string" ? requestBody.reasoningSummary : undefined;

    const runState: ActiveAcceptedTestRunState = {
      candidateId,
      status: "running",
      stage: "Queued Docker test run",
      startedAt: new Date().toISOString(),
      logs: [],
      liveOutput: "",
      stopRequested: false,
      abortController: new AbortController(),
      dockerfileOverride: null,
    };
    activeAcceptedTestRunStates.set(candidateId, runState);
    appendTestRerunLog(runState, "Queued Docker test run");

    void runAcceptedTestRun(row, runState, {
      dockerfilePath,
      dockerfileContent,
      dockerfileSource,
      reasoningSummary,
    });

    return res.status(202).json(rerunStateToApi(runState));
  });

  app.get("/api/accepted/:id/test-run-status", (req, res) => {
    const candidateId = Number(req.params.id);
    if (!Number.isFinite(candidateId)) {
      return res.status(400).json({ error: "invalid candidate id" });
    }
    const run = activeAcceptedTestRunStates.get(candidateId);
    if (!run) {
      return res.json({ candidateId, running: false, status: "idle", liveOutput: "", logs: [] });
    }
    return res.json(rerunStateToApi(run));
  });

  app.post("/api/accepted/:id/stop-test-run", (req, res) => {
    const candidateId = Number(req.params.id);
    if (!Number.isFinite(candidateId)) {
      return res.status(400).json({ error: "invalid candidate id" });
    }
    const run = activeAcceptedTestRunStates.get(candidateId);
    if (!run || run.status !== "running") {
      return res.status(409).json({ error: "this accepted candidate is not currently running Docker tests" });
    }
    run.stopRequested = true;
    appendTestRerunLog(run, "Stop requested by user");
    run.abortController.abort();
    return res.json(rerunStateToApi(run));
  });

  app.post("/api/candidates/:id/manual-repro-usage", (req, res) => {
    const candidateId = Number(req.params.id);
    if (!Number.isFinite(candidateId)) {
      return res.status(400).json({ error: "invalid candidate id" });
    }

    const row = getScanCandidateById(db, candidateId);
    if (!row) {
      return res.status(404).json({ error: "candidate not found" });
    }

    const requestBody = asRecord(req.body) ?? {};
    const used = typeof requestBody.used === "boolean" ? requestBody.used : true;
    const details = safeParseJson<Record<string, unknown>>(row.details_json, {});
    const current = asRecord(details.manualRepro);
    const now = new Date().toISOString();
    details.manualRepro = used
      ? {
          used: true,
          usedAt: asNonEmptyString(current?.usedAt) ?? now,
          updatedAt: now,
        }
      : {
          used: false,
          usedAt: null,
          updatedAt: now,
        };

    updateScanCandidateState(db, candidateId, {
      accepted: Boolean(row.accepted),
      rejectionReasons: safeParseJson<string[]>(row.rejection_reasons, []),
      testsUnableToRun: Boolean(row.tests_unable_to_run),
      testsUnableToRunReason: typeof row.tests_unable_to_run_reason === "string" ? row.tests_unable_to_run_reason : undefined,
      detailsJson: JSON.stringify(details),
    });

    const updated = getScanCandidateById(db, candidateId);
    return res.json({
      ...candidateRowToApi(updated),
      issues: getIssuesForCandidate(db, candidateId),
    });
  });

  app.post("/api/candidates/:id/review", (req, res) => {
    const candidateId = Number(req.params.id);
    if (!Number.isFinite(candidateId)) {
      return res.status(400).json({ error: "invalid candidate id" });
    }

    const row = getScanCandidateById(db, candidateId);
    if (!row) {
      return res.status(404).json({ error: "candidate not found" });
    }

    const requestBody = asRecord(req.body) ?? {};
    const details = safeParseJson<Record<string, unknown>>(row.details_json, {});
    const current = asRecord(details.reviewQueue);
    const now = new Date().toISOString();
    const status = normalizeReviewStatus(requestBody.status);
    const notes = typeof requestBody.notes === "string" ? requestBody.notes.trim() : (asNonEmptyString(current?.notes) ?? "");
    details.reviewQueue = {
      status,
      notes,
      updatedAt: now,
      createdAt: asNonEmptyString(current?.createdAt) ?? now,
    };

    updateScanCandidateState(db, candidateId, {
      accepted: Boolean(row.accepted),
      rejectionReasons: safeParseJson<string[]>(row.rejection_reasons, []),
      testsUnableToRun: Boolean(row.tests_unable_to_run),
      testsUnableToRunReason: typeof row.tests_unable_to_run_reason === "string" ? row.tests_unable_to_run_reason : undefined,
      detailsJson: JSON.stringify(details),
    });

    const updated = getScanCandidateById(db, candidateId);
    return res.json({
      ...candidateRowToApi(updated),
      issues: getIssuesForCandidate(db, candidateId),
    });
  });

  app.post("/api/accepted/:id/manual-reject", (req, res) => {
    const candidateId = Number(req.params.id);
    if (!Number.isFinite(candidateId)) {
      return res.status(400).json({ error: "invalid candidate id" });
    }

    const row = getScanCandidateById(db, candidateId);
    if (!row) {
      return res.status(404).json({ error: "candidate not found" });
    }
    if (!row.accepted) {
      return res.status(409).json({ error: "candidate is not currently accepted" });
    }

    const details = safeParseJson<Record<string, unknown>>(row.details_json, {});
    const now = new Date().toISOString();
    const manualRejectReason = "manually rejected by user";
    details.manualReview = {
      rejected: true,
      rejectedAt: now,
      reason: manualRejectReason,
    };
    details.reviewQueue = {
      status: "follow_up",
      notes: asNonEmptyString(asRecord(details.reviewQueue)?.notes) ?? manualRejectReason,
      updatedAt: now,
      createdAt: asNonEmptyString(asRecord(details.reviewQueue)?.createdAt) ?? now,
    };

    updateScanCandidateState(db, candidateId, {
      accepted: Boolean(row.accepted),
      rejectionReasons: safeParseJson<string[]>(row.rejection_reasons, []),
      testsUnableToRun: Boolean(row.tests_unable_to_run),
      testsUnableToRunReason: typeof row.tests_unable_to_run_reason === "string" ? row.tests_unable_to_run_reason : undefined,
      detailsJson: JSON.stringify(details),
    });

    const updated = getScanCandidateById(db, candidateId);
    return res.json({
      ...candidateRowToApi(updated),
      issues: getIssuesForCandidate(db, candidateId),
    });
  });

  app.get("/api/tests-unable", (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 25, 100);
    const data = getTestsUnableCandidates(db, limit);
    res.json({
      total: data.total,
      rows: data.rows.map((row) => ({
        ...candidateRowToApi(row),
        activeRerun: activeTestRerunStates.has(Number(row.id))
          ? rerunStateToApi(activeTestRerunStates.get(Number(row.id)) as ActiveTestRerunState)
          : null,
      })),
    });
  });

  app.get("/api/tests-unable/:id/dockerfile", async (req, res) => {
    const candidateId = Number(req.params.id);
    if (!Number.isFinite(candidateId)) {
      return res.status(400).json({ error: "invalid candidate id" });
    }

    const row = getScanCandidateById(db, candidateId);
    if (!row) {
      return res.status(404).json({ error: "tests-unable candidate not found" });
    }
    if (!row.pre_fix_sha) {
      return res.status(400).json({ error: "candidate is missing the pre-fix SHA needed to load its Dockerfile" });
    }

    const details = safeParseJson<Record<string, unknown>>(row.details_json, {});
    const repo = toSearchRepo(row);
    const requestedPath = typeof req.query.path === "string" && req.query.path.trim()
      ? normalizeRelativeFilePath(req.query.path)
      : undefined;

    try {
      const tree = await github.getRepoTree(repo, String(row.pre_fix_sha));
      const files = tree
        .filter((item) => item.type === "blob")
        .map((item) => item.path);
      const availablePaths = listDockerfilePaths(files);
      const resolvedPath = requestedPath ?? (preferredDockerfilePath(details, files) ?? "Dockerfile");
      const exists = files.includes(resolvedPath);
      const content = exists
        ? (await github.getFile(repo, resolvedPath, String(row.pre_fix_sha)) ?? "")
        : "";
      return res.json({
        path: resolvedPath,
        content,
        exists,
        availablePaths,
      });
    } catch (err) {
      if (err instanceof RequestValidationError) {
        return res.status(400).json({ error: err.message });
      }

      let snapshot: Awaited<ReturnType<typeof prepareSnapshot>> | undefined;
      try {
        snapshot = await prepareSnapshot(config, repo, String(row.pre_fix_sha));
        const availablePaths = listDockerfilePaths(snapshot.files);
        const resolvedPath = requestedPath ?? (preferredDockerfilePath(details, snapshot.files) ?? "Dockerfile");
        const fullPath = resolveSnapshotFilePath(snapshot.rootDir, resolvedPath);
        const exists = snapshot.files.includes(resolvedPath);
        const content = exists ? (readUtf8Safe(fullPath) ?? "") : "";
        return res.json({
          path: resolvedPath,
          content,
          exists,
          availablePaths,
        });
      } catch (fallbackErr) {
        const status = fallbackErr instanceof RequestValidationError ? 400 : 500;
        return res.status(status).json({ error: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr) });
      } finally {
        if (snapshot) {
          cleanupSnapshot(config, snapshot, { force: true });
        }
      }
    }
  });

  app.post("/api/tests-unable/:id/rerun", async (req, res) => {
    const candidateId = Number(req.params.id);
    if (!Number.isFinite(candidateId)) {
      return res.status(400).json({ error: "invalid candidate id" });
    }
    const existing = activeTestRerunStates.get(candidateId);
    if (existing?.status === "running") {
      return res.status(409).json({ error: "this candidate is already being rerun" });
    }

    const row = getScanCandidateById(db, candidateId);
    if (!row) {
      return res.status(404).json({ error: "tests-unable candidate not found" });
    }
    if (!row.pre_fix_sha) {
      return res.status(400).json({ error: "candidate is missing the pre-fix SHA needed for rerun" });
    }

    const requestBody = asRecord(req.body) ?? {};
    let requestedDockerfilePath: string | undefined;
    try {
      requestedDockerfilePath = asNonEmptyString(requestBody.dockerfilePath)
        ? normalizeRelativeFilePath(String(requestBody.dockerfilePath))
        : undefined;
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
    const requestedDockerfileContent = typeof requestBody.dockerfileContent === "string"
      ? requestBody.dockerfileContent
      : undefined;

    const rerunState: ActiveTestRerunState = {
      candidateId,
      status: "running",
      stage: "Queued rerun",
      startedAt: new Date().toISOString(),
      logs: [],
      liveOutput: "",
      stopRequested: false,
      abortController: new AbortController(),
      dockerfileOverride: null,
    };
    activeTestRerunStates.set(candidateId, rerunState);
    appendTestRerunLog(rerunState, "Queued rerun");

    void runTestsUnableRerun(row, rerunState, {
      dockerfilePath: requestedDockerfilePath,
      dockerfileContent: requestedDockerfileContent,
    });

    return res.status(202).json(rerunStateToApi(rerunState));
  });

  app.get("/api/tests-unable/:id/rerun-status", (req, res) => {
    const candidateId = Number(req.params.id);
    if (!Number.isFinite(candidateId)) {
      return res.status(400).json({ error: "invalid candidate id" });
    }
    const rerun = activeTestRerunStates.get(candidateId);
    if (!rerun) {
      return res.json({ candidateId, running: false, status: "idle", liveOutput: "", logs: [] });
    }
    return res.json(rerunStateToApi(rerun));
  });

  app.post("/api/tests-unable/:id/stop", (req, res) => {
    const candidateId = Number(req.params.id);
    if (!Number.isFinite(candidateId)) {
      return res.status(400).json({ error: "invalid candidate id" });
    }
    const rerun = activeTestRerunStates.get(candidateId);
    if (!rerun || rerun.status !== "running") {
      return res.status(409).json({ error: "this candidate is not currently rerunning" });
    }
    rerun.stopRequested = true;
    appendTestRerunLog(rerun, "Stop requested by user");
    rerun.abortController.abort();
    return res.json(rerunStateToApi(rerun));
  });

  /* ---------------------------------------------------------------- */
  /* Scans                                                             */
  /* ---------------------------------------------------------------- */
  app.get("/api/scans", (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Number(req.query.offset) || 0;
    res.json(getScans(db, limit, offset));
  });

  app.get("/api/scans/:id", (req, res) => {
    const data = getScanById(db, Number(req.params.id));
    if (!data) return res.status(404).json({ error: "scan not found" });
    res.json(data);
  });

  app.get("/api/scans/active/logs", (_req, res) => {
    if (!activeScan) {
      return res.json({ running: false, status: "completed", logs: [], currentStage: "", summary: null, metrics: null });
    }
    res.json({
      running: activeScan.status === "running",
      status: activeScan.status,
      logs: activeScan.logs,
      currentStage: activeScan.currentStage,
      summary: activeScan.summary,
      startedAt: activeScan.startedAt,
      finishedAt: activeScan.finishedAt ?? null,
      scanId: activeScan.scanId ?? null,
      metrics: activeScan.metrics ?? null,
    });
  });

  app.post("/api/scans", (req, res) => {
    if (activeScan?.status === "running") {
      return res.status(409).json({ error: "a scan is already running" });
    }

    const overrides: ScanConfigOverrides = req.body ?? {};
    const validLanguages: Language[] = ["python", "javascript", "typescript"];
    const scanConfig: Config = {
      ...config,
      languages: Array.isArray(overrides.languages)
        ? overrides.languages.filter((l) => validLanguages.includes(l))
        : config.languages,
      repoLimit: typeof overrides.repoLimit === "number" ? overrides.repoLimit : config.repoLimit,
      repoConcurrency: typeof overrides.repoConcurrency === "number"
        ? Math.max(1, Math.floor(overrides.repoConcurrency))
        : config.repoConcurrency,
      prLimit: typeof overrides.prLimit === "number" ? overrides.prLimit : config.prLimit,
      minStars: typeof overrides.minStars === "number" ? overrides.minStars : config.minStars,
      mergedAfter: typeof overrides.mergedAfter === "string" ? overrides.mergedAfter : config.mergedAfter,
      scanMode: overrides.scanMode === "pr-first" ? "pr-first" : (overrides.scanMode === "issue-first" ? "issue-first" : config.scanMode),
      targetRepo: typeof overrides.targetRepo === "string"
        ? (overrides.targetRepo.trim() || undefined)
        : config.targetRepo,
      dryRun: typeof overrides.dryRun === "boolean" ? overrides.dryRun : config.dryRun,
      keepWorktree: false,
    };

    const scanState: ActiveScanState = {
      logs: [],
      status: "running",
      currentStage: "Starting scan...",
      summary: emptyScanSummary(),
      startedAt: new Date().toISOString(),
    };
    appendScanLog(scanState, "Starting scan...");

    const promise = runScan(scanConfig, (msg) => {
      appendScanLog(scanState, msg);
    }, (summary) => {
      scanState.summary = summary;
    })
      .then((report) => {
        scanState.status = "completed";
        scanState.finishedAt = new Date().toISOString();
        scanState.scanId = report.scanId;
        scanState.metrics = report.performanceMetrics;
        scanState.summary = {
          ...scanState.summary,
          totalReposDiscovered: report.performanceMetrics.totalReposDiscovered,
          totalReposProcessed: report.performanceMetrics.totalReposProcessed,
          totalPullRequestsAnalyzed: report.performanceMetrics.totalPullRequestsAnalyzed,
          totalCandidatesRecorded: report.performanceMetrics.totalCandidatesRecorded,
          acceptedCount: report.accepted.length,
          rejectedCount: report.rejected.length,
        };
        appendScanLog(scanState, "Scan finished successfully");
      })
      .catch((err) => {
        scanState.status = "failed";
        scanState.finishedAt = new Date().toISOString();
        if (scanState.scanId) {
          const row = db.prepare("SELECT metrics_json FROM scans WHERE id = ?").get(scanState.scanId) as { metrics_json?: string | null } | undefined;
          if (row?.metrics_json) {
            scanState.metrics = JSON.parse(row.metrics_json) as ScanPerformanceMetrics;
          }
        }
        appendScanLog(scanState, `Scan failed: ${err instanceof Error ? err.message : String(err)}`);
      });

    scanState.promise = promise;
    activeScan = scanState;
    res.json({ started: true, message: "Scan started in the background" });
  });

  /* ---------------------------------------------------------------- */
  /* Fallback to SPA index                                             */
  /* ---------------------------------------------------------------- */
  app.get("/{*splat}", (_req, res) => {
    res.sendFile(join(publicDir, "index.html"));
  });

  return app;
}
