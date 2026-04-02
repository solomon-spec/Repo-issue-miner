import { join, relative } from "node:path";
import { Config, ExecutionResult, RepoSnapshot, TestPlan } from "./types.js";
import { describePlan, detectComposeBuild, localPath, relativeWorkdir } from "./gemini.js";
import { ensureDir, runCommand, sanitizeTag } from "./util.js";

export type ExecutionMonitor = {
  signal?: AbortSignal;
  onStage?: (stage: string) => void;
  onOutput?: (phase: "build" | "test", stream: "stdout" | "stderr", chunk: string) => void;
  buildTimeoutMs?: number;
  testTimeoutMs?: number;
};

let dockerBuilderSequence = 0;

function formatTimeoutMs(timeoutMs: number): string {
  if (timeoutMs < 60_000) return `${Math.round(timeoutMs / 1000)}s`;
  const minutes = timeoutMs / 60_000;
  return Number.isInteger(minutes) ? `${minutes}m` : `${minutes.toFixed(1)}m`;
}

async function cleanupTemporaryDockerImage(imageTag: string | undefined): Promise<void> {
  if (!imageTag) return;
  const result = await runCommand({
    cmd: "docker",
    args: ["image", "rm", "-f", imageTag],
  });
  const combinedOutput = `${result.stdout}\n${result.stderr}`;
  if (result.code !== 0 && !/no such image/i.test(combinedOutput)) {
    throw new Error(combinedOutput.trim() || `failed to remove temporary image ${imageTag}`);
  }
}

async function createEphemeralDockerBuilder(): Promise<string> {
  dockerBuilderSequence += 1;
  const builderName = sanitizeTag(`repo-issue-miner-${process.pid}-${Date.now().toString(36)}-${dockerBuilderSequence}`);
  const result = await runCommand({
    cmd: "docker",
    args: ["buildx", "create", "--name", builderName, "--driver", "docker-container", "--bootstrap"],
  });
  const combinedOutput = `${result.stdout}\n${result.stderr}`;
  if (result.code !== 0) {
    throw new Error(combinedOutput.trim() || "failed to create temporary Docker builder");
  }
  return builderName;
}

async function cleanupEphemeralDockerBuilder(builderName: string | undefined): Promise<void> {
  if (!builderName) return;
  const result = await runCommand({
    cmd: "docker",
    args: ["buildx", "rm", "-f", builderName],
  });
  const combinedOutput = `${result.stdout}\n${result.stderr}`;
  if (result.code !== 0 && !/no builder|not found/i.test(combinedOutput)) {
    throw new Error(combinedOutput.trim() || `failed to remove temporary builder ${builderName}`);
  }
}

async function verifyBuiltDockerImage(imageTag: string, signal: AbortSignal | undefined): Promise<{ ok: boolean; imageId?: string; detail?: string }> {
  const result = await runCommand({
    cmd: "docker",
    args: ["image", "inspect", "--format={{.Id}}", imageTag],
    signal,
  });
  const imageId = result.stdout.trim();
  if (result.code !== 0) {
    const detail = `${result.stderr}\n${result.stdout}`.trim() || `docker image inspect failed for ${imageTag}`;
    return { ok: false, detail };
  }
  if (!imageId) {
    return { ok: false, detail: `docker image inspect returned no image id for ${imageTag}` };
  }
  return { ok: true, imageId };
}

async function buildDirectDockerImage(
  snapshot: RepoSnapshot,
  dockerfilePath: string,
  imageTag: string,
  builderName: string,
  monitor: ExecutionMonitor,
  buildStdoutPath: string,
  buildStderrPath: string,
): Promise<{ buildPassed: boolean; buildExitCode: number | null; builtImageId?: string; notes: string[] }> {
  const notes: string[] = [];
  const build = await runCommand({
    cmd: "docker",
    args: ["buildx", "build", "--builder", builderName, "--progress=plain", "--load", "-t", imageTag, "-f", dockerfilePath, snapshot.rootDir],
    timeoutMs: monitor.buildTimeoutMs,
    signal: monitor.signal,
    stdoutPath: buildStdoutPath,
    stderrPath: buildStderrPath,
    onStdoutChunk: (chunk) => monitor.onOutput?.("build", "stdout", chunk),
    onStderrChunk: (chunk) => monitor.onOutput?.("build", "stderr", chunk),
  });
  let buildPassed = build.code === 0;
  let builtImageId: string | undefined;
  if (build.timedOut && monitor.buildTimeoutMs) {
    notes.push(`docker build timed out after ${formatTimeoutMs(monitor.buildTimeoutMs)}`);
  }
  if (buildPassed) {
    const verification = await verifyBuiltDockerImage(imageTag, monitor.signal);
    if (!verification.ok) {
      buildPassed = false;
      notes.push(`docker image verification failed: ${verification.detail}`);
    } else {
      builtImageId = verification.imageId;
      notes.push(`verified built image ${builtImageId}`);
    }
  }
  return {
    buildPassed,
    buildExitCode: build.code,
    builtImageId,
    notes,
  };
}

async function runTestsInDockerImage(
  imageTag: string,
  plan: TestPlan,
  monitor: ExecutionMonitor,
  testStdoutPath: string,
  testStderrPath: string,
): Promise<{ testsPassed: boolean; testExitCode: number | null; notes: string[] }> {
  const notes: string[] = [];
  if (!plan.testCommand.length) {
    return {
      testsPassed: false,
      testExitCode: null,
      notes: ["no safe test command was inferred for running tests inside Docker"],
    };
  }

  monitor.onStage?.("Running tests inside Docker");
  const [entrypoint, ...rest] = plan.testCommand;
  notes.push(`executed test command: ${plan.testCommand.join(" ")}`);
  if (plan.workdir && plan.workdir !== ".") {
    notes.push(`inferred workdir '${plan.workdir}' was not enforced; the container relies on the Dockerfile WORKDIR`);
  }

  const test = await runCommand({
    cmd: "docker",
    args: ["run", "--rm", "--entrypoint", entrypoint, imageTag, ...rest],
    timeoutMs: monitor.testTimeoutMs,
    signal: monitor.signal,
    stdoutPath: testStdoutPath,
    stderrPath: testStderrPath,
    onStdoutChunk: (chunk) => monitor.onOutput?.("test", "stdout", chunk),
    onStderrChunk: (chunk) => monitor.onOutput?.("test", "stderr", chunk),
  });
  if (test.timedOut && monitor.testTimeoutMs) {
    notes.push(`docker test run timed out after ${formatTimeoutMs(monitor.testTimeoutMs)}`);
  }
  return {
    testsPassed: test.code === 0,
    testExitCode: test.code,
    notes,
  };
}

export async function executeTestPlan(
  config: Config,
  snapshot: RepoSnapshot,
  plan: TestPlan,
  monitor: ExecutionMonitor = {},
): Promise<ExecutionResult> {
  const logDir = join(config.outputRoot, "logs", sanitizeTag(`${snapshot.fullName}-${snapshot.sha.slice(0, 12)}`));
  ensureDir(logDir);

  const notes = [`plan: ${describePlan(plan)}`];
  const imageTag = sanitizeTag(`${snapshot.owner}-${snapshot.repo}-${snapshot.sha.slice(0, 12)}`);
  const dockerfilePath = localPath(snapshot, plan.dockerfilePath);
  const buildStdoutPath = join(logDir, "build.stdout.log");
  const buildStderrPath = join(logDir, "build.stderr.log");
  const testStdoutPath = join(logDir, "test.stdout.log");
  const testStderrPath = join(logDir, "test.stderr.log");
  let builderName: string | undefined;

  let buildPassed = false;
  let testsPassed = false;
  let buildExitCode: number | null = null;
  let testExitCode: number | null = null;
  let builtImageId: string | undefined;
  try {
    if (plan.runner === "none") {
      return {
        buildPassed: false,
        testsPassed: false,
        buildExitCode: null,
        testExitCode: null,
        usedPlan: plan,
        notes: [...notes, "no Docker build plan could be inferred"],
      };
    }

    if (plan.runner === "docker-target") {
      if (!dockerfilePath) {
        return {
          buildPassed: false,
          testsPassed: false,
          buildExitCode: null,
          testExitCode: null,
          usedPlan: plan,
          notes: [...notes, "missing dockerfile path"],
        };
      }
      builderName = await createEphemeralDockerBuilder();
      monitor.onStage?.("Building Docker image");
      const build = await buildDirectDockerImage(snapshot, dockerfilePath, imageTag, builderName, monitor, buildStdoutPath, buildStderrPath);
      buildExitCode = build.buildExitCode;
      buildPassed = build.buildPassed;
      builtImageId = build.builtImageId;
      notes.push(...build.notes);
      testsPassed = buildPassed;
      testExitCode = null;
      notes.push("build-only validation skipped in-container test execution");
      if (plan.dockerTarget) {
        notes.push(`ignored docker target '${plan.dockerTarget}' because build-only validation does not run test stages`);
      }
    } else if (plan.runner === "docker-run") {
      if (!dockerfilePath) {
        return {
          buildPassed: false,
          testsPassed: false,
          buildExitCode: null,
          testExitCode: null,
          usedPlan: plan,
          notes: [...notes, "missing dockerfile path"],
        };
      }

      builderName = await createEphemeralDockerBuilder();
      monitor.onStage?.("Building Docker image");
      const build = await buildDirectDockerImage(snapshot, dockerfilePath, imageTag, builderName, monitor, buildStdoutPath, buildStderrPath);
      buildExitCode = build.buildExitCode;
      buildPassed = build.buildPassed;
      builtImageId = build.builtImageId;
      notes.push(...build.notes);
      testsPassed = buildPassed;
      testExitCode = null;
      if (buildPassed) {
        notes.push("build-only validation skipped in-container test execution");
      }
    } else if (plan.runner === "compose-run") {
      const composeFilePath = localPath(snapshot, plan.composeFilePath);
      if (!composeFilePath) {
        return {
          buildPassed: false,
          testsPassed: false,
          buildExitCode: null,
          testExitCode: null,
          usedPlan: plan,
          notes: [...notes, "missing compose file path"],
        };
      }
      const composeBuildServices = plan.composeBuildServices?.filter(Boolean)
        ?? detectComposeBuild(snapshot, plan.composeFilePath)?.buildServices
        ?? [];
      if (composeBuildServices.length === 0) {
        return {
          buildPassed: false,
          testsPassed: false,
          buildExitCode: null,
          testExitCode: null,
          usedPlan: plan,
          notes: [...notes, "compose file has no buildable services"],
        };
      }
      const cwd = snapshot.rootDir;
      builderName = await createEphemeralDockerBuilder();
      monitor.onStage?.("Building Docker Compose services");
      const build = await runCommand({
        cmd: "docker",
        args: ["compose", "-f", plan.composeFilePath ?? "docker-compose.yml", "build", "--builder", builderName, ...composeBuildServices],
        cwd,
        timeoutMs: monitor.buildTimeoutMs,
        signal: monitor.signal,
        stdoutPath: buildStdoutPath,
        stderrPath: buildStderrPath,
        onStdoutChunk: (chunk) => monitor.onOutput?.("build", "stdout", chunk),
        onStderrChunk: (chunk) => monitor.onOutput?.("build", "stderr", chunk),
      });
      buildExitCode = build.code;
      buildPassed = build.code === 0;
      if (build.timedOut && monitor.buildTimeoutMs) {
        notes.push(`docker compose build timed out after ${formatTimeoutMs(monitor.buildTimeoutMs)}`);
      }
      notes.push(`compose build services: ${composeBuildServices.join(", ")}`);
      testsPassed = buildPassed;
      testExitCode = null;
      if (buildPassed) {
        notes.push("build-only validation skipped docker compose test execution");
      }
    }

    return {
      buildPassed,
      testsPassed,
      buildExitCode,
      testExitCode,
      buildStdoutPath,
      buildStderrPath,
      testStdoutPath,
      testStderrPath,
      imageTag,
      builtImageId,
      usedPlan: plan,
      notes,
    };
  } finally {
    if (plan.runner === "compose-run") {
      const composeFile = plan.composeFilePath ?? "docker-compose.yml";
      await runCommand({
        cmd: "docker",
        args: ["compose", "-f", composeFile, "down", "--rmi", "local", "--remove-orphans"],
        cwd: snapshot.rootDir,
      }).catch(() => {});
    } else {
      await cleanupTemporaryDockerImage(imageTag).catch(() => {});
    }
    await cleanupEphemeralDockerBuilder(builderName).catch(() => {});
  }
}

export async function executeTestPlanWithTests(
  config: Config,
  snapshot: RepoSnapshot,
  plan: TestPlan,
  monitor: ExecutionMonitor = {},
): Promise<ExecutionResult> {
  const logDir = join(config.outputRoot, "logs", sanitizeTag(`${snapshot.fullName}-${snapshot.sha.slice(0, 12)}-tests`));
  ensureDir(logDir);

  const notes = [`plan: ${describePlan(plan)}`];
  const imageTag = sanitizeTag(`${snapshot.owner}-${snapshot.repo}-${snapshot.sha.slice(0, 12)}-tests`);
  const dockerfilePath = localPath(snapshot, plan.dockerfilePath);
  const buildStdoutPath = join(logDir, "build.stdout.log");
  const buildStderrPath = join(logDir, "build.stderr.log");
  const testStdoutPath = join(logDir, "test.stdout.log");
  const testStderrPath = join(logDir, "test.stderr.log");
  let builderName: string | undefined;

  let buildPassed = false;
  let testsPassed = false;
  let buildExitCode: number | null = null;
  let testExitCode: number | null = null;
  let builtImageId: string | undefined;

  try {
    if (plan.runner === "none") {
      return {
        buildPassed: false,
        testsPassed: false,
        buildExitCode: null,
        testExitCode: null,
        usedPlan: plan,
        notes: [...notes, "no Docker build plan could be inferred"],
      };
    }

    if (plan.runner === "compose-run") {
      return {
        buildPassed: false,
        testsPassed: false,
        buildExitCode: null,
        testExitCode: null,
        usedPlan: plan,
        notes: [...notes, "running tests inside Docker requires a direct Dockerfile build; convert the plan to docker-run first"],
      };
    }

    if (!dockerfilePath) {
      return {
        buildPassed: false,
        testsPassed: false,
        buildExitCode: null,
        testExitCode: null,
        usedPlan: plan,
        notes: [...notes, "missing dockerfile path"],
      };
    }

    builderName = await createEphemeralDockerBuilder();
    monitor.onStage?.("Building Docker image");
    const build = await buildDirectDockerImage(snapshot, dockerfilePath, imageTag, builderName, monitor, buildStdoutPath, buildStderrPath);
    buildPassed = build.buildPassed;
    buildExitCode = build.buildExitCode;
    builtImageId = build.builtImageId;
    notes.push(...build.notes);

    if (plan.runner === "docker-target" && plan.dockerTarget) {
      notes.push(`ignored docker target '${plan.dockerTarget}' during manual test execution`);
    }

    if (buildPassed) {
      const testRun = await runTestsInDockerImage(imageTag, plan, monitor, testStdoutPath, testStderrPath);
      testsPassed = testRun.testsPassed;
      testExitCode = testRun.testExitCode;
      notes.push(...testRun.notes);
    } else {
      testsPassed = false;
      testExitCode = null;
    }

    return {
      buildPassed,
      testsPassed,
      buildExitCode,
      testExitCode,
      buildStdoutPath,
      buildStderrPath,
      testStdoutPath,
      testStderrPath,
      imageTag,
      builtImageId,
      usedPlan: plan,
      notes,
    };
  } finally {
    await cleanupTemporaryDockerImage(imageTag).catch(() => {});
    await cleanupEphemeralDockerBuilder(builderName).catch(() => {});
  }
}
