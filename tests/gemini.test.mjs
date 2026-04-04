import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import {
  describePlan,
  detectComposeBuild,
  localPath,
  relativeWorkdir,
  resolveTestPlan,
} from "../dist/gemini.js";

function makeSnapshot(files) {
  const rootDir = mkdtempSync(join(tmpdir(), "repo-issue-miner-gemini-"));
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = join(rootDir, relPath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, "utf8");
  }
  return {
    snapshot: {
      rootDir,
      fullName: "example/repo",
      owner: "example",
      repo: "repo",
      sha: "abcdef1234567890",
      sizeBytes: 1024,
      files: Object.keys(files),
    },
    cleanup() {
      rmSync(rootDir, { recursive: true, force: true });
    },
  };
}

const baseConfig = {
  githubToken: undefined,
  geminiApiKey: undefined,
  geminiModel: "gemini-2.5-flash",
  geminiApiBase: "https://example.invalid",
  maxRepoSizeBytes: 1000,
  requestTimeoutMs: 1000,
  buildTimeoutMs: 1000,
  testTimeoutMs: 1000,
  workRoot: "/tmp/work",
  outputRoot: "/tmp/output",
  dbPath: "/tmp/db.sqlite",
  host: "127.0.0.1",
  port: 3000,
  minStars: 50,
  repoLimit: 10,
  repoConcurrency: 2,
  prLimit: 10,
  mergedAfter: undefined,
  languages: ["typescript"],
  scanMode: "issue-first",
  targetRepo: undefined,
  dryRun: false,
  keepWorktree: false,
};

test("detectComposeBuild finds buildable services in compose yaml", () => {
  const { snapshot, cleanup } = makeSnapshot({
    "compose.yaml": [
      "services:",
      "  web:",
      "    build: .",
      "  worker:",
      "    image: node:22",
      "  api:",
      "    build:",
      "      context: .",
    ].join("\n"),
  });

  try {
    const compose = detectComposeBuild(snapshot);
    assert.deepEqual(compose, {
      composeFilePath: "compose.yaml",
      buildServices: ["web", "api"],
    });
  } finally {
    cleanup();
  }
});

test("resolveTestPlan prefers compose-run when compose build services exist", async () => {
  const { snapshot, cleanup } = makeSnapshot({
    "Dockerfile": "FROM node:22\nWORKDIR /app\nCOPY . .\n",
    "package.json": JSON.stringify({
      name: "repo",
      scripts: { test: "vitest run" },
      packageManager: "pnpm@9.0.0",
    }),
    "compose.yaml": [
      "services:",
      "  web:",
      "    build: .",
    ].join("\n"),
  });

  try {
    const plan = await resolveTestPlan(baseConfig, snapshot);
    assert.equal(plan?.runner, "compose-run");
    assert.equal(plan?.composeFilePath, "compose.yaml");
    assert.deepEqual(plan?.composeBuildServices, ["web"]);
    assert.deepEqual(plan?.testCommand, ["pnpm", "test"]);
  } finally {
    cleanup();
  }
});

test("resolveTestPlan falls back to pytest for python snapshots with tests", async () => {
  const { snapshot, cleanup } = makeSnapshot({
    "Dockerfile": "FROM python:3.12\nWORKDIR /app\nCOPY . .\n",
    "tests/test_api.py": "def test_api():\n    assert True\n",
  });

  try {
    const plan = await resolveTestPlan({ ...baseConfig, languages: ["python"] }, snapshot);
    assert.equal(plan?.runner, "docker-run");
    assert.equal(plan?.dockerfilePath, "Dockerfile");
    assert.deepEqual(plan?.testCommand, ["pytest", "-q"]);
    assert.match(describePlan(plan), /docker-run/);
    assert.match(describePlan(plan), /pytest -q/);
  } finally {
    cleanup();
  }
});

test("localPath and relativeWorkdir resolve within the snapshot root", () => {
  const { snapshot, cleanup } = makeSnapshot({
    "Dockerfile": "FROM node:22\n",
    "subdir/file.txt": "hello",
  });

  try {
    assert.equal(localPath(snapshot, "Dockerfile"), join(snapshot.rootDir, "Dockerfile"));
    assert.equal(localPath(snapshot, "missing.txt"), undefined);
    assert.equal(relativeWorkdir(snapshot, "subdir"), join(snapshot.rootDir, "subdir"));
    assert.equal(relativeWorkdir(snapshot, "."), snapshot.rootDir);
  } finally {
    cleanup();
  }
});
