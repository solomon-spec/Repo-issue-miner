import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildSetupPrompt,
  listSetupLockFiles,
  removeSetupLockFiles,
} from "../dist/setup.js";

test("listSetupLockFiles finds common lock files across stacks", () => {
  const locks = listSetupLockFiles([
    "package-lock.json",
    "pnpm-lock.yaml",
    "poetry.lock",
    "nested/Cargo.lock",
    "src/app.ts",
    "requirements.txt",
  ]);

  assert.deepEqual(locks, [
    "nested/Cargo.lock",
    "package-lock.json",
    "pnpm-lock.yaml",
    "poetry.lock",
  ]);
});

test("removeSetupLockFiles deletes detected lock files from the worktree", () => {
  const root = mkdtempSync(join(tmpdir(), "setup-locks-"));
  try {
    mkdirSync(join(root, "nested"), { recursive: true });
    writeFileSync(join(root, "poetry.lock"), "locked\n", "utf8");
    writeFileSync(join(root, "nested", "Cargo.lock"), "locked\n", "utf8");

    const removed = removeSetupLockFiles(root, ["poetry.lock", "nested/Cargo.lock", "README.md"]);

    assert.deepEqual(removed, ["nested/Cargo.lock", "poetry.lock"]);
    assert.equal(existsSync(join(root, "poetry.lock")), false);
    assert.equal(existsSync(join(root, "nested", "Cargo.lock")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildSetupPrompt includes deterministic setup notes and removed lock files", () => {
  const prompt = buildSetupPrompt(
    {
      owner: "example",
      name: "repo",
      fullName: "example/repo",
      url: "https://github.com/example/repo",
      isArchived: false,
      stars: 10,
      defaultBranch: "main",
      primaryLanguage: "Python",
    },
    {
      rootDir: "/tmp/repo",
      fullName: "example/repo",
      owner: "example",
      repo: "repo",
      sha: "abc123",
      sizeBytes: 100,
      files: ["README.md", "Dockerfile", "pyproject.toml", "poetry.lock"],
    },
    {
      prompt: "1. Scan the repository.\n2. Build Docker.\n3. Update the README.",
      contextPaths: ["README*", "Dockerfile", "poetry.lock"],
      writablePaths: ["Dockerfile", "README*", "**/*.lock"],
      validationPrompt: "Validate by building the root Dockerfile once.",
    },
    {
      targetType: "repo",
      targetLabel: "example/repo",
    },
    {
      removedLockFiles: ["poetry.lock"],
    },
  );

  assert.match(prompt, /configured git core\.fileMode to false locally and globally/i);
  assert.match(prompt, /Complete the numbered steps in order/i);
  assert.match(prompt, /SKIP_SETUP:/i);
  assert.match(prompt, /The platform already scanned and removed these lock files/i);
  assert.match(prompt, /poetry\.lock/);
  assert.doesNotMatch(prompt, /Read these files first before making changes:\n- poetry\.lock/i);
});
