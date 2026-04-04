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

  assert.match(prompt, /Address the following GitHub issue/i);
  assert.match(prompt, /Managed Identity token refresh fails on regional endpoints/);
  assert.match(prompt, /Managed Identity in Azure/);
  assert.doesNotMatch(prompt, /consent cookies/i);
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
