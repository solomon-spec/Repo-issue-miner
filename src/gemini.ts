import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  Config,
  GeminiAcceptedPrReview,
  GeminiIssueAcceptanceReview,
  RepoSnapshot,
  TestPlan,
} from "./types.js";
import { fileExists, readUtf8Safe, stripMarkdownFence, withTimeoutSignal } from "./util.js";

const SAFE_COMMANDS = new Set([
  "pytest",
  "python",
  "tox",
  "nox",
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "jest",
  "vitest",
  "mocha",
  "node",
  "make",
]);

const CANDIDATE_FILES = [
  "README.md",
  "README.rst",
  "README.txt",
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "requirements-dev.txt",
  "requirements-test.txt",
  "tox.ini",
  "noxfile.py",
  "pytest.ini",
  "Makefile",
  ".github/workflows/ci.yml",
  ".github/workflows/ci.yaml",
  ".github/workflows/test.yml",
  ".github/workflows/tests.yml",
];

export interface DockerfileSuggestion {
  dockerfileContent: string;
  reasoningSummary: string;
}

export interface GeminiAcceptedPrReviewInput {
  repoFullName: string;
  pullRequest: {
    number?: number;
    title?: string;
    body?: string;
    mergedAt?: string | null;
    changedFilesCount?: number;
  };
  relevantSourceFilesCount?: number;
  relevantTestFilesCount?: number;
  relevantCodeLinesChanged?: number;
  issues: Array<{
    owner: string;
    repo: string;
    number: number;
    title?: string;
    body?: string;
    state?: string;
  }>;
}

function clampText(value: string, maxBytes = 24_000): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) return value;
  return buffer.subarray(0, maxBytes).toString("utf8");
}

function parsePackageTestCommand(packageJsonRaw: string | undefined): string[] | undefined {
  if (!packageJsonRaw) return undefined;
  try {
    const parsed = JSON.parse(packageJsonRaw) as {
      packageManager?: string;
      scripts?: Record<string, string>;
    };
    const manager = parsed.packageManager?.startsWith("pnpm")
      ? "pnpm"
      : parsed.packageManager?.startsWith("yarn")
        ? "yarn"
        : parsed.packageManager?.startsWith("bun")
          ? "bun"
          : "npm";
    const script = parsed.scripts?.test;
    if (!script || /no test specified/i.test(script)) return undefined;
    return [manager, "test"];
  } catch {
    return undefined;
  }
}

function parsePythonTestCommand(snapshot: RepoSnapshot): string[] | undefined {
  if (snapshot.files.includes("tox.ini")) return ["tox", "-q"];
  if (snapshot.files.includes("noxfile.py")) return ["nox"];
  if (snapshot.files.includes("pytest.ini") || snapshot.files.some((file) => file.startsWith("tests/") || /test_.*\.py$/.test(file))) {
    return ["pytest", "-q"];
  }
  return undefined;
}

function detectDockerfile(snapshot: RepoSnapshot, preferredDockerfilePath?: string): string | undefined {
  if (preferredDockerfilePath && fileExists(join(snapshot.rootDir, preferredDockerfilePath))) {
    return preferredDockerfilePath;
  }
  const rootDocker = snapshot.files.find((file) => file === "Dockerfile");
  if (rootDocker) return rootDocker;
  const other = snapshot.files.find((file) => /(^|\/)Dockerfile(\.[^/]+)?$/i.test(file) && !file.startsWith("docs/") && !file.startsWith("examples/"));
  return other;
}

function detectCompose(snapshot: RepoSnapshot): string | undefined {
  return snapshot.files.find((file) => ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"].includes(file));
}

function indentWidth(line: string): number {
  return line.match(/^\s*/)?.[0].length ?? 0;
}

function parseComposeBuildServices(raw: string): string[] {
  const services: string[] = [];
  const lines = raw.split(/\r?\n/);
  let inServices = false;
  let servicesIndent = -1;
  let serviceIndent = -1;
  let currentService: string | undefined;

  for (const originalLine of lines) {
    const line = originalLine.replace(/\t/g, "  ");
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const indent = indentWidth(line);
    if (!inServices) {
      if (/^services\s*:\s*$/.test(trimmed)) {
        inServices = true;
        servicesIndent = indent;
        serviceIndent = -1;
        currentService = undefined;
      }
      continue;
    }

    if (indent <= servicesIndent) {
      break;
    }

    const serviceMatch = trimmed.match(/^["']?([A-Za-z0-9._-]+)["']?\s*:\s*$/);
    if (serviceMatch && !trimmed.startsWith("-")) {
      if (serviceIndent < 0) {
        serviceIndent = indent;
      }
      if (indent === serviceIndent) {
        currentService = serviceMatch[1];
        continue;
      }
    }

    if (!currentService || serviceIndent < 0 || indent <= serviceIndent) {
      continue;
    }

    if (/^build\s*:/i.test(trimmed) && !services.includes(currentService)) {
      services.push(currentService);
    }
  }

  return services;
}

export function detectComposeBuild(snapshot: RepoSnapshot, preferredComposeFilePath?: string): { composeFilePath: string; buildServices: string[] } | undefined {
  const candidates = preferredComposeFilePath
    ? [preferredComposeFilePath]
    : ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];

  for (const composeFilePath of candidates) {
    const raw = readUtf8Safe(join(snapshot.rootDir, composeFilePath));
    if (!raw) continue;
    const buildServices = parseComposeBuildServices(raw);
    if (buildServices.length > 0) {
      return { composeFilePath, buildServices };
    }
  }

  return undefined;
}

function detectDockerTestTarget(dockerfileRaw: string | undefined): string | undefined {
  if (!dockerfileRaw) return undefined;
  const matches = [...dockerfileRaw.matchAll(/^FROM\s+.+?\s+AS\s+([A-Za-z0-9._-]+)$/gim)].map((match) => match[1]);
  return matches.find((name) => /^(test|tests|ci|unit-test|unit-tests)$/i.test(name));
}

function resolveDeterministicPlan(snapshot: RepoSnapshot, preferredDockerfilePath?: string): TestPlan | undefined {
  const packageJson = readUtf8Safe(join(snapshot.rootDir, "package.json"));
  const dockerfilePath = detectDockerfile(snapshot, preferredDockerfilePath);
  const composeBuild = detectComposeBuild(snapshot);
  const jsCommand = parsePackageTestCommand(packageJson);
  const pyCommand = parsePythonTestCommand(snapshot);
  const testCommand = jsCommand ?? pyCommand ?? (fileExists(join(snapshot.rootDir, "Makefile")) ? ["make", "test"] : []);
  if (composeBuild) {
    return {
      source: "deterministic",
      confidence: 0.65,
      runner: "compose-run",
      composeFilePath: composeBuild.composeFilePath,
      composeService: composeBuild.buildServices[0],
      composeBuildServices: composeBuild.buildServices,
      dockerfilePath,
      testCommand,
      reasoningSummary: `Using ${composeBuild.composeFilePath} services [${composeBuild.buildServices.join(", ")}] for build-only Docker validation`,
    };
  }
  if (!dockerfilePath) {
    return undefined;
  }
  return {
    source: "deterministic",
    confidence: 0.7,
    runner: "docker-run",
    dockerfilePath,
    testCommand,
    reasoningSummary: `Using ${dockerfilePath} for build-only Docker validation`,
  };
}

function isSafeCommand(command: string[]): boolean {
  if (command.length === 0) return true;
  return SAFE_COMMANDS.has(command[0]);
}

function collectContext(snapshot: RepoSnapshot, preferredDockerfilePath?: string): string {
  const snippets: string[] = [];
  const prioritized = preferredDockerfilePath ? [preferredDockerfilePath] : [];
  const orderedCandidateFiles = [...new Set([...prioritized, ...CANDIDATE_FILES])];
  for (const relPath of orderedCandidateFiles) {
    const fullPath = join(snapshot.rootDir, relPath);
    if (!fileExists(fullPath)) continue;
    const raw = clampText(readFileSync(fullPath, "utf8"));
    snippets.push(`FILE: ${relPath}\n${raw}`);
  }
  const nearby = snapshot.files.filter((file) => /(^|\/)(package\.json|pyproject\.toml|tox\.ini|noxfile\.py|pytest\.ini|dockerfile|compose\.ya?ml)$/i.test(file));
  for (const relPath of nearby) {
    const fullPath = join(snapshot.rootDir, relPath);
    if (!fileExists(fullPath) || CANDIDATE_FILES.includes(relPath)) continue;
    snippets.push(`FILE: ${relPath}\n${clampText(readFileSync(fullPath, "utf8"))}`);
  }
  return snippets.join("\n\n---\n\n");
}

async function inferWithGemini(config: Config, snapshot: RepoSnapshot, preferredDockerfilePath?: string): Promise<TestPlan | undefined> {
  if (!config.geminiApiKey) return undefined;
  const schema = {
    type: "object",
    properties: {
      runner: { type: "string", enum: ["docker-run", "compose-run", "docker-target", "none"] },
      dockerfilePath: { type: "string" },
      composeFilePath: { type: "string" },
      composeService: { type: "string" },
      composeBuildServices: { type: "array", items: { type: "string" } },
      dockerTarget: { type: "string" },
      workdir: { type: "string" },
      testCommand: { type: "array", items: { type: "string" } },
      reasoningSummary: { type: "string" },
      confidence: { type: "number" },
    },
    required: ["runner", "testCommand", "reasoningSummary", "confidence"],
  };

  const prompt = [
    "You are inferring a safe, reproducible Docker build validation plan for a GitHub repository snapshot.",
    "Return only JSON that matches the schema.",
    "Prefer the repository's declared test entrypoint, not a guessed shell script.",
    "Only emit tokenized commands, never shell strings.",
    "Valid command families are: pytest, python -m pytest, tox, nox, npm test, pnpm test, yarn test, bun test, jest, vitest, mocha, make test.",
    "If you cannot infer a safe plan, return runner='none' with an empty testCommand.",
    `Repository: ${snapshot.fullName}@${snapshot.sha}`,
    preferredDockerfilePath ? `If you choose a Docker-based runner, prefer this Dockerfile path: ${preferredDockerfilePath}` : "",
    "Context follows.",
    collectContext(snapshot, preferredDockerfilePath),
  ].join("\n\n");

  const parsed = await generateGeminiStructured<TestPlan>(config, prompt, schema);
  if (!parsed) return undefined;

  if (!isSafeCommand(parsed.testCommand) || parsed.runner === "none") return undefined;
  parsed.source = "gemini";
  if (parsed.dockerfilePath && !fileExists(join(snapshot.rootDir, parsed.dockerfilePath))) {
    return undefined;
  }
  if (parsed.composeFilePath && !fileExists(join(snapshot.rootDir, parsed.composeFilePath))) {
    return undefined;
  }
  if (parsed.workdir && parsed.workdir.startsWith("..")) {
    return undefined;
  }
  if (preferredDockerfilePath && fileExists(join(snapshot.rootDir, preferredDockerfilePath))) {
    parsed.dockerfilePath = preferredDockerfilePath;
  }
  return parsed;
}

async function generateGeminiStructured<T>(config: Config, prompt: string, schema: unknown): Promise<T | undefined> {
  if (!config.geminiApiKey) return undefined;
  const response = await fetch(`${config.geminiApiBase}/models/${encodeURIComponent(config.geminiModel)}:generateContent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": config.geminiApiKey,
    },
    signal: withTimeoutSignal(config.requestTimeoutMs),
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: schema,
        temperature: 0.1,
      },
    }),
  });

  if (!response.ok) {
    return undefined;
  }

  const payload = (await response.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
    }>;
  };
  const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
  if (!text) return undefined;

  try {
    return JSON.parse(stripMarkdownFence(text)) as T;
  } catch {
    return undefined;
  }
}

export async function analyzeAcceptedPullRequestWithGemini(
  config: Config,
  input: GeminiAcceptedPrReviewInput,
): Promise<GeminiAcceptedPrReview | undefined> {
  if (!config.geminiApiKey || !input.issues.length) {
    return undefined;
  }

  const schema = {
    type: "object",
    properties: {
      status: { type: "string", enum: ["accepted_by_gemini", "not_accepted_by_gemini", "mixed"] },
      summary: { type: "string" },
      issues: {
        type: "array",
        items: {
          type: "object",
          properties: {
            owner: { type: "string" },
            repo: { type: "string" },
            number: { type: "number" },
            issueKey: { type: "string" },
            title: { type: "string" },
            status: { type: "string", enum: ["accepted_by_gemini", "not_accepted_by_gemini"] },
            kind: { type: "string", enum: ["bug_fix", "feature", "too_trivial", "not_bug_or_feature", "unclear"] },
            reasoning: { type: "string" },
          },
          required: ["owner", "repo", "number", "issueKey", "status", "kind", "reasoning"],
        },
      },
    },
    required: ["status", "summary", "issues"],
  };

  const issueBlocks = input.issues.map((issue) => [
    `ISSUE: ${issue.owner}/${issue.repo}#${issue.number}`,
    issue.title ? `Title: ${issue.title}` : "",
    issue.state ? `State: ${issue.state}` : "",
    `Body:\n${clampText(issue.body || "No issue body provided.", 8_000)}`,
  ].filter(Boolean).join("\n")).join("\n\n---\n\n");

  const prompt = [
    "You are reviewing whether each linked issue in an accepted pull request is substantial enough to stay accepted.",
    "Classify each linked issue independently.",
    "Mark status='accepted_by_gemini' only when the issue clearly describes a real bug fix or a real feature and the work appears meaningfully complex or non-trivial.",
    "Mark status='not_accepted_by_gemini' when the issue is too trivial, mostly docs/chore/cleanup, unclear, or not really a bug fix / feature request.",
    "Use kind='bug_fix' or kind='feature' only for genuinely accepted issues. Use kind='too_trivial', 'not_bug_or_feature', or 'unclear' when rejecting.",
    "Return concise reasoning grounded in the issue text and PR context.",
    "Return only JSON that matches the schema.",
    "",
    `Repository: ${input.repoFullName}`,
    `Pull Request: #${input.pullRequest.number ?? "?"} ${input.pullRequest.title ?? ""}`.trim(),
    `Merged At: ${input.pullRequest.mergedAt ?? "unknown"}`,
    `Changed Files Count: ${input.pullRequest.changedFilesCount ?? "unknown"}`,
    `Relevant Source Files Changed: ${input.relevantSourceFilesCount ?? 0}`,
    `Relevant Test Files Changed: ${input.relevantTestFilesCount ?? 0}`,
    `Relevant Code Lines Changed: ${input.relevantCodeLinesChanged ?? 0}`,
    "",
    `PR Body:\n${clampText(input.pullRequest.body || "No pull request body provided.", 10_000)}`,
    "",
    "Linked issues follow.",
    issueBlocks,
  ].join("\n");

  const review = await generateGeminiStructured<Omit<GeminiAcceptedPrReview, "analyzedAt">>(config, prompt, schema);
  if (!review) {
    return undefined;
  }

  const fallbackIssues = new Map<string, GeminiIssueAcceptanceReview>();
  for (const issue of input.issues) {
    const issueKey = `${issue.owner}/${issue.repo}#${issue.number}`;
    fallbackIssues.set(issueKey, {
      owner: issue.owner,
      repo: issue.repo,
      number: issue.number,
      issueKey,
      title: issue.title,
      status: "not_accepted_by_gemini",
      kind: "unclear",
      reasoning: "Gemini did not return a review for this linked issue.",
    });
  }

  const issues = Array.isArray(review.issues)
    ? review.issues.map((issue) => ({
      ...fallbackIssues.get(issue.issueKey),
      ...issue,
    }))
    : [];
  const mergedIssues = input.issues.map((issue) => {
    const issueKey = `${issue.owner}/${issue.repo}#${issue.number}`;
    const fallback = fallbackIssues.get(issueKey);
    const parsed = issues.find((item) => item.issueKey === issueKey);
    return {
      owner: issue.owner,
      repo: issue.repo,
      number: issue.number,
      issueKey,
      title: issue.title,
      status: parsed?.status ?? fallback?.status ?? "not_accepted_by_gemini",
      kind: parsed?.kind ?? fallback?.kind ?? "unclear",
      reasoning: parsed?.reasoning ?? fallback?.reasoning ?? "Gemini did not return a review for this linked issue.",
    } satisfies GeminiIssueAcceptanceReview;
  });

  return {
    status: review.status,
    summary: review.summary,
    analyzedAt: new Date().toISOString(),
    issues: mergedIssues,
  };
}

export async function resolveTestPlan(config: Config, snapshot: RepoSnapshot, preferredDockerfilePath?: string): Promise<TestPlan | undefined> {
  const deterministic = resolveDeterministicPlan(snapshot, preferredDockerfilePath);
  if (deterministic) {
    return deterministic;
  }
  return await inferWithGemini(config, snapshot, preferredDockerfilePath);
}

export function localPath(snapshot: RepoSnapshot, relPath?: string): string | undefined {
  if (!relPath) return undefined;
  const fullPath = join(snapshot.rootDir, relPath);
  return fileExists(fullPath) ? fullPath : undefined;
}

export function relativeWorkdir(snapshot: RepoSnapshot, workdir?: string): string {
  if (!workdir || workdir === ".") return snapshot.rootDir;
  return join(snapshot.rootDir, workdir);
}

export async function generateDockerfileForTests(
  config: Config,
  snapshot: RepoSnapshot,
  plan: TestPlan,
  dockerfilePath: string,
): Promise<DockerfileSuggestion | undefined> {
  const dockerfileRaw = readUtf8Safe(join(snapshot.rootDir, dockerfilePath));
  if (!dockerfileRaw || !config.geminiApiKey || !plan.testCommand.length) {
    return undefined;
  }

  const schema = {
    type: "object",
    properties: {
      dockerfileContent: { type: "string" },
      reasoningSummary: { type: "string" },
    },
    required: ["dockerfileContent", "reasoningSummary"],
  };

  const prompt = [
    "You are editing exactly one file: a Dockerfile in a GitHub repository snapshot.",
    "Return only JSON matching the schema.",
    "Produce the full replacement Dockerfile content.",
    "You may only change Dockerfile content. Do not assume any other repository file can be edited.",
    "Goal: make the repository build successfully and make this exact test command runnable inside the built container.",
    `Repository: ${snapshot.fullName}@${snapshot.sha}`,
    `Dockerfile path: ${dockerfilePath}`,
    `Required test command: ${plan.testCommand.join(" ")}`,
    "The image will be built with docker buildx build --progress=plain --load -t <tag> -f <dockerfile> <repo-root>.",
    "After the build, tests will be executed with docker run --rm --entrypoint <first-command-token> <image> <remaining-command-tokens>.",
    "Keep changes as small and safe as possible.",
    "Do not bake test execution into RUN layers.",
    "Avoid CMD or ENTRYPOINT behavior that would prevent overriding the command for test execution.",
    "Prefer preserving the original base image and structure unless they directly block test execution.",
    "Context follows.",
    collectContext(snapshot, dockerfilePath),
  ].join("\n\n");

  return await generateGeminiStructured<DockerfileSuggestion>(config, prompt, schema);
}

export async function fixDockerfileForTestFailure(
  config: Config,
  snapshot: RepoSnapshot,
  plan: TestPlan,
  dockerfilePath: string,
  currentDockerfileContent: string,
  failureOutput: string,
): Promise<DockerfileSuggestion | undefined> {
  if (!config.geminiApiKey || !plan.testCommand.length || !currentDockerfileContent.trim() || !failureOutput.trim()) {
    return undefined;
  }

  const schema = {
    type: "object",
    properties: {
      dockerfileContent: { type: "string" },
      reasoningSummary: { type: "string" },
    },
    required: ["dockerfileContent", "reasoningSummary"],
  };

  const prompt = [
    "You are fixing exactly one file: a Dockerfile in a GitHub repository snapshot.",
    "Return only JSON matching the schema.",
    "Produce the full replacement Dockerfile content.",
    "You may only change Dockerfile content. Do not assume any other repository file can be edited.",
    "Goal: make the repository build successfully and make this exact test command runnable inside the built container.",
    `Repository: ${snapshot.fullName}@${snapshot.sha}`,
    `Dockerfile path: ${dockerfilePath}`,
    `Required test command: ${plan.testCommand.join(" ")}`,
    "The image is built with docker buildx build --progress=plain --load -t <tag> -f <dockerfile> <repo-root>.",
    "After the build, tests are executed with docker run --rm --entrypoint <first-command-token> <image> <remaining-command-tokens>.",
    "Use the failure output to adjust only the Dockerfile.",
    "Keep changes as small and safe as possible.",
    "Context follows.",
    collectContext(snapshot, dockerfilePath),
    "CURRENT DOCKERFILE:",
    clampText(currentDockerfileContent, 24_000),
    "FAILURE OUTPUT:",
    clampText(failureOutput, 20_000),
  ].join("\n\n");

  return await generateGeminiStructured<DockerfileSuggestion>(config, prompt, schema);
}

export function describePlan(plan: TestPlan): string {
  const bits: string[] = [plan.runner];
  if (plan.dockerfilePath) bits.push(`dockerfile=${plan.dockerfilePath}`);
  if (plan.composeFilePath) bits.push(`compose=${plan.composeFilePath}`);
  if (plan.composeBuildServices?.length) bits.push(`services=${plan.composeBuildServices.join(",")}`);
  if (plan.dockerTarget) bits.push(`target=${plan.dockerTarget}`);
  if (plan.testCommand.length) bits.push(`cmd=${plan.testCommand.join(" ")}`);
  return bits.join(" | ");
}
