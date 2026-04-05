import type Database from "better-sqlite3";
import { join, resolve } from "node:path";
import { prepareSnapshot } from "./git.js";
import { GitHubClient } from "./github.js";
import {
  buildSetupPrompt,
  collectChangedFiles,
  isPathAllowedByPatterns,
  listSetupLockFiles,
  removeSetupLockFiles,
  writeGitDiff,
} from "./setup.js";
import { updateSetupRun } from "./db.js";
import type { Config, SearchRepo, SetupProfile, SetupRunRecord, SetupRunStatus, SetupTargetType } from "./types.js";
import { CommandAbortedError, ensureDir, readUtf8Safe, runCommand } from "./util.js";

export type SetupTaskTarget = {
  targetType: SetupTargetType;
  targetLabel: string;
  repoId: number;
  repo: SearchRepo;
  checkoutSha?: string;
  issueId?: number;
  issueNumber?: number;
  issueTitle?: string;
  issueBody?: string;
  issueUrl?: string;
  pullRequestNumber?: number;
  pullRequestTitle?: string;
  pullRequestUrl?: string;
};

export type ActiveSetupRunState = {
  runId: number;
  targetType: SetupTargetType;
  targetLabel: string;
  repoId: number;
  repoFullName: string;
  issueId?: number;
  profileId?: number;
  profileName?: string;
  status: SetupRunStatus;
  stage: string;
  startedAt: string;
  finishedAt?: string;
  logs: string[];
  liveOutput: string;
  stopRequested: boolean;
  abortController: AbortController;
  worktreePath?: string;
  stdoutPath?: string;
  stderrPath?: string;
  lastMessagePath?: string;
  diffPath?: string;
  changedFiles: string[];
  violationFiles: string[];
  summary?: string;
  error?: string;
};

function formatSpawnError(err: unknown, command: string): string {
  if (err && typeof err === "object" && "code" in err && (err as { code?: unknown }).code === "ENOENT") {
    return `Could not find the Codex CLI executable (${command}). Install Codex or set CODEX_CLI_PATH / --codex-cli-path to the correct path.`;
  }
  return err instanceof Error ? err.message : String(err);
}

async function resolveCodexExecutable(config: Config, signal?: AbortSignal): Promise<string> {
  const configured = config.codexCliPath?.trim();
  if (configured) {
    return configured;
  }

  const shell = process.env.SHELL?.trim() || "/bin/zsh";
  try {
    const result = await runCommand({
      cmd: shell,
      args: ["-lic", "command -v codex"],
      timeoutMs: 10_000,
      signal,
    });
    const resolvedPath = result.stdout.trim().split(/\r?\n/g).filter(Boolean).pop()?.trim();
    if (result.code === 0 && resolvedPath) {
      return resolvedPath;
    }
  } catch {
    // Fall through to the friendly error below.
  }

  throw new Error("Could not find the Codex CLI. Install it or set CODEX_CLI_PATH / --codex-cli-path to the executable path.");
}

export function appendSetupRunLog(run: ActiveSetupRunState, msg: string): void {
  const timestamp = new Date().toISOString();
  run.logs.push(`[${timestamp}] ${msg}`);
  run.stage = msg;
  if (run.logs.length > 300) {
    run.logs.splice(0, run.logs.length - 300);
  }
}

export function appendSetupRunOutput(run: ActiveSetupRunState, stream: "stdout" | "stderr", chunk: string): void {
  appendSetupRunOutputWithSource(run, "codex", stream, chunk);
}

function formatCommandDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 1000) {
    return `${Math.max(0, Math.round(durationMs))}ms`;
  }
  if (durationMs < 60_000) {
    return `${(durationMs / 1000).toFixed(1)}s`;
  }
  return `${(durationMs / 60_000).toFixed(1)}m`;
}

function appendSetupRunOutputWithSource(
  run: ActiveSetupRunState,
  source: string,
  stream: "stdout" | "stderr",
  chunk: string,
): void {
  const text = chunk.replace(/\r\n/g, "\n");
  const prefixed = text
    .split("\n")
    .map((line, index, items) => {
      if (!line && index === items.length - 1) return "";
      return `[${source}:${stream}] ${line}`;
    })
    .join("\n");
  run.liveOutput = `${run.liveOutput}${prefixed}${prefixed.endsWith("\n") ? "" : "\n"}`.slice(-160_000);
}

async function runSetupCommand(
  runState: ActiveSetupRunState,
  cwd: string,
  command: string,
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean; aborted: boolean }> {
  const startedAt = Date.now();
  const commandLabel = [command, ...args].join(" ");
  appendSetupRunLog(runState, `Running command: ${commandLabel}`);
  const result = await runCommand({
    cmd: command,
    args,
    cwd,
    signal: runState.abortController.signal,
    onStdoutChunk: (chunk) => appendSetupRunOutputWithSource(runState, command, "stdout", chunk),
    onStderrChunk: (chunk) => appendSetupRunOutputWithSource(runState, command, "stderr", chunk),
  });
  if (result.code !== 0) {
    appendSetupRunLog(
      runState,
      `Command failed after ${formatCommandDuration(Date.now() - startedAt)}: ${commandLabel}${result.stderr || result.stdout ? ` — ${(result.stderr || result.stdout).trim().split(/\r?\n/g)[0]}` : ""}`,
    );
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  appendSetupRunLog(runState, `Command passed after ${formatCommandDuration(Date.now() - startedAt)}: ${commandLabel}`);
  return result;
}

function extractSkippedSetupReason(finalMessage: string | undefined): string | undefined {
  if (!finalMessage) return undefined;
  const trimmed = finalMessage.trim();
  const match = trimmed.match(/^SKIP_SETUP:\s*(.+)$/is);
  if (!match) return undefined;
  const reason = match[1]?.trim();
  return reason || undefined;
}

async function finalizeSetupCommit(runState: ActiveSetupRunState, worktreePath: string): Promise<string | undefined> {
  if (!runState.changedFiles.length) {
    appendSetupRunLog(runState, "No setup changes detected; skipping setup commit");
    return undefined;
  }

  appendSetupRunLog(runState, "Configuring local git settings for the setup commit");
  await runSetupCommand(runState, worktreePath, "git", ["config", "core.fileMode", "false"]);
  await runSetupCommand(runState, worktreePath, "git", ["config", "user.name", "PR Writer"]);
  await runSetupCommand(runState, worktreePath, "git", ["config", "user.email", "prwriter@reveloexperts.com"]);

  appendSetupRunLog(runState, "Capturing git status before staging");
  await runSetupCommand(runState, worktreePath, "git", ["status", "--short"]);

  appendSetupRunLog(runState, "Staging setup changes");
  await runSetupCommand(runState, worktreePath, "git", ["add", "."]);

  appendSetupRunLog(runState, "Creating the setup diff");
  await writeGitDiff(worktreePath, runState.diffPath ?? join(worktreePath, "setup.diff"), { cached: true });

  appendSetupRunLog(runState, "Creating the PR Writer setup commit");
  await runSetupCommand(runState, worktreePath, "git", [
    "commit",
    "--author=PR Writer <prwriter@reveloexperts.com>",
    "-m",
    "Set up initial instructions",
  ]);

  const revParse = await runCommand({
    cmd: "git",
    args: ["rev-parse", "HEAD"],
    cwd: worktreePath,
    signal: runState.abortController.signal,
  });
  if (revParse.code !== 0) {
    throw new Error(`git rev-parse HEAD failed: ${revParse.stderr || revParse.stdout}`);
  }
  const commitSha = revParse.stdout.trim();
  appendSetupRunLog(runState, `Created setup commit ${commitSha}`);

  appendSetupRunLog(runState, "Capturing git log for the setup commit");
  await runSetupCommand(runState, worktreePath, "git", ["log", "-1", "--stat", "--decorate"]);

  appendSetupRunLog(runState, "Capturing git describe output");
  await runSetupCommand(runState, worktreePath, "git", ["describe", "--tags", "--always"]);

  return commitSha || undefined;
}

export function setupRunStateToApi(run: SetupRunRecord, active?: ActiveSetupRunState): Record<string, unknown> {
  return {
    ...run,
    status: active?.status ?? run.status,
    running: active ? active.status === "running" : run.status === "running",
    stage: active?.stage ?? run.summary ?? run.error ?? run.status,
    startedAt: active?.startedAt ?? run.startedAt,
    finishedAt: active?.finishedAt ?? run.finishedAt ?? null,
    logs: active?.logs ?? [],
    liveOutput: active?.liveOutput ?? "",
    stopRequested: active?.stopRequested ?? false,
    worktreePath: active?.worktreePath ?? run.worktreePath ?? null,
    stdoutPath: active?.stdoutPath ?? run.stdoutPath ?? null,
    stderrPath: active?.stderrPath ?? run.stderrPath ?? null,
    lastMessagePath: active?.lastMessagePath ?? run.lastMessagePath ?? null,
    diffPath: active?.diffPath ?? run.diffPath ?? null,
    changedFiles: active?.changedFiles ?? run.changedFiles,
    violationFiles: active?.violationFiles ?? run.violationFiles,
    summary: active?.summary ?? run.summary ?? null,
    error: active?.error ?? run.error ?? null,
  };
}

export async function runSetupTask(
  deps: {
    config: Config;
    db: Database.Database;
    github: GitHubClient;
  },
  target: SetupTaskTarget,
  profile: SetupProfile,
  runState: ActiveSetupRunState,
): Promise<void> {
  const { config, db, github } = deps;
  const outputDir = resolve(join(config.outputRoot, "logs", `setup-run-${runState.runId}`));
  const stdoutPath = join(outputDir, "codex-stdout.log");
  const stderrPath = join(outputDir, "codex-stderr.log");
  const lastMessagePath = join(outputDir, "codex-last-message.txt");
  const diffPath = join(outputDir, "changes.diff");
  ensureDir(outputDir);

  runState.stdoutPath = stdoutPath;
  runState.stderrPath = stderrPath;
  runState.lastMessagePath = lastMessagePath;
  runState.diffPath = diffPath;

  updateSetupRun(db, runState.runId, {
    stdoutPath,
    stderrPath,
    lastMessagePath,
    diffPath,
  });

  appendSetupRunLog(runState, `Setup task started for ${target.targetLabel}`);

  try {
    let checkoutSha = target.checkoutSha?.trim();
    if (checkoutSha) {
      appendSetupRunLog(runState, `Using linked PR base/pre-fix commit ${checkoutSha}`);
    } else {
      appendSetupRunLog(runState, `Resolving ${target.repo.defaultBranch} head commit`);
      checkoutSha = await github.getBranchHeadSha(target.repo, target.repo.defaultBranch);
    }

    const setupConfig: Config = {
      ...config,
      workRoot: resolve(profile.cloneRootPath || config.setupDefaultCloneRoot),
    };

    appendSetupRunLog(runState, `Preparing local snapshot in ${setupConfig.workRoot}`);
    const snapshot = await prepareSnapshot(setupConfig, target.repo, checkoutSha, { signal: runState.abortController.signal });
    runState.worktreePath = snapshot.rootDir;
    updateSetupRun(db, runState.runId, { worktreePath: snapshot.rootDir });

    appendSetupRunLog(runState, "Configuring local git snapshot defaults");
    await runSetupCommand(runState, snapshot.rootDir, "git", ["config", "core.fileMode", "false"]);
    appendSetupRunLog(runState, "Configuring global git fileMode defaults");
    await runSetupCommand(runState, snapshot.rootDir, "git", ["config", "--global", "core.fileMode", "false"]);

    const discoveredLockFiles = listSetupLockFiles(snapshot.files);
    let removedLockFiles: string[] = [];
    if (discoveredLockFiles.length) {
      appendSetupRunLog(runState, `Removing ${discoveredLockFiles.length} lock file(s) before setup editing`);
      removedLockFiles = removeSetupLockFiles(snapshot.rootDir, discoveredLockFiles);
    } else {
      appendSetupRunLog(runState, "No lock files detected for automatic removal");
    }

    const prompt = buildSetupPrompt(target.repo, snapshot, profile, target, { removedLockFiles });
    const codexCommand = await resolveCodexExecutable(config, runState.abortController.signal);
    const args = ["exec", "--color", "never", "-C", snapshot.rootDir, "-o", lastMessagePath] as string[];
    if (profile.model) {
      args.push("-m", profile.model);
    }
    if (profile.sandboxMode === "danger-full-access") {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    } else {
      args.push("--full-auto");
    }
    args.push(prompt);

    appendSetupRunLog(runState, `Running Codex via ${codexCommand}`);
    const codexStartedAt = Date.now();
    const execution = await runCommand({
      cmd: codexCommand,
      args,
      cwd: snapshot.rootDir,
      signal: runState.abortController.signal,
      stdoutPath,
      stderrPath,
      onStdoutChunk: (chunk) => appendSetupRunOutput(runState, "stdout", chunk),
      onStderrChunk: (chunk) => appendSetupRunOutput(runState, "stderr", chunk),
    });
    appendSetupRunLog(runState, `Codex exited with code ${String(execution.code)} after ${formatCommandDuration(Date.now() - codexStartedAt)}`);

    runState.changedFiles = await collectChangedFiles(snapshot.rootDir);
    runState.violationFiles = runState.changedFiles.filter((file) => !isPathAllowedByPatterns(file, profile.writablePaths));

    const finalMessage = readUtf8Safe(lastMessagePath)?.trim();
    const skippedReason = execution.code === 0 ? extractSkippedSetupReason(finalMessage) : undefined;
    let commitSha: string | undefined;
    if (execution.code === 0 && !skippedReason) {
      commitSha = await finalizeSetupCommit(runState, snapshot.rootDir);
    } else {
      await writeGitDiff(snapshot.rootDir, diffPath);
    }

    const summaryBits: string[] = [];
    if (finalMessage) {
      summaryBits.push(finalMessage);
    } else if (execution.code === 0) {
      summaryBits.push("Codex setup completed.");
    } else {
      summaryBits.push(`Codex exited with code ${String(execution.code)}`);
    }
    if (runState.violationFiles.length) {
      summaryBits.push(`Changed files outside allowed write paths: ${runState.violationFiles.join(", ")}`);
    }
    if (removedLockFiles.length) {
      summaryBits.push(`Automatically removed lock files before setup: ${removedLockFiles.join(", ")}`);
    }
    if (commitSha) {
      summaryBits.push(`Created setup commit: ${commitSha}`);
    } else if (skippedReason) {
      summaryBits.push(`Setup was skipped: ${skippedReason}`);
    } else if (execution.code === 0) {
      summaryBits.push("No setup changes were detected, so no setup commit was created.");
    }
    runState.summary = summaryBits.join("\n\n");

    if (execution.code !== 0) {
      runState.status = "failed";
      runState.finishedAt = new Date().toISOString();
      runState.error = execution.stderr.trim() || execution.stdout.trim() || `codex exited with code ${String(execution.code)}`;
      appendSetupRunLog(runState, `Setup task failed: ${runState.error}`);
    } else if (skippedReason) {
      runState.status = "skipped";
      runState.finishedAt = new Date().toISOString();
      runState.error = undefined;
      appendSetupRunLog(runState, `Setup task skipped: ${skippedReason}`);
    } else {
      runState.status = "completed";
      runState.finishedAt = new Date().toISOString();
      appendSetupRunLog(runState, "Setup task completed");
    }

    updateSetupRun(db, runState.runId, {
      status: runState.status,
      worktreePath: runState.worktreePath,
      stdoutPath,
      stderrPath,
      lastMessagePath,
      diffPath,
      summary: runState.summary,
      changedFiles: runState.changedFiles,
      violationFiles: runState.violationFiles,
      error: runState.error,
      finishedAt: runState.finishedAt ?? null,
    });
  } catch (err) {
    if (err instanceof CommandAbortedError || runState.stopRequested || runState.abortController.signal.aborted) {
      runState.status = "stopped";
      runState.finishedAt = new Date().toISOString();
      runState.error = undefined;
      runState.summary = runState.summary ?? "Setup task stopped by user";
      appendSetupRunLog(runState, "Setup task stopped by user");
    } else {
      runState.status = "failed";
      runState.finishedAt = new Date().toISOString();
      runState.error = formatSpawnError(err, config.codexCliPath?.trim() || "codex");
      runState.summary = runState.summary ?? runState.error;
      appendSetupRunLog(runState, `Setup task failed: ${runState.error}`);
    }

    updateSetupRun(db, runState.runId, {
      status: runState.status,
      worktreePath: runState.worktreePath,
      stdoutPath: runState.stdoutPath,
      stderrPath: runState.stderrPath,
      lastMessagePath: runState.lastMessagePath,
      diffPath: runState.diffPath,
      summary: runState.summary,
      changedFiles: runState.changedFiles,
      violationFiles: runState.violationFiles,
      error: runState.error,
      finishedAt: runState.finishedAt ?? null,
    });
  }
}
