export type Language = "python" | "javascript" | "typescript";
export type ScanMode = "issue-first" | "pr-first";

export interface Config {
  githubToken?: string;
  geminiApiKey?: string;
  geminiModel: string;
  geminiApiBase: string;
  maxRepoSizeBytes: number;
  requestTimeoutMs: number;
  buildTimeoutMs: number;
  testTimeoutMs: number;
  workRoot: string;
  outputRoot: string;
  dbPath: string;
  host: string;
  port: number;
  minStars: number;
  repoLimit: number;
  repoConcurrency: number;
  prLimit: number;
  mergedAfter?: string;
  languages: Language[];
  scanMode: ScanMode;
  targetRepo?: string;
  dryRun: boolean;
  keepWorktree: boolean;
}

/** Fields the UI scan form can override (non-sensitive). */
export interface ScanConfigOverrides {
  languages?: Language[];
  repoLimit?: number;
  repoConcurrency?: number;
  prLimit?: number;
  minStars?: number;
  mergedAfter?: string;
  scanMode?: ScanMode;
  targetRepo?: string;
  dryRun?: boolean;
  keepWorktree?: boolean;
}

export type ScanStatus = "running" | "completed" | "failed";

export interface SearchRepo {
  owner: string;
  name: string;
  fullName: string;
  url: string;
  isArchived: boolean;
  stars: number;
  primaryLanguage?: string;
  defaultBranch: string;
  pushedAt?: string;
  diskUsageKb?: number;
  description?: string | null;
}

export interface RepoTreeItem {
  path: string;
  type: "blob" | "tree" | string;
  size?: number;
}

export interface RepoScreening {
  accepted: boolean;
  reasons: string[];
  packageManager?: string;
  hasDockerfile: boolean;
  hasTests: boolean;
  readmeEnglishLikely: boolean;
  hasBuildHints: boolean;
  treeCount: number;
  interestingPaths: string[];
}

export interface PullRequestSummary {
  number: number;
  url: string;
  title: string;
  body: string;
  mergedAt?: string | null;
  changedFilesCount?: number;
  labels: string[];
  baseRefName: string;
  baseRefOid: string;
  headRefOid: string;
  linkedIssues?: IssueRef[];
}

export interface PullRequestFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
}

export interface IssueRef {
  owner: string;
  repo: string;
  number: number;
  url?: string;
  title?: string;
  body?: string;
  state?: string;
  linkType: "pr_keyword" | "body_reference" | "timeline_cross_reference" | "github_linked";
}

export interface PrAnalysis {
  relevantSourceFiles: PullRequestFile[];
  relevantTestFiles: PullRequestFile[];
  touchedDirectories: string[];
  ignoredFiles: string[];
  nonTrivialScore: number;
  nonTrivialReasons: string[];
  accepted: boolean;
}

export interface RepoSnapshot {
  rootDir: string;
  fullName: string;
  owner: string;
  repo: string;
  sha: string;
  sizeBytes: number;
  files: string[];
}

export interface TestPlan {
  source: "deterministic" | "gemini";
  confidence: number;
  runner: "docker-run" | "compose-run" | "docker-target" | "none";
  dockerfilePath?: string;
  composeFilePath?: string;
  composeService?: string;
  composeBuildServices?: string[];
  dockerTarget?: string;
  workdir?: string;
  testCommand: string[];
  reasoningSummary: string;
}

export interface ExecutionResult {
  buildPassed: boolean;
  testsPassed: boolean;
  buildExitCode: number | null;
  testExitCode: number | null;
  buildStdoutPath?: string;
  buildStderrPath?: string;
  testStdoutPath?: string;
  testStderrPath?: string;
  imageTag?: string;
  builtImageId?: string;
  usedPlan: TestPlan;
  notes: string[];
}

export interface StepTiming {
  step: string;
  startedAt: string;
  durationMs: number;
  status: "ok" | "failed" | "skipped";
  detail?: string;
}

export interface ScanStepMetric {
  step: string;
  count: number;
  totalDurationMs: number;
  averageDurationMs: number;
  minDurationMs: number;
  maxDurationMs: number;
  okCount: number;
  failedCount: number;
  skippedCount: number;
}

export interface ScanPerformanceMetrics {
  totalReposDiscovered: number;
  totalReposProcessed: number;
  totalPullRequestsAnalyzed: number;
  totalCandidatesRecorded: number;
  steps: ScanStepMetric[];
}

export interface CandidateReport {
  repo: SearchRepo;
  screening: RepoScreening;
  pullRequest: PullRequestSummary;
  issueRefs: IssueRef[];
  analysis: PrAnalysis;
  preFixSha: string;
  snapshot?: RepoSnapshot;
  testPlan?: TestPlan;
  execution?: ExecutionResult;
  accepted: boolean;
  rejectionReasons: string[];
  timings: StepTiming[];
  testsUnableToRun: boolean;
  testsUnableToRunReason?: string;
}

export interface ScanReport {
  scanId: number;
  startedAt: string;
  finishedAt: string;
  totalDurationMs: number;
  config: Omit<Config, "githubToken" | "geminiApiKey"> & {
    githubTokenConfigured: boolean;
    geminiConfigured: boolean;
  };
  performanceMetrics: ScanPerformanceMetrics;
  accepted: CandidateReport[];
  rejected: CandidateReport[];
}
