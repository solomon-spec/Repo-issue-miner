import test from "node:test";
import assert from "node:assert/strict";

import {
  analyzePullRequestFiles,
  chooseLanguageBucket,
  extractIssueReferences,
} from "../dist/parsing.js";

test("chooseLanguageBucket prefers matching primary language when requested", () => {
  const bucket = chooseLanguageBucket(
    {
      owner: "example",
      name: "repo",
      fullName: "example/repo",
      url: "https://github.com/example/repo",
      isArchived: false,
      stars: 100,
      primaryLanguage: "TypeScript",
      defaultBranch: "main",
    },
    ["python", "typescript"],
  );

  assert.equal(bucket, "typescript");
});

test("analyzePullRequestFiles accepts non-trivial source changes with tests", () => {
  const analysis = analyzePullRequestFiles([
    { filename: "src/app.ts", status: "modified", additions: 56, deletions: 12, changes: 68 },
    { filename: "src/server.ts", status: "modified", additions: 72, deletions: 18, changes: 90 },
    { filename: "src/http/router.ts", status: "modified", additions: 64, deletions: 14, changes: 78 },
    { filename: "src/http/client.ts", status: "modified", additions: 58, deletions: 10, changes: 68 },
    { filename: "src/db/store.ts", status: "modified", additions: 61, deletions: 9, changes: 70 },
    { filename: "tests/app.spec.ts", status: "added", additions: 20, deletions: 0, changes: 20 },
    { filename: "package-lock.json", status: "modified", additions: 1, deletions: 1, changes: 2 },
  ], "typescript");

  assert.equal(analysis.accepted, true);
  assert.equal(analysis.relevantSourceFiles.length, 5);
  assert.equal(analysis.relevantTestFiles.length, 1);
  assert.deepEqual(analysis.touchedDirectories.sort(), ["src", "src/db", "src/http", "tests"]);
  assert.match(analysis.nonTrivialReasons.join(" "), /touches 5 relevant source files/i);
  assert.match(analysis.nonTrivialReasons.join(" "), /changes 1 test files/i);
  assert.match(analysis.nonTrivialReasons.join(" "), /changes \d+ relevant code lines/i);
  assert.deepEqual(analysis.ignoredFiles, ["package-lock.json"]);
});

test("analyzePullRequestFiles rejects test-only or mostly ignored changes", () => {
  const analysis = analyzePullRequestFiles([
    { filename: "tests/feature.spec.ts", status: "added", additions: 30, deletions: 0, changes: 30 },
    { filename: "README.md", status: "modified", additions: 3, deletions: 1, changes: 4 },
    { filename: "docs/guide.md", status: "modified", additions: 4, deletions: 2, changes: 6 },
  ], "typescript");

  assert.equal(analysis.accepted, false);
  assert.equal(analysis.relevantSourceFiles.length, 0);
  assert.equal(analysis.relevantTestFiles.length, 1);
  assert.match(analysis.nonTrivialReasons.join(" "), /test-only change/i);
});

test("extractIssueReferences parses same-repo and cross-repo references and dedupes them", () => {
  const refs = extractIssueReferences(
    {
      number: 17,
      url: "https://github.com/example/repo/pull/17",
      title: "Fix bug",
      body: "Fixes #12 and resolves other/repo#99. Also closes #12 again.",
      labels: [],
      baseRefName: "main",
      baseRefOid: "abc",
      headRefOid: "def",
    },
    {
      owner: "example",
      name: "repo",
      fullName: "example/repo",
      url: "https://github.com/example/repo",
      isArchived: false,
      stars: 40,
      defaultBranch: "main",
    },
  );

  assert.deepEqual(refs, [
    { owner: "example", repo: "repo", number: 12, linkType: "pr_keyword" },
    { owner: "other", repo: "repo", number: 99, linkType: "pr_keyword" },
  ]);
});
