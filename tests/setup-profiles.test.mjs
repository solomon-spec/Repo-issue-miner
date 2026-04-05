import test from "node:test";
import assert from "node:assert/strict";

import { buildDefaultSetupProfiles, DEFAULT_SETUP_PROFILE_NAMES } from "../dist/setup-profiles.js";

test("default setup profiles preserve required setup constraints", () => {
  const profiles = buildDefaultSetupProfiles("/tmp/pr-writer-tasks");

  assert.equal(profiles.length, 3);
  for (const profile of profiles) {
    assert.match(profile.prompt, /Do not modify application or source code files\./);
    assert.match(profile.prompt, /Do not create new files other than a root-level Dockerfile/i);
    assert.match(profile.prompt, /Do not create, edit, or rely on Docker Compose\./i);
    assert.match(profile.prompt, /remove them before finishing/i);
    assert.match(profile.prompt, /README changes must only explain how to build and run the Docker image/i);
    assert.doesNotMatch(profile.prompt, /native installation/i);
    assert.match(profile.validationPrompt, /build(?:ing)? the root Dockerfile once/i);
    assert.match(profile.validationPrompt, /Actually execute the Docker build and test commands/i);
  }
});

test("default setup profiles bias toward smaller, cache-friendly setup work", () => {
  const profiles = buildDefaultSetupProfiles("/tmp/pr-writer-tasks");
  const python = profiles.find((profile) => profile.name === DEFAULT_SETUP_PROFILE_NAMES.python);
  const javascript = profiles.find((profile) => profile.name === DEFAULT_SETUP_PROFILE_NAMES.javascript);
  const typescript = profiles.find((profile) => profile.name === DEFAULT_SETUP_PROFILE_NAMES.typescript);

  assert.ok(python);
  assert.ok(javascript);
  assert.ok(typescript);

  assert.match(python.prompt, /1\.\s+Scan the repository/i);
  assert.match(python.prompt, /7\.\s+If any required step cannot succeed/i);
  assert.match(python.prompt, /avoid mass-pinning speculative transitive packages/i);
  assert.match(python.prompt, /Docker build and Docker test workflow with one stable image tag/i);
  assert.match(python.prompt, /copy dependency manifests before large source trees/i);
  assert.match(python.prompt, /how to build the Docker image/i);
  assert.match(python.prompt, /Do not add dependency-installation instructions.*README/i);
  assert.match(python.validationPrompt, /Reuse the built image for follow-up docker run checks/i);
  assert.match(python.validationPrompt, /SKIP_SETUP/i);

  assert.match(javascript.prompt, /avoid broad version churn in unrelated packages/i);
  assert.match(javascript.prompt, /If lock files already exist, use them only as reference material while scanning, then remove them before finishing/i);
  assert.match(javascript.prompt, /how to run the repository tests from that Docker workflow/i);
  assert.match(javascript.validationPrompt, /only rebuild if you changed a setup file after the last build/i);

  assert.match(typescript.prompt, /avoid broad version churn in unrelated packages/i);
  assert.match(typescript.prompt, /Docker build plus Docker test workflow/i);
  assert.doesNotMatch(typescript.prompt, /native install/i);
  assert.match(typescript.validationPrompt, /test command and typecheck command inside the container/i);
});

test("default setup profiles still allow existing lock files to be removed", () => {
  const profiles = buildDefaultSetupProfiles("/tmp/pr-writer-tasks");

  for (const profile of profiles) {
    assert.ok(profile.writablePaths.includes("**/*.lock"));
  }
});
