import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildCodexReviewPrompt,
  buildFollowUpPrompt,
  buildPromptOne,
  buildTmuxSessionInfo,
  parseCodexReviewOutput,
  parsePromptOneRewriteOutput,
  reopenLastCodexTaskRound,
  updateCodexTaskSettings,
  writeReviewBundle,
} from "../dist/codex-task.js";

test("buildPromptOne preserves issue facts while turning it into a prompt", () => {
  const prompt = buildPromptOne({
    owner: "azure",
    repo: "sdk-for-python",
    number: 42,
    title: "Managed Identity token refresh fails on regional endpoints",
    body: "When using Managed Identity in Azure, requests to regional endpoints can fail after token refresh.",
    selectedFromCount: 1,
  });

  assert.match(prompt, /current repository/i);
  assert.match(prompt, /Managed Identity token refresh fails on regional endpoints/);
  assert.match(prompt, /Managed Identity in Azure/);
  assert.match(prompt, /Preserve the original constraints/i);
  assert.doesNotMatch(prompt, /Issue title:/i);
  assert.doesNotMatch(prompt, /consent cookies/i);
});

test("parsePromptOneRewriteOutput extracts the rewritten prompt from Codex JSON", () => {
  const prompt = parsePromptOneRewriteOutput(`\`\`\`json
{"prompt":"Investigate the Managed Identity refresh flow and fix the regional endpoint failure without expanding the scope."}
\`\`\``);

  assert.match(prompt, /Investigate the Managed Identity refresh flow/i);
  assert.doesNotMatch(prompt, /^```/);
});

test("parsePromptOneRewriteOutput rejects the legacy issue-copy format", () => {
  assert.throws(
    () => parsePromptOneRewriteOutput(JSON.stringify({
      prompt: "Address the following GitHub issue in the current repository.\n\nIssue title: Fix rate limiting\n\nIssue description:\n\nThe plugin is rate limited.",
    })),
    /legacy issue-copy format/i,
  );
});

test("reopenLastCodexTaskRound rewinds to the latest reviewed round and drops stale next prompts", () => {
  const reopened = reopenLastCodexTaskRound({
    hfiUuid: "abc-123",
    originalRepoPath: "/repo",
    worktreeAPath: "/repo-a",
    worktreeBPath: "/repo-b",
    currentRound: 3,
    maxPrompts: 4,
    startedAt: "2026-04-06T00:00:00.000Z",
    updatedAt: "2026-04-06T00:00:00.000Z",
    issue: {
      title: "Fix retry loop",
      selectedFromCount: 1,
    },
    prompts: [
      { round: 1, prompt: "Prompt 1", source: "issue_rewrite", generatedAt: "2026-04-06T00:00:00.000Z" },
      { round: 2, prompt: "Prompt 2", source: "review_follow_up", generatedAt: "2026-04-06T00:00:01.000Z" },
      { round: 3, prompt: "Prompt 3", source: "review_follow_up", generatedAt: "2026-04-06T00:00:02.000Z" },
    ],
    rounds: [
      {
        round: 1,
        notesA: "round1 A",
        notesB: "round1 B",
        reviewDraft: {
          winner: "A",
          modelA: { pros: "ok", cons: "minor" },
          modelB: { pros: "ok", cons: "minor" },
          axes: {
            preferred_output: "a",
            logic_and_correctness: "a",
            naming_and_clarity: "a",
            organization_and_modularity: "a",
            interface_design: "a",
            error_handling: "a",
            comments_and_documentation: "a",
            review_and_production_readiness: "a",
          },
          overallJustification: "A wins",
          winnerUnresolvedCons: ["none"],
          nextPrompt: "Prompt 2",
          confidenceNotes: "high",
          generatedAt: "2026-04-06T00:00:01.000Z",
        },
      },
      {
        round: 2,
        notesA: "round2 A",
        notesB: "round2 B",
        reviewDraft: {
          winner: "B",
          modelA: { pros: "ok", cons: "minor" },
          modelB: { pros: "ok", cons: "minor" },
          axes: {
            preferred_output: "b",
            logic_and_correctness: "b",
            naming_and_clarity: "b",
            organization_and_modularity: "b",
            interface_design: "b",
            error_handling: "b",
            comments_and_documentation: "b",
            review_and_production_readiness: "b",
          },
          overallJustification: "B wins",
          winnerUnresolvedCons: ["add tests"],
          nextPrompt: "Prompt 3",
          confidenceNotes: "medium",
          generatedAt: "2026-04-06T00:00:02.000Z",
        },
        artifactDir: "/tmp/review-2",
        generatedAt: "2026-04-06T00:00:02.000Z",
        promptGeneratedForNextRound: 3,
      },
    ],
  });

  assert.equal(reopened.currentRound, 2);
  assert.deepEqual(reopened.prompts.map((item) => item.round), [1, 2]);
  assert.equal(reopened.rounds.length, 2);
  assert.equal(reopened.rounds[1].round, 2);
  assert.equal(reopened.rounds[1].notesA, "round2 A");
  assert.equal(reopened.rounds[1].reviewDraft, undefined);
});

test("reopenLastCodexTaskRound rejects tasks with no completed rounds", () => {
  assert.throws(
    () => reopenLastCodexTaskRound({
      hfiUuid: "abc-123",
      originalRepoPath: "/repo",
      worktreeAPath: "/repo-a",
      worktreeBPath: "/repo-b",
      currentRound: 1,
      maxPrompts: 4,
      startedAt: "2026-04-06T00:00:00.000Z",
      updatedAt: "2026-04-06T00:00:00.000Z",
      issue: {
        title: "Fix retry loop",
        selectedFromCount: 1,
      },
      prompts: [
        { round: 1, prompt: "Prompt 1", source: "issue_rewrite", generatedAt: "2026-04-06T00:00:00.000Z" },
      ],
      rounds: [],
    }),
    /no completed round is available to reopen/i,
  );
});

test("updateCodexTaskSettings changes UUID and paths without resetting task history", () => {
  const updated = updateCodexTaskSettings({
    hfiUuid: "old-uuid",
    originalRepoPath: "/repo-old",
    worktreeAPath: "/repo-old-a",
    worktreeBPath: "/repo-old-b",
    testCommand: "npm test",
    currentRound: 3,
    maxPrompts: 4,
    startedAt: "2026-04-06T00:00:00.000Z",
    updatedAt: "2026-04-06T00:00:01.000Z",
    issue: {
      title: "Fix retry loop",
      selectedFromCount: 1,
    },
    prompts: [
      { round: 1, prompt: "Prompt 1", source: "issue_rewrite", generatedAt: "2026-04-06T00:00:00.000Z" },
      { round: 2, prompt: "Prompt 2", source: "review_follow_up", generatedAt: "2026-04-06T00:00:01.000Z" },
      { round: 3, prompt: "Prompt 3", source: "review_follow_up", generatedAt: "2026-04-06T00:00:02.000Z" },
    ],
    rounds: [
      { round: 1, notesA: "A1", notesB: "B1" },
      { round: 2, notesA: "A2", notesB: "B2" },
    ],
  }, {
    hfiUuid: "new-uuid",
    originalRepoPath: "/repo-new",
    worktreeAPath: "/repo-new-a",
    worktreeBPath: "/repo-new-b",
    testCommand: "pnpm test",
  });

  assert.equal(updated.hfiUuid, "new-uuid");
  assert.equal(updated.originalRepoPath, "/repo-new");
  assert.equal(updated.worktreeAPath, "/repo-new-a");
  assert.equal(updated.worktreeBPath, "/repo-new-b");
  assert.equal(updated.testCommand, "pnpm test");
  assert.equal(updated.currentRound, 3);
  assert.equal(updated.startedAt, "2026-04-06T00:00:00.000Z");
  assert.deepEqual(updated.prompts.map((item) => item.round), [1, 2, 3]);
  assert.deepEqual(updated.rounds.map((item) => item.round), [1, 2]);
});

test("buildFollowUpPrompt addresses unresolved cons without widening scope", () => {
  const prompt = buildFollowUpPrompt(3, [
    "Remove the permission-only file changes.",
    "Tighten the README instructions so they match the real test command.",
  ]);

  assert.match(prompt, /without increasing the scope/i);
  assert.match(prompt, /permission-only file changes/i);
  assert.match(prompt, /README instructions/i);
  assert.match(prompt, /Commit the changes/i);
});

test("buildTmuxSessionInfo uses only the HFI UUID for A and B sessions", () => {
  const tmux = buildTmuxSessionInfo("abc-123");

  assert.equal(tmux.sessionA, "abc-123-A");
  assert.equal(tmux.sessionB, "abc-123-B");
  assert.equal(tmux.attachA, "tmux attach -t abc-123-A");
  assert.equal(tmux.attachB, "tmux attach -t abc-123-B");
});

test("parseCodexReviewOutput normalizes structured JSON from Codex", () => {
  const draft = parseCodexReviewOutput(JSON.stringify({
    winner: "B",
    modelA: { pros: "A had better naming.", cons: "A introduced unrelated file changes." },
    modelB: { pros: "B stayed within scope.", cons: "B still needs one more edge-case test." },
    axes: {
      preferred_output: "b",
      logic_and_correctness: "strong_b",
      naming_and_clarity: "slight_a",
      organization_and_modularity: "b",
      interface_design: "slight_b",
      error_handling: "b",
      comments_and_documentation: "slight_b",
      review_and_production_readiness: "b",
    },
    overallJustification: "B is the stronger production-ready checkpoint.",
    winnerUnresolvedCons: ["Add one more edge-case test."],
    nextPrompt: "Address the remaining edge-case coverage and commit the change.",
    confidenceNotes: "Test output was available for both responses.",
  }));

  assert.equal(draft.winner, "B");
  assert.equal(draft.axes.logic_and_correctness, "strong_b");
  assert.deepEqual(draft.winnerUnresolvedCons, ["Add one more edge-case test."]);
});

test("writeReviewBundle persists issue, PR, and fallback tmux evidence files", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-task-test-"));
  try {
    writeReviewBundle(dir, {
      round: 1,
      maxPrompts: 4,
      issue: {
        title: "Fix race in selector shutdown ordering",
        body: "The selector can leave a lingering background task during shutdown.",
        selectedFromCount: 1,
      },
      prContext: {
        number: 10,
        url: "https://github.com/example/repo/pull/10",
        title: "Fix selector shutdown race",
        body: "Adds shutdown guardrails without changing scope.",
        changedFilesCount: 2,
        changedFiles: [
          { filename: "src/selector.ts", additions: 10, deletions: 2, changes: 12, status: "modified" },
        ],
        fetchedAt: new Date().toISOString(),
      },
      currentPrompt: "Address the selector shutdown race in this repository.",
      originalRepoPath: "/repo",
      worktreeAPath: "/repo-a",
      worktreeBPath: "/repo-b",
      responseA: {
        label: "A",
        repoPath: "/repo-a",
        gitStatus: "## main",
        branch: "main",
        head: "abc123",
        diffStat: "1 file changed",
        diffPatch: "diff --git a/src/selector.ts b/src/selector.ts",
        log: "abc123 fix selector",
      },
      responseB: {
        label: "B",
        repoPath: "/repo-b",
        gitStatus: "## main",
        branch: "main",
        head: "def456",
        diffStat: "2 files changed",
        diffPatch: "diff --git a/src/selector.ts b/src/selector.ts",
        log: "def456 fix selector better",
      },
    });

    assert.match(readFileSync(join(dir, "issue.md"), "utf8"), /Fix race in selector shutdown ordering/);
    assert.match(readFileSync(join(dir, "pr-context.md"), "utf8"), /Fix selector shutdown race/);
    assert.match(readFileSync(join(dir, "A", "tmux.txt"), "utf8"), /tmux capture unavailable/i);
    assert.match(readFileSync(join(dir, "B", "notes.txt"), "utf8"), /No additional user notes/i);
    assert.match(readFileSync(join(dir, "review-output.schema.json"), "utf8"), /preferred_output/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildCodexReviewPrompt reminds Codex to use PR context only as support", () => {
  const prompt = buildCodexReviewPrompt({
    round: 2,
    maxPrompts: 4,
    issue: {
      title: "Fix invalid retry backoff when a resolver times out",
      body: "Retry backoff can become negative after a resolver timeout.",
      selectedFromCount: 1,
    },
    currentPrompt: "Continue from the selected checkpoint and fix the remaining retry backoff bug.",
    originalRepoPath: "/repo",
    worktreeAPath: "/repo-a",
    worktreeBPath: "/repo-b",
    responseA: {
      label: "A",
      repoPath: "/repo-a",
      gitStatus: "",
      branch: "",
      head: "",
      diffStat: "",
      diffPatch: "",
      log: "",
    },
    responseB: {
      label: "B",
      repoPath: "/repo-b",
      gitStatus: "",
      branch: "",
      head: "",
      diffStat: "",
      diffPatch: "",
      log: "",
    },
  });

  assert.match(prompt, /actual merged PR only as supporting context/i);
  assert.match(prompt, /Pick exactly one overall winner/i);
});
