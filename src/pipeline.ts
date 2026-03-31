import { join } from "node:path";
import { cleanupSnapshot, prepareSnapshot } from "./git.js";
import { GitHubClient } from "./github.js";
import { resolveTestPlan } from "./gemini.js";
import { executeTestPlan } from "./docker.js";
import { analyzePullRequestFiles, chooseLanguageBucket } from "./parsing.js";
import { screenRepository } from "./repo-screen.js";
import {
  CandidateReport,
  Config,
  IssueRef,
  Language,
  ScanPerformanceMetrics,
  ScanReport,
  SearchRepo,
  StepTiming,
} from "./types.js";
import { ensureDir, readUtf8Safe, writeJson } from "./util.js";
import {
  getDb,
  upsertRepo,
  upsertPullRequest,
  upsertIssue,
  createScan,
  finishScan,
  insertScanCandidate,
} from "./db.js";

export type ProgressCallback = (msg: string) => void;
const SCAN_DOCKER_TIMEOUT_MS = 15 * 60 * 1000;

/* ------------------------------------------------------------------ */
/* Timing helper                                                       */
/* ------------------------------------------------------------------ */

function recordTiming(
  timings: StepTiming[],
  timing: StepTiming,
  aggregateTimings?: StepTiming[],
): void {
  timings.push(timing);
  aggregateTimings?.push(timing);
}

async function timeStep<T>(
  stepName: string,
  timings: StepTiming[],
  fn: () => Promise<T>,
  aggregateTimings?: StepTiming[],
): Promise<{ result: T; timing: StepTiming }> {
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  let status: StepTiming["status"] = "ok";
  let detail: string | undefined;
  let result!: T;
  let thrownError: unknown;
  try {
    result = await fn();
  } catch (err) {
    status = "failed";
    detail = err instanceof Error ? err.message : String(err);
    thrownError = err;
  }
  const durationMs = Math.round(performance.now() - t0);
  const timing: StepTiming = { step: stepName, startedAt, durationMs, status, detail };
  recordTiming(timings, timing, aggregateTimings);
  if (thrownError) {
    throw thrownError;
  }
  return { result, timing };
}

function skipTiming(
  stepName: string,
  timings: StepTiming[],
  reason: string,
  aggregateTimings?: StepTiming[],
): void {
  recordTiming(timings, {
    step: stepName,
    startedAt: new Date().toISOString(),
    durationMs: 0,
    status: "skipped",
    detail: reason,
  }, aggregateTimings);
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${durationMs}ms`;
  if (durationMs < 60000) return `${(durationMs / 1000).toFixed(1)}s`;
  return `${(durationMs / 60000).toFixed(1)}m`;
}

async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const nextIndex = { value: 0 };
  const workerCount = Math.max(1, Math.min(Math.floor(concurrency), items.length || 1));

  const consume = async (): Promise<void> => {
    while (true) {
      const currentIndex = nextIndex.value;
      nextIndex.value += 1;
      if (currentIndex >= items.length) return;
      await worker(items[currentIndex] as T, currentIndex);
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => consume()));
}

function buildScanPerformanceMetrics(
  timings: StepTiming[],
  counts: {
    totalReposDiscovered: number;
    totalReposProcessed: number;
    totalPullRequestsAnalyzed: number;
    totalCandidatesRecorded: number;
  },
): ScanPerformanceMetrics {
  const grouped = new Map<string, {
    count: number;
    totalDurationMs: number;
    minDurationMs: number;
    maxDurationMs: number;
    okCount: number;
    failedCount: number;
    skippedCount: number;
  }>();

  for (const timing of timings) {
    const current = grouped.get(timing.step) ?? {
      count: 0,
      totalDurationMs: 0,
      minDurationMs: Number.POSITIVE_INFINITY,
      maxDurationMs: 0,
      okCount: 0,
      failedCount: 0,
      skippedCount: 0,
    };
    current.count += 1;
    current.totalDurationMs += timing.durationMs;
    current.minDurationMs = Math.min(current.minDurationMs, timing.durationMs);
    current.maxDurationMs = Math.max(current.maxDurationMs, timing.durationMs);
    if (timing.status === "ok") current.okCount += 1;
    if (timing.status === "failed") current.failedCount += 1;
    if (timing.status === "skipped") current.skippedCount += 1;
    grouped.set(timing.step, current);
  }

  return {
    ...counts,
    steps: [...grouped.entries()]
      .map(([step, metric]) => ({
        step,
        count: metric.count,
        totalDurationMs: metric.totalDurationMs,
        averageDurationMs: Math.round(metric.totalDurationMs / metric.count),
        minDurationMs: Number.isFinite(metric.minDurationMs) ? metric.minDurationMs : 0,
        maxDurationMs: metric.maxDurationMs,
        okCount: metric.okCount,
        failedCount: metric.failedCount,
        skippedCount: metric.skippedCount,
      }))
      .sort((left, right) => right.totalDurationMs - left.totalDurationMs || left.step.localeCompare(right.step)),
  };
}

function logPerformanceMetrics(metrics: ScanPerformanceMetrics, onProgress?: ProgressCallback): void {
  if (!onProgress || metrics.steps.length === 0) return;
  onProgress?.(
    `Performance summary: ${metrics.totalReposProcessed} repos processed, ${metrics.totalPullRequestsAnalyzed} PRs analyzed, ${metrics.totalCandidatesRecorded} candidates recorded`,
  );
  for (const step of metrics.steps) {
    onProgress(
      `  ${step.step}: total=${formatDuration(step.totalDurationMs)}, avg=${formatDuration(step.averageDurationMs)}, max=${formatDuration(step.maxDurationMs)}, runs=${step.count}, ok=${step.okCount}, failed=${step.failedCount}, skipped=${step.skippedCount}`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Issue verification                                                  */
/* ------------------------------------------------------------------ */

async function verifyIssueLinks(
  pr: { linkedIssues?: IssueRef[] },
): Promise<IssueRef[]> {
  const seen = new Set<string>();
  return (pr.linkedIssues ?? []).filter((issue) => {
    if ((issue.state ?? "").toLowerCase() !== "closed") return false;
    const key = `${issue.owner}/${issue.repo}#${issue.number}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/* ------------------------------------------------------------------ */
/* Rejected candidate helper                                           */
/* ------------------------------------------------------------------ */

function makeRejectedCandidate(repo: SearchRepo, message: string): CandidateReport {
  return {
    repo,
    screening: {
      accepted: false,
      reasons: [message],
      packageManager: undefined,
      hasDockerfile: false,
      hasTests: false,
      readmeEnglishLikely: false,
      hasBuildHints: false,
      treeCount: 0,
      interestingPaths: [],
    },
    pullRequest: {
      number: 0,
      url: repo.url,
      title: "",
      body: "",
      mergedAt: undefined,
      changedFilesCount: 0,
      labels: [],
      baseRefName: repo.defaultBranch,
      baseRefOid: "",
      headRefOid: "",
    },
    issueRefs: [],
    analysis: {
      relevantSourceFiles: [],
      relevantTestFiles: [],
      touchedDirectories: [],
      ignoredFiles: [],
      nonTrivialScore: 0,
      nonTrivialReasons: [message],
      accepted: false,
    },
    preFixSha: "",
    accepted: false,
    rejectionReasons: [message],
    timings: [],
    testsUnableToRun: false,
  };
}

function normalizeFailureSummary(text: string): string {
  return text
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/[0-9a-f]{12,}/gi, "<hash>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function summarizeDockerFailure(candidate: CandidateReport): { fingerprint: string; summary: string } | undefined {
  const execution = candidate.execution;
  if (!execution || execution.buildPassed) return undefined;

  const rawLog = (execution.buildStderrPath ? readUtf8Safe(execution.buildStderrPath) : undefined)
    ?? (execution.buildStdoutPath ? readUtf8Safe(execution.buildStdoutPath) : undefined)
    ?? execution.notes.join("\n");
  const lines = rawLog
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
  const summary = [...lines].reverse().find((line) => /error|failed|denied|not found|no such|unable|canceled|cancelled/i.test(line))
    ?? lines.at(-1)
    ?? "unknown docker build failure";
  const planKey = execution.usedPlan.dockerfilePath ?? execution.usedPlan.composeFilePath ?? execution.usedPlan.runner;
  const fingerprint = `${execution.usedPlan.runner}|${planKey}|${normalizeFailureSummary(summary)}`;
  return { fingerprint, summary };
}

/* ------------------------------------------------------------------ */
/* Main scan pipeline                                                  */
/* ------------------------------------------------------------------ */

export async function runScan(
  config: Config,
  onProgress?: ProgressCallback,
): Promise<ScanReport> {
  ensureDir(config.outputRoot);
  ensureDir(config.workRoot);
  const db = getDb(config.dbPath);
  const github = new GitHubClient(config);
  const accepted: CandidateReport[] = [];
  const rejected: CandidateReport[] = [];
  const scanTimings: StepTiming[] = [];
  const startedAt = new Date().toISOString();
  const scanStart = performance.now();
  let totalReposDiscovered = 0;
  let totalReposProcessed = 0;
  let totalPullRequestsAnalyzed = 0;
  const scheduledRepoFullNames = new Set<string>();
  const normalizedTargetRepo = config.targetRepo?.toLowerCase();

  const progress = (message: string): void => {
    onProgress?.(message);
  };

  const safeConfig = { ...config, githubToken: undefined, geminiApiKey: undefined };
  const scanId = createScan(db, JSON.stringify(safeConfig));
  progress(`Scan #${scanId} started`);
  progress(
    `Config: languages=${config.languages.join(", ")}, scanMode=${config.targetRepo ? "deep-scan(issue-first exhaustive)" : config.scanMode}, repoLimit=${config.repoLimit}, repoConcurrency=${config.repoConcurrency}, prLimit=${config.targetRepo ? "all linked issues" : config.prLimit}, minStars=${config.minStars}${config.targetRepo ? `, targetRepo=${config.targetRepo}` : ""}${config.mergedAfter ? `, mergedAfter=${config.mergedAfter}` : ""}${config.dryRun ? ", dryRun=true" : ""}`,
  );

  const processRepo = async (
    repo: SearchRepo,
    requestedLanguages: Language[],
    logPrefix: string,
    ordinalLabel?: string,
  ): Promise<void> => {
    totalReposProcessed += 1;
    progress(ordinalLabel ? `${logPrefix} ${ordinalLabel}: ${repo.fullName}` : `${logPrefix} ${repo.fullName}`);

    const repoId = upsertRepo(db, repo);
    progress(`Fetching repo metadata for ${repo.fullName}...`);

    const timingsForRepo: StepTiming[] = [];

    let tree: Awaited<ReturnType<typeof github.getRepoTree>>;
    let readme: string | undefined;
    try {
      const r = await timeStep("repo_fetch", timingsForRepo, async () => {
        const t = await github.getRepoTree(repo, repo.defaultBranch);
        const rd = await github.getReadme(repo, repo.defaultBranch);
        return { tree: t, readme: rd };
      }, scanTimings);
      tree = r.result.tree;
      readme = r.result.readme;
      progress(`Fetched repo tree and README for ${repo.fullName} in ${formatDuration(r.timing.durationMs)}`);
    } catch (err) {
      const repoFetchError = err instanceof Error ? err.message : String(err);
      if (normalizedTargetRepo && repo.fullName.toLowerCase() === normalizedTargetRepo) {
        progress(`GitHub tree fetch failed for ${repo.fullName} (${repoFetchError}); falling back to a temporary checkout for deep scan...`);
        let fallbackSnapshot: Awaited<ReturnType<typeof prepareSnapshot>> | undefined;
        try {
          const r = await timeStep(
            "repo_fetch_fallback",
            timingsForRepo,
            () => prepareSnapshot(config, repo, repo.defaultBranch),
            scanTimings,
          );
          fallbackSnapshot = r.result;
          tree = fallbackSnapshot.files.map((path) => ({ path, type: "blob" }));
          const readmePath = fallbackSnapshot.files.find((path) => /(^|\/)readme(\.[^/]+)?$/i.test(path));
          readme = readmePath ? readUtf8Safe(join(fallbackSnapshot.rootDir, readmePath)) : undefined;
          progress(`Recovered repo metadata for ${repo.fullName} via temporary checkout in ${formatDuration(r.timing.durationMs)}`);
        } catch (fallbackErr) {
          progress(
            `Rejected ${repo.fullName}: failed to fetch repo tree (${repoFetchError}; fallback checkout failed: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)})`,
          );
          const rej = makeRejectedCandidate(repo, "failed to fetch repo tree");
          rej.timings = [...timingsForRepo];
          rejected.push(rej);
          insertScanCandidate(db, scanId, repoId, null, rej);
          return;
        } finally {
          if (fallbackSnapshot) {
            cleanupSnapshot(config, fallbackSnapshot, { force: true });
          }
        }
      } else {
        progress(`Rejected ${repo.fullName}: failed to fetch repo tree (${repoFetchError})`);
        const rej = makeRejectedCandidate(repo, "failed to fetch repo tree");
        rej.timings = [...timingsForRepo];
        rejected.push(rej);
        insertScanCandidate(db, scanId, repoId, null, rej);
        return;
      }
    }

    const screening = screenRepository(repo, tree, readme);
    if (!screening.accepted) {
      progress(`Rejected ${repo.fullName} during screening: ${screening.reasons.join("; ")}`);
      const rej = {
        ...makeRejectedCandidate(repo, screening.reasons.join("; ")),
        screening,
        rejectionReasons: screening.reasons,
        timings: [...timingsForRepo],
      };
      rejected.push(rej);
      insertScanCandidate(db, scanId, repoId, null, rej);
      return;
    }
    progress(`${repo.fullName} passed screening`);

    const bucket = chooseLanguageBucket(repo, requestedLanguages);
    if (!bucket) {
      progress(`Rejected ${repo.fullName}: could not choose a language bucket`);
      const rej = makeRejectedCandidate(repo, "could not choose language bucket");
      rej.timings = [...timingsForRepo];
      rejected.push(rej);
      insertScanCandidate(db, scanId, repoId, null, rej);
      return;
    }

    let prs: Awaited<ReturnType<typeof github.searchMergedPullRequests>>;
    const exhaustiveIssueScan = Boolean(normalizedTargetRepo && repo.fullName.toLowerCase() === normalizedTargetRepo);
    const searchStep = exhaustiveIssueScan
      ? "issue_search_full"
      : (config.scanMode === "issue-first" ? "issue_search" : "pr_search");
    try {
      const r = await timeStep(
        searchStep,
        timingsForRepo,
        () => exhaustiveIssueScan
          ? github.searchAllClosedIssuesWithMergedPullRequests(repo, config.mergedAfter)
          : (config.scanMode === "issue-first"
            ? github.searchClosedIssuesWithMergedPullRequests(repo, config.prLimit, config.mergedAfter)
            : github.searchMergedPullRequests(repo, config.prLimit, config.mergedAfter)),
        scanTimings,
      );
      prs = r.result;
      progress(
        exhaustiveIssueScan
          ? `Found ${prs.length} PRs from all closed linked issues in ${repo.fullName} in ${formatDuration(r.timing.durationMs)}`
          : (config.scanMode === "issue-first"
            ? `Found ${prs.length} PRs from closed linked issues in ${repo.fullName} in ${formatDuration(r.timing.durationMs)}`
            : `Found ${prs.length} merged PR candidates in ${repo.fullName} in ${formatDuration(r.timing.durationMs)}`),
      );
    } catch (err) {
      const reason = exhaustiveIssueScan
        ? "failed to search all closed issues with linked PRs"
        : (config.scanMode === "issue-first"
          ? "failed to search closed issues with linked PRs"
          : "failed to search merged PRs");
      progress(`Rejected ${repo.fullName}: ${reason} (${err instanceof Error ? err.message : String(err)})`);
      const rej = makeRejectedCandidate(repo, reason);
      rej.timings = [...timingsForRepo];
      rejected.push(rej);
      insertScanCandidate(db, scanId, repoId, null, rej);
      return;
    }

    let foundAcceptedForRepo = false;
    let dockerBuildFailuresForRepo = 0;
    let stoppedAfterRepeatedDockerFailures = false;
    let repeatedDockerFailureSummary: string | undefined;
    const dockerFailureFingerprintsForRepo = new Map<string, { count: number; summary: string }>();
    const repoRejectReason = "repository rejected after repeated matching Docker build failures across PRs";

    for (const [prIndex, pr] of prs.entries()) {
      totalPullRequestsAnalyzed += 1;
      const candidateTimings: StepTiming[] = [...timingsForRepo];
      progress(`Analyzing PR ${prIndex + 1}/${prs.length}: ${repo.fullName}#${pr.number}`);

      const { result: files, timing: prFilesTiming } = await timeStep(
        "pr_files",
        candidateTimings,
        () => github.listPullRequestFiles(repo, pr.number),
        scanTimings,
      );
      progress(`Loaded ${files.length} changed files for ${repo.fullName}#${pr.number} in ${formatDuration(prFilesTiming.durationMs)}`);
      const analysis = analyzePullRequestFiles(files, bucket);

      const { result: issueRefs, timing: issueVerifyTiming } = await timeStep(
        "issue_verify",
        candidateTimings,
        () => verifyIssueLinks(pr),
        scanTimings,
      );
      progress(`Verified ${issueRefs.length} closed linked issues for ${repo.fullName}#${pr.number} in ${formatDuration(issueVerifyTiming.durationMs)}`);

      const prId = upsertPullRequest(db, repoId, pr);
      for (const issue of issueRefs) {
        upsertIssue(db, prId, issue);
      }

      const candidate: CandidateReport = {
        repo,
        screening,
        pullRequest: pr,
        issueRefs,
        analysis,
        preFixSha: pr.baseRefOid,
        accepted: false,
        rejectionReasons: [],
        timings: candidateTimings,
        testsUnableToRun: false,
      };

      if (issueRefs.length === 0) {
        candidate.rejectionReasons.push("PR has no verified closed GitHub issue link");
      }
      if (!analysis.accepted) {
        candidate.rejectionReasons.push(
          ...(analysis.nonTrivialReasons.length ? analysis.nonTrivialReasons : ["PR is not non-trivial enough"]),
        );
      }
      if (candidate.rejectionReasons.length > 0) {
        progress(`Rejected ${repo.fullName}#${pr.number}: ${candidate.rejectionReasons.join("; ")}`);
        rejected.push(candidate);
        insertScanCandidate(db, scanId, repoId, prId, candidate);
        continue;
      }

      let snapshot: Awaited<ReturnType<typeof prepareSnapshot>>;
      try {
        progress(`Preparing pre-fix snapshot for ${repo.fullName}#${pr.number} @ ${pr.baseRefOid.slice(0, 8)}...`);
        const r = await timeStep(
          "snapshot",
          candidateTimings,
          () => prepareSnapshot(config, repo, pr.baseRefOid),
          scanTimings,
        );
        snapshot = r.result;
        progress(`Prepared snapshot for ${repo.fullName}#${pr.number} in ${formatDuration(r.timing.durationMs)}`);
      } catch (err) {
        candidate.rejectionReasons.push("failed to prepare snapshot");
        candidate.testsUnableToRun = true;
        candidate.testsUnableToRunReason = "Snapshot preparation failed";
        progress(`Rejected ${repo.fullName}#${pr.number}: failed to prepare snapshot (${err instanceof Error ? err.message : String(err)})`);
        rejected.push(candidate);
        insertScanCandidate(db, scanId, repoId, prId, candidate);
        continue;
      }
      candidate.snapshot = snapshot;

      try {
        if (snapshot.sizeBytes > config.maxRepoSizeBytes) {
          candidate.rejectionReasons.push(`snapshot exceeds max size: ${snapshot.sizeBytes} bytes`);
          candidate.testsUnableToRun = true;
          candidate.testsUnableToRunReason = "Snapshot too large";
          progress(`Rejected ${repo.fullName}#${pr.number}: snapshot exceeds max size (${snapshot.sizeBytes} bytes)`);
          rejected.push(candidate);
          insertScanCandidate(db, scanId, repoId, prId, candidate);
          continue;
        }

        progress(`Resolving Docker build plan for ${repo.fullName}#${pr.number}...`);
        const { result: plan, timing: testPlanTiming } = await timeStep(
          "test_plan",
          candidateTimings,
          () => resolveTestPlan(config, snapshot),
          scanTimings,
        );
        candidate.testPlan = plan;
        if (!plan) {
          candidate.rejectionReasons.push("could not infer a Docker build plan");
          candidate.testsUnableToRun = true;
          candidate.testsUnableToRunReason = "No Docker build plan could be inferred";
          progress(`Rejected ${repo.fullName}#${pr.number}: could not infer a Docker build plan`);
          rejected.push(candidate);
          insertScanCandidate(db, scanId, repoId, prId, candidate);
          continue;
        }
        progress(`Resolved ${plan.source} Docker build plan for ${repo.fullName}#${pr.number} in ${formatDuration(testPlanTiming.durationMs)}`);

        if (!config.dryRun) {
          progress(`Running Docker build validation for ${repo.fullName}#${pr.number}...`);

          const { result: execution, timing: dockerExecTiming } = await timeStep(
            "docker_exec",
            candidateTimings,
            () => executeTestPlan(config, snapshot, plan, {
              buildTimeoutMs: SCAN_DOCKER_TIMEOUT_MS,
              testTimeoutMs: SCAN_DOCKER_TIMEOUT_MS,
            }),
            scanTimings,
          );
          candidate.execution = execution;
          progress(`Docker build validation finished for ${repo.fullName}#${pr.number} in ${formatDuration(dockerExecTiming.durationMs)}`);

          if (!execution.buildPassed) {
            candidate.rejectionReasons.push("Docker build failed at pre-fix snapshot");
            candidate.testsUnableToRun = true;
            candidate.testsUnableToRunReason = "Docker build failed";
            dockerBuildFailuresForRepo += 1;

            const failure = summarizeDockerFailure(candidate);
            if (failure) {
              candidate.testsUnableToRunReason = `Docker build failed: ${failure.summary}`;
              candidate.execution.notes = [
                ...candidate.execution.notes,
                `failure summary: ${failure.summary}`,
                `failure fingerprint: ${failure.fingerprint}`,
              ];
              const current = dockerFailureFingerprintsForRepo.get(failure.fingerprint) ?? { count: 0, summary: failure.summary };
              current.count += 1;
              dockerFailureFingerprintsForRepo.set(failure.fingerprint, current);
              if (current.count > 1) {
                repeatedDockerFailureSummary = current.summary;
              }
            }
          } else {
            const buildEvidence = execution.builtImageId
              ? `verified image ${execution.builtImageId}`
              : execution.notes.find((note) => note.startsWith("compose build services:"));
            if (buildEvidence) {
              progress(`Docker build verified for ${repo.fullName}#${pr.number}: ${buildEvidence}`);
            }
          }
        } else {
          skipTiming("docker_exec", candidateTimings, "dry-run mode", scanTimings);
          candidate.testsUnableToRun = true;
          candidate.testsUnableToRunReason = "Dry-run mode — Docker build validation skipped";
          progress(`Skipped Docker build validation for ${repo.fullName}#${pr.number}: dry-run mode`);
        }

        if (candidate.rejectionReasons.length === 0) {
          candidate.accepted = true;
          accepted.push(candidate);
          foundAcceptedForRepo = true;
          insertScanCandidate(db, scanId, repoId, prId, candidate);
          progress(`Accepted ${repo.fullName}#${pr.number}`);
          continue;
        }

        const shouldRejectRepoForScan = Boolean(repeatedDockerFailureSummary) && !foundAcceptedForRepo;
        if (shouldRejectRepoForScan && !candidate.rejectionReasons.includes(repoRejectReason)) {
          candidate.rejectionReasons.push(repoRejectReason);
        }
        progress(`Rejected ${repo.fullName}#${pr.number}: ${candidate.rejectionReasons.join("; ")}`);
        rejected.push(candidate);
        insertScanCandidate(db, scanId, repoId, prId, candidate);
        if (repeatedDockerFailureSummary) {
          stoppedAfterRepeatedDockerFailures = true;
          progress(
            foundAcceptedForRepo
              ? `Stopping ${repo.fullName}: repeated Docker failure fingerprint '${repeatedDockerFailureSummary}' detected, keeping already accepted PRs and skipping the rest`
              : `Stopping ${repo.fullName}: repeated Docker failure fingerprint '${repeatedDockerFailureSummary}' detected, treating the repo as rejected`,
          );
          break;
        }
      } finally {
        cleanupSnapshot(config, snapshot, { force: true });
      }
    }

    if (!foundAcceptedForRepo && prs.length === 0) {
      progress(`Rejected ${repo.fullName}: no merged PR candidates found`);
      const rej = makeRejectedCandidate(repo, "no merged PR candidates found");
      rej.timings = [...timingsForRepo];
      rejected.push(rej);
      insertScanCandidate(db, scanId, repoId, null, rej);
    } else if (!foundAcceptedForRepo && stoppedAfterRepeatedDockerFailures) {
      progress(`Rejected ${repo.fullName}: repeated Docker build failures with a matching fingerprint stopped the remaining PR checks`);
    }
  };

  try {
    if (config.targetRepo) {
      progress(`[deep-scan] Resolving repository ${config.targetRepo}...`);
      const { result: repo, timing: repoResolveTiming } = await timeStep(
        "repo_resolve",
        scanTimings,
        () => github.getRepository(config.targetRepo as string),
      );
      totalReposDiscovered += 1;
      progress(`[deep-scan] Resolved ${repo.fullName} in ${formatDuration(repoResolveTiming.durationMs)}`);
      await processRepo(repo, config.languages, "[deep-scan]");
    } else {
      for (const language of config.languages) {
        progress(`[${language}] Searching repositories (limit ${config.repoLimit}, stars>=${config.minStars})...`);
        const { result: repos, timing: repoSearchTiming } = await timeStep(
          "repo_search",
          scanTimings,
          () => github.searchRepositories(language, config.repoLimit, config.minStars),
        );
        const uniqueRepos = repos.filter((repo) => {
          if (scheduledRepoFullNames.has(repo.fullName)) {
            return false;
          }
          scheduledRepoFullNames.add(repo.fullName);
          return true;
        });
        totalReposDiscovered += uniqueRepos.length;
        const duplicateRepoCount = repos.length - uniqueRepos.length;
        progress(
          duplicateRepoCount > 0
            ? `[${language}] Found ${repos.length} repositories in ${formatDuration(repoSearchTiming.durationMs)} (${uniqueRepos.length} unique after cross-language dedupe)`
            : `[${language}] Found ${repos.length} repositories in ${formatDuration(repoSearchTiming.durationMs)}`,
        );
        if (uniqueRepos.length > 0) {
          progress(`[${language}] Processing repositories with concurrency ${config.repoConcurrency}...`);
        }
        await runWithConcurrency(
          uniqueRepos,
          config.repoConcurrency,
          async (repo, repoIndex) => {
            await processRepo(repo, [language], `[${language}]`, `Repo ${repoIndex + 1}/${uniqueRepos.length}`);
          },
        );
      }
    }

    const totalDurationMs = Math.round(performance.now() - scanStart);
    const performanceMetrics = buildScanPerformanceMetrics(scanTimings, {
      totalReposDiscovered,
      totalReposProcessed,
      totalPullRequestsAnalyzed,
      totalCandidatesRecorded: accepted.length + rejected.length,
    });
    finishScan(db, scanId, "completed", totalDurationMs, accepted.length, rejected.length, performanceMetrics);
    progress(`Scan #${scanId} completed: ${accepted.length} accepted, ${rejected.length} rejected in ${formatDuration(totalDurationMs)}`);
    logPerformanceMetrics(performanceMetrics, onProgress);

    const report: ScanReport = {
      scanId,
      startedAt,
      finishedAt: new Date().toISOString(),
      totalDurationMs,
      config: {
        ...config,
        githubTokenConfigured: Boolean(config.githubToken),
        geminiConfigured: Boolean(config.geminiApiKey),
      },
      performanceMetrics,
      accepted,
      rejected,
    };

    writeJson(join(config.outputRoot, `scan-${Date.now()}.json`), report);
    return report;
  } catch (err) {
    const totalDurationMs = Math.round(performance.now() - scanStart);
    const performanceMetrics = buildScanPerformanceMetrics(scanTimings, {
      totalReposDiscovered,
      totalReposProcessed,
      totalPullRequestsAnalyzed,
      totalCandidatesRecorded: accepted.length + rejected.length,
    });
    finishScan(db, scanId, "failed", totalDurationMs, accepted.length, rejected.length, performanceMetrics);
    progress(`Scan #${scanId} failed after ${formatDuration(totalDurationMs)}: ${err instanceof Error ? err.message : String(err)}`);
    logPerformanceMetrics(performanceMetrics, onProgress);
    throw err;
  }
}
