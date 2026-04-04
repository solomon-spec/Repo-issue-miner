import test from "node:test";
import assert from "node:assert/strict";

import { screenRepository } from "../dist/repo-screen.js";

function repo(overrides = {}) {
  return {
    owner: "example",
    name: "repo",
    fullName: "example/repo",
    url: "https://github.com/example/repo",
    isArchived: false,
    stars: 120,
    primaryLanguage: "TypeScript",
    defaultBranch: "main",
    ...overrides,
  };
}

test("screenRepository accepts repos with package manager, tests, Dockerfile, and English README hints", () => {
  const result = screenRepository(
    repo(),
    [
      { path: "package.json", type: "blob" },
      { path: "Dockerfile", type: "blob" },
      { path: "src/index.ts", type: "blob" },
      { path: "tests/app.spec.ts", type: "blob" },
      { path: "README.md", type: "blob" },
    ],
    "Install dependencies with npm install, run tests with npm test, and run Docker builds from the project root.",
  );

  assert.equal(result.accepted, true);
  assert.equal(result.packageManager, "npm-compatible");
  assert.equal(result.hasDockerfile, true);
  assert.equal(result.hasTests, true);
  assert.equal(result.readmeEnglishLikely, true);
  assert.equal(result.hasBuildHints, true);
  assert.deepEqual(result.reasons, []);
});

test("screenRepository reports missing requirements and archived repos clearly", () => {
  const result = screenRepository(
    repo({ isArchived: true }),
    [
      { path: "src/index.py", type: "blob" },
      { path: "README.md", type: "blob" },
    ],
    "Proyecto rapido.",
  );

  assert.equal(result.accepted, false);
  assert.match(result.reasons.join(" | "), /repo is archived/i);
  assert.match(result.reasons.join(" | "), /missing standard package manager manifest/i);
  assert.match(result.reasons.join(" | "), /missing Dockerfile/i);
  assert.match(result.reasons.join(" | "), /tests not detected/i);
  assert.match(result.reasons.join(" | "), /README does not look English enough/i);
});
