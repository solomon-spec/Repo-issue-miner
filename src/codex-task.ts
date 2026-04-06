import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CodexAxisName,
  CodexAxisPreference,
  CodexIssueSource,
  CodexPrChangedFileSummary,
  CodexPrContext,
  CodexReviewDraft,
  CodexTaskRound,
  CodexTaskState,
  PullRequestFile,
  PromptDraft,
} from "./types.js";
import { ensureDir, stripMarkdownFence, writeJson } from "./util.js";

export const CODEX_TASK_MAX_PROMPTS = 4;

export const CODEX_AXIS_NAMES: CodexAxisName[] = [
  "preferred_output",
  "logic_and_correctness",
  "naming_and_clarity",
  "organization_and_modularity",
  "interface_design",
  "error_handling",
  "comments_and_documentation",
  "review_and_production_readiness",
];

export interface TmuxSessionInfo {
  sessionA: string;
  sessionB: string;
  attachA: string;
  attachB: string;
}

export interface ReviewResponseEvidence {
  label: "A" | "B";
  repoPath: string;
  gitStatus: string;
  branch: string;
  head: string;
  diffStat: string;
  diffPatch: string;
  log: string;
  tmuxCapture?: string;
  testCommand?: string;
  testExitCode?: number | null;
  testOutput?: string;
  notes?: string;
  warnings?: string[];
}

export interface ReviewBundleInput {
  round: number;
  maxPrompts: number;
  issue: CodexIssueSource;
  prContext?: CodexPrContext;
  currentPrompt: string;
  originalRepoPath: string;
  worktreeAPath: string;
  worktreeBPath: string;
  testCommand?: string;
  screening?: unknown;
  analysis?: unknown;
  previousRound?: CodexTaskRound;
  responseA: ReviewResponseEvidence;
  responseB: ReviewResponseEvidence;
}

const GUIDANCE_TEXT = [
  "Review goals",
  "- Choose a winner between Response A and Response B. Never return a tie.",
  "- Use the actual merged PR only as supporting context. Do not treat it as an oracle or demand historical patch parity.",
  "- Prefer observable evidence from diffs, git state, tests, and tmux output over assumptions.",
  "",
  "What to look for",
  "- Fidelity to the original issue wording, named entities, and scope.",
  "- Correctness, regressions, and missing edge cases.",
  "- Permission-only changes, unnecessary files, or unrelated edits.",
  "- README, dependency, setup, and commit hygiene.",
  "- False claims in terminal output, ignored prompts, hangs, or permission requests surfaced by tmux capture.",
  "",
  "Output rules",
  "- Pros and cons must be model-specific paragraphs, not comparisons against the other model.",
  "- Axis ratings must match the prose and observable evidence.",
  "- If evidence is weak, prefer a slight choice over an exaggerated claim.",
  "- The next prompt must be instruction-style, must address only the winning response's unresolved cons, and must not increase scope.",
].join("\n");

function writeText(path: string, text: string): void {
  ensureDir(join(path, ".."));
  writeFileSync(path, text, "utf8");
}

function toParagraph(text: string | undefined, fallback: string): string {
  const trimmed = text?.trim();
  return trimmed ? trimmed : fallback;
}

export function buildTmuxSessionInfo(hfiUuid: string): TmuxSessionInfo {
  const uuid = hfiUuid.trim();
  return {
    sessionA: `${uuid}-A`,
    sessionB: `${uuid}-B`,
    attachA: `tmux attach -t ${uuid}-A`,
    attachB: `tmux attach -t ${uuid}-B`,
  };
}

export function buildPromptOne(issue: CodexIssueSource): string {
  const title = issue.title.trim();
  const body = issue.body?.trim();
  const lines = [
    "Work in the current repository and resolve the issue below without widening the scope.",
    "",
    title.endsWith(".") ? title : `${title}.`,
  ];
  if (body) {
    lines.push("", body);
  }
  lines.push("", "Preserve the original constraints and issue-specific terminology while turning this into a production-ready fix.");
  return lines.join("\n");
}

export function buildPromptOneRewriteInstructions(issue: CodexIssueSource): string {
  const lines = [
    "Rewrite the GitHub issue below into a natural instruction-style coding prompt for Codex.",
    "",
    "Requirements:",
    "- Rephrase the issue instead of copying it verbatim.",
    "- Preserve the concrete bug, scope, constraints, and issue-specific terminology.",
    "- Keep the prompt grounded in the current repository.",
    "- Do not add new requirements, new files, or extra scope that the issue does not ask for.",
    "- Avoid labels like 'Issue title', 'Issue description', or 'GitHub issue'.",
    "- Return concise, direct prompt text that is ready to paste into Codex.",
    "",
    `Issue title: ${issue.title.trim()}`,
  ];
  if (issue.body?.trim()) {
    lines.push("", "Issue body:", "", issue.body.trim());
  }
  lines.push("", "Return JSON only with a single string field named \"prompt\".");
  return lines.join("\n");
}

export function buildPromptOneRewriteSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["prompt"],
    properties: {
      prompt: { type: "string" },
    },
  };
}

export function parsePromptOneRewriteOutput(raw: string): string {
  const stripped = stripMarkdownFence(raw);
  const parsed = JSON.parse(stripped) as Record<string, unknown>;
  const prompt = typeof parsed.prompt === "string" ? parsed.prompt.trim() : "";
  if (!prompt) {
    throw new Error("Codex prompt rewrite output did not include a prompt");
  }
  if (
    /address the following github issue in the current repository/i.test(prompt)
    || /issue title:/i.test(prompt)
    || /issue description:/i.test(prompt)
  ) {
    throw new Error("Codex prompt rewrite output fell back to the legacy issue-copy format");
  }
  return prompt;
}

export function buildFollowUpPrompt(round: number, unresolvedCons: readonly string[]): string {
  const items = unresolvedCons
    .map((item) => item.trim())
    .filter(Boolean);
  const lines = [
    "Continue from the currently selected checkpoint and address the remaining review issues below without increasing the scope of the task.",
    "",
  ];
  if (items.length) {
    lines.push(...items.map((item) => `- ${item}`));
  } else {
    lines.push("- Resolve the remaining production-readiness issues from the latest review.");
  }
  lines.push("", "Commit the changes in a meaningful commit before you finish.");
  if (round >= CODEX_TASK_MAX_PROMPTS) {
    lines.push("This should be the final production-readiness pass for the task.");
  }
  return lines.join("\n");
}

export function makePromptDraft(round: number, prompt: string, source: PromptDraft["source"]): PromptDraft {
  return {
    round,
    prompt,
    source,
    generatedAt: new Date().toISOString(),
  };
}

export function summarizePullRequestFiles(files: PullRequestFile[], limit = 20): CodexPrChangedFileSummary[] {
  return files.slice(0, limit).map((file) => ({
    filename: file.filename,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
    status: file.status,
  }));
}

export function reopenLastCodexTaskRound(task: CodexTaskState): CodexTaskState {
  const lastReviewedRound = task.rounds
    .filter((round) => round.reviewDraft)
    .reduce((maxRound, round) => Math.max(maxRound, round.round), 0);

  if (lastReviewedRound < 1) {
    throw new Error("No completed round is available to reopen.");
  }

  return {
    ...task,
    currentRound: lastReviewedRound,
    prompts: task.prompts.filter((prompt) => prompt.round <= lastReviewedRound),
    rounds: task.rounds
      .filter((round) => round.round <= lastReviewedRound)
      .map((round): CodexTaskRound => round.round === lastReviewedRound
        ? {
            round: round.round,
            notesA: round.notesA,
            notesB: round.notesB,
          }
        : round)
      .sort((left, right) => left.round - right.round),
    updatedAt: new Date().toISOString(),
  };
}

export function updateCodexTaskSettings(
  task: CodexTaskState,
  settings: {
    hfiUuid: string;
    originalRepoPath: string;
    worktreeAPath: string;
    worktreeBPath: string;
    testCommand?: string;
  },
): CodexTaskState {
  return {
    ...task,
    hfiUuid: settings.hfiUuid,
    originalRepoPath: settings.originalRepoPath,
    worktreeAPath: settings.worktreeAPath,
    worktreeBPath: settings.worktreeBPath,
    testCommand: settings.testCommand,
    updatedAt: new Date().toISOString(),
  };
}

export function buildIssueMarkdown(issue: CodexIssueSource): string {
  const lines = [
    `# ${issue.title}`,
  ];
  if (issue.url) {
    lines.push("", `Source: ${issue.url}`);
  }
  if (issue.body?.trim()) {
    lines.push("", issue.body.trim());
  }
  return lines.join("\n");
}

export function buildPrContextMarkdown(prContext?: CodexPrContext): string {
  if (!prContext) {
    return "# Actual PR Context\n\nNo live pull-request context was available for this review.";
  }
  const lines = [
    "# Actual PR Context",
    "",
    `Title: ${prContext.title || "Unknown PR title"}`,
  ];
  if (prContext.url) {
    lines.push(`URL: ${prContext.url}`);
  }
  if (prContext.mergedAt) {
    lines.push(`Merged at: ${prContext.mergedAt}`);
  }
  if (typeof prContext.changedFilesCount === "number") {
    lines.push(`Changed files: ${prContext.changedFilesCount}`);
  }
  if (prContext.body?.trim()) {
    lines.push("", "Body:", "", prContext.body.trim());
  }
  if (prContext.changedFiles.length) {
    lines.push("", "Changed file summary:");
    lines.push(...prContext.changedFiles.map((file) => `- ${file.filename} (+${file.additions} -${file.deletions}, ${file.status})`));
  }
  return lines.join("\n");
}

export function buildCodexReviewPrompt(input: ReviewBundleInput): string {
  const nextRound = input.round + 1;
  const nextPromptAllowed = nextRound <= input.maxPrompts;
  const previousIssues = input.previousRound?.reviewDraft?.winnerUnresolvedCons ?? [];
  const lines = [
    `Review round ${input.round} for an HFI A/B coding task.`,
    "",
    "Compare Response A and Response B using the evidence in this directory.",
    "Read these files first:",
    "- issue.md",
    "- prompt-current.txt",
    "- pr-context.md",
    "- guidance.md",
    "- context.json",
    "- A/*",
    "- B/*",
    "",
    "Rules:",
    "- Pick exactly one overall winner: A or B.",
    "- Use the actual merged PR only as supporting context.",
    "- Prefer direct evidence from code diffs, tests, git state, and tmux capture.",
    "- Treat tmux output as runtime/process evidence for claims like hangs, permission prompts, ignored input requests, or false success messages.",
    "- Pros and cons must each be paragraphs written about that model only.",
    "- Keep axis ratings coherent with the prose and evidence.",
    "- If evidence is weak, use a slight preference instead of exaggerating.",
  ];

  if (previousIssues.length) {
    lines.push("", "Previous unresolved issues carried into this round:");
    lines.push(...previousIssues.map((item) => `- ${item}`));
  }

  if (nextPromptAllowed) {
    lines.push(
      "",
      `Generate the next follow-up prompt for round ${nextRound}.`,
      "- The prompt must be instruction-style, not a question.",
      "- Address only the winning response's unresolved cons.",
      "- Do not increase scope.",
      "- Include a meaningful commit reminder.",
    );
  } else {
    lines.push("", "This is the final supported round. The nextPrompt field should summarize the final production-readiness pass instead of starting a new scope.");
  }

  lines.push("", "Return JSON only and make sure it matches the provided schema exactly.");
  return lines.join("\n");
}

export function buildCodexReviewSchema(): Record<string, unknown> {
  const axisEnum: CodexAxisPreference[] = ["slight_a", "a", "strong_a", "slight_b", "b", "strong_b"];
  const axisProps = Object.fromEntries(
    CODEX_AXIS_NAMES.map((axis) => [axis, { type: "string", enum: axisEnum }]),
  );
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "winner",
      "modelA",
      "modelB",
      "axes",
      "overallJustification",
      "winnerUnresolvedCons",
      "nextPrompt",
      "confidenceNotes",
    ],
    properties: {
      winner: { type: "string", enum: ["A", "B"] },
      modelA: {
        type: "object",
        additionalProperties: false,
        required: ["pros", "cons"],
        properties: {
          pros: { type: "string" },
          cons: { type: "string" },
        },
      },
      modelB: {
        type: "object",
        additionalProperties: false,
        required: ["pros", "cons"],
        properties: {
          pros: { type: "string" },
          cons: { type: "string" },
        },
      },
      axes: {
        type: "object",
        additionalProperties: false,
        required: CODEX_AXIS_NAMES,
        properties: axisProps,
      },
      overallJustification: { type: "string" },
      winnerUnresolvedCons: {
        type: "array",
        items: { type: "string" },
      },
      nextPrompt: { type: "string" },
      confidenceNotes: { type: "string" },
    },
  };
}

function normalizeAxisPreference(raw: unknown, fallbackWinner: "A" | "B"): CodexAxisPreference {
  if (
    raw === "slight_a"
    || raw === "a"
    || raw === "strong_a"
    || raw === "slight_b"
    || raw === "b"
    || raw === "strong_b"
  ) {
    return raw;
  }
  return fallbackWinner === "A" ? "slight_a" : "slight_b";
}

function normalizeStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => typeof item === "string" ? item.trim() : "")
    .filter(Boolean);
}

export function parseCodexReviewOutput(raw: string): CodexReviewDraft {
  const stripped = stripMarkdownFence(raw);
  const parsed = JSON.parse(stripped) as Record<string, unknown>;
  const winner = parsed.winner === "B" ? "B" : "A";
  const axesRecord = (parsed.axes && typeof parsed.axes === "object" && !Array.isArray(parsed.axes))
    ? parsed.axes as Record<string, unknown>
    : {};
  const axes = Object.fromEntries(
    CODEX_AXIS_NAMES.map((axis) => [axis, normalizeAxisPreference(axesRecord[axis], winner)]),
  ) as Record<CodexAxisName, CodexAxisPreference>;
  const unresolved = normalizeStringArray(parsed.winnerUnresolvedCons);
  return {
    winner,
    modelA: {
      pros: toParagraph((parsed.modelA as Record<string, unknown> | undefined)?.pros as string | undefined, "Response A has no saved pros yet."),
      cons: toParagraph((parsed.modelA as Record<string, unknown> | undefined)?.cons as string | undefined, "Response A has no saved cons yet."),
    },
    modelB: {
      pros: toParagraph((parsed.modelB as Record<string, unknown> | undefined)?.pros as string | undefined, "Response B has no saved pros yet."),
      cons: toParagraph((parsed.modelB as Record<string, unknown> | undefined)?.cons as string | undefined, "Response B has no saved cons yet."),
    },
    axes,
    overallJustification: toParagraph(parsed.overallJustification as string | undefined, "No overall justification was returned."),
    winnerUnresolvedCons: unresolved,
    nextPrompt: typeof parsed.nextPrompt === "string" ? parsed.nextPrompt.trim() : "",
    confidenceNotes: toParagraph(parsed.confidenceNotes as string | undefined, "No confidence notes were returned."),
    generatedAt: new Date().toISOString(),
  };
}

export function createFallbackReviewDraft(round: number, winner: "A" | "B", unresolvedCons: readonly string[]): CodexReviewDraft {
  const prompt = buildFollowUpPrompt(Math.min(round + 1, CODEX_TASK_MAX_PROMPTS), unresolvedCons);
  const axes = Object.fromEntries(
    CODEX_AXIS_NAMES.map((axis) => [axis, winner === "A" ? "slight_a" : "slight_b"]),
  ) as Record<CodexAxisName, CodexAxisPreference>;
  return {
    winner,
    modelA: {
      pros: "Response A fallback review was generated because Codex output could not be parsed.",
      cons: "Response A still needs a manual review pass before submission.",
    },
    modelB: {
      pros: "Response B fallback review was generated because Codex output could not be parsed.",
      cons: "Response B still needs a manual review pass before submission.",
    },
    axes,
    overallJustification: "A fallback review draft was generated because the Codex output was unavailable or invalid. Re-run the review or edit this draft manually before using it.",
    winnerUnresolvedCons: [...unresolvedCons],
    nextPrompt: prompt,
    confidenceNotes: "Fallback review draft only. Confidence is low until Codex completes successfully.",
    generatedAt: new Date().toISOString(),
  };
}

export function writeReviewBundle(bundleDir: string, input: ReviewBundleInput): void {
  ensureDir(bundleDir);
  ensureDir(join(bundleDir, "A"));
  ensureDir(join(bundleDir, "B"));

  writeText(join(bundleDir, "issue.md"), buildIssueMarkdown(input.issue));
  writeText(join(bundleDir, "prompt-current.txt"), input.currentPrompt);
  writeText(join(bundleDir, "pr-context.md"), buildPrContextMarkdown(input.prContext));
  writeText(join(bundleDir, "guidance.md"), GUIDANCE_TEXT);
  writeJson(join(bundleDir, "context.json"), {
    round: input.round,
    maxPrompts: input.maxPrompts,
    originalRepoPath: input.originalRepoPath,
    worktreeAPath: input.worktreeAPath,
    worktreeBPath: input.worktreeBPath,
    testCommand: input.testCommand ?? null,
    screening: input.screening ?? null,
    analysis: input.analysis ?? null,
    previousRound: input.previousRound ?? null,
  });
  writeJson(join(bundleDir, "review-output.schema.json"), buildCodexReviewSchema());

  for (const evidence of [input.responseA, input.responseB]) {
    const dir = join(bundleDir, evidence.label);
    writeText(join(dir, "git-status.txt"), evidence.gitStatus);
    writeText(join(dir, "branch.txt"), evidence.branch);
    writeText(join(dir, "head.txt"), evidence.head);
    writeText(join(dir, "diff-stat.txt"), evidence.diffStat);
    writeText(join(dir, "diff.patch"), evidence.diffPatch);
    writeText(join(dir, "log.txt"), evidence.log);
    writeText(join(dir, "notes.txt"), evidence.notes?.trim() ? evidence.notes.trim() : "No additional user notes.");
    writeText(join(dir, "tmux.txt"), evidence.tmuxCapture?.trim() ? evidence.tmuxCapture.trim() : "tmux capture unavailable.");
    writeJson(join(dir, "evidence.json"), {
      repoPath: evidence.repoPath,
      testCommand: evidence.testCommand ?? null,
      testExitCode: evidence.testExitCode ?? null,
      warnings: evidence.warnings ?? [],
    });
    if (evidence.testOutput !== undefined) {
      writeText(join(dir, "test.txt"), evidence.testOutput);
    }
  }
}
