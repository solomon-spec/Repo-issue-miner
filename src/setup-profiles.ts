import type { SetupProfile } from "./types.js";

type SetupProfileSeed = Pick<
  SetupProfile,
  "name" | "prompt" | "contextPaths" | "writablePaths" | "validationPrompt" | "cloneRootPath" | "model" | "sandboxMode"
>;

const COMMON_SETUP_RULES = [
  "This is the repository setup phase only. Do not implement the issue itself.",
  "Do not modify application or source code files.",
  "Do not create new files other than a root-level Dockerfile when one is needed.",
  "Do not create, edit, or rely on Docker Compose.",
  "README changes must only explain how to build and run the Docker image and how to run the repository tests from that Docker-based workflow.",
  "Do not add dependency-installation instructions, native setup instructions, or dependency-pinning notes to the README.",
  "Pin dependency versions only in the repository's existing dependency artifacts instead of introducing a new dependency-file structure.",
  "If lock files already exist, use them only as reference material while scanning, then remove them before finishing.",
  "Do not recreate deleted lock files.",
  "Keep the project structure intact and make the smallest setup-focused changes that work.",
  "Prefer cache-friendly Dockerfile updates: copy dependency manifests before large source trees when the repository layout allows it, and avoid invalidating dependency-install layers unnecessarily.",
  "Build the project and run tests successfully before finishing when the repository allows it.",
  "If Docker access is available, actually run the Docker build and test commands during setup instead of only suggesting them.",
  "If setup cannot be completed without changing source code or other out-of-scope files, stop early and report that with SKIP_SETUP.",
  "Do not create commits yourself. The platform will configure git author details and create the setup commit after validation.",
].join("\n");

const PYTHON_PROMPT = `${COMMON_SETUP_RULES}

Prepare this Python repository for later issue work:
1. Scan the repository for Python dependency files, test configuration, README guidance, and any existing root Dockerfile before deciding what to edit.
2. Create or update only the root Dockerfile and existing requirements-related files so the repository can be built and its tests can run from Docker. Avoid listing project dependencies directly inside the Dockerfile.
3. Run the Docker build and Docker test workflow with one stable image tag. Reuse that image for follow-up checks, and do not repeat a full rebuild unless a setup-file change requires it.
4. Run the container-based command equivalent to \`docker run --rm <name>-test python -m pip freeze --all\`, then freeze and pin dependency versions everywhere they are already defined. Avoid mass-pinning speculative transitive packages that are not declared in the repository.
5. Update the README so it only explains:
   - how to build the Docker image
   - how to run the Docker image
   - how to run the repository tests from that Docker workflow
6. Re-run the Docker build and Docker test workflow to confirm the final setup state.
7. If any required step cannot succeed without changing source code or other out-of-scope files, stop early and begin the final summary with \`SKIP_SETUP: <short reason>\`.

In your final summary, include:
1. The Docker build and run command in the form: docker build -t <name>-test . && docker run --rm <name>-test
2. The equivalent command for: docker run --rm <name>-test python -m pip freeze --all
3. Which dependency files you pinned
4. Which lock files were removed
5. Whether Docker build and tests passed`;

const PYTHON_VALIDATION_PROMPT = [
  "Validate the setup by building the root Dockerfile once, running the inferred Python test command inside the container, confirming the README only documents Docker build/run/test usage, and confirming dependency versions are pinned consistently across the existing Python dependency files after lock-file removal.",
  "Do not use Docker Compose.",
  "Actually execute the Docker build and test commands when Docker access is available.",
  "Reuse the built image for follow-up docker run checks such as dependency inspection, and only rebuild if you changed a setup file after the last build.",
  "If setup is blocked by out-of-scope changes, stop and report SKIP_SETUP with the concrete blocker instead of trying speculative source-code fixes.",
  "Report the exact docker build/run commands used, the equivalent pip-freeze command, whether tests passed, and any remaining setup blockers.",
].join("\n");

const JAVASCRIPT_PROMPT = `${COMMON_SETUP_RULES}

Prepare this JavaScript repository for later issue work:
1. Scan the repository for package-manager files, lock files, workspaces, build scripts, test scripts, README guidance, and any existing root Dockerfile before deciding what to edit.
2. Create or update only the root Dockerfile and the existing JavaScript dependency files needed for Docker-based setup. Install through the repository's package-manager files instead of hardcoding package lists inside the Dockerfile.
3. Run the Docker build and Docker test workflow with one stable image tag. Reuse that image for follow-up checks, and do not repeat a full rebuild unless a setup-file change requires it.
4. Run the container-based dependency-inspection command for this stack, then pin dependency versions only in the existing JavaScript dependency files. Avoid broad version churn in unrelated packages.
5. Update the README so it only explains:
   - how to build the Docker image
   - how to run the Docker image
   - how to run the repository tests from that Docker workflow
6. Re-run the Docker build and Docker test workflow to confirm the final setup state.
7. If any required step cannot succeed without changing source code or other out-of-scope files, stop early and begin the final summary with \`SKIP_SETUP: <short reason>\`.

In your final summary, include:
1. The Docker build and run command in the form: docker build -t <name>-test . && docker run --rm <name>-test
2. An equivalent dependency-inspection command for this stack
3. Which dependency files you pinned and which lock files you removed
4. Whether Docker build and tests passed`;

const JAVASCRIPT_VALIDATION_PROMPT = [
  "Validate the setup by building the root Dockerfile once, running the repository's inferred JavaScript test command inside the container, confirming the README only documents Docker build/run/test usage, and confirming dependency versions are pinned in the existing project artifacts after lock-file removal.",
  "Do not use Docker Compose.",
  "Actually execute the Docker build and test commands when Docker access is available.",
  "Reuse the built image for follow-up docker run checks such as dependency inspection, and only rebuild if you changed a setup file after the last build.",
  "If setup is blocked by out-of-scope changes, stop and report SKIP_SETUP with the concrete blocker instead of trying speculative source-code fixes.",
  "Report the exact docker build/run commands used, the dependency-inspection command you chose, whether tests passed, and any remaining setup blockers.",
].join("\n");

const TYPESCRIPT_PROMPT = `${COMMON_SETUP_RULES}

Prepare this TypeScript repository for later issue work:
1. Scan the repository for package-manager files, lock files, tsconfig files, build scripts, test scripts, typecheck commands, README guidance, and any existing root Dockerfile before deciding what to edit.
2. Create or update only the root Dockerfile and the existing TypeScript dependency files needed for Docker-based setup. Install through the repository's package-manager files instead of hardcoding package lists inside the Dockerfile.
3. Run the Docker build plus Docker test workflow with one stable image tag. Run the inferred typecheck command inside the container when available, and do not repeat a full rebuild unless a setup-file change requires it.
4. Run the container-based dependency-inspection command for this stack, then pin dependency versions only in the existing TypeScript dependency files. Avoid broad version churn in unrelated packages.
5. Update the README so it only explains:
   - how to build the Docker image
   - how to run the Docker image
   - how to run the repository tests from that Docker workflow
6. Re-run the Docker build plus Docker test workflow to confirm the final setup state.
7. If any required step cannot succeed without changing source code or other out-of-scope files, stop early and begin the final summary with \`SKIP_SETUP: <short reason>\`.

In your final summary, include:
1. The Docker build and run command in the form: docker build -t <name>-test . && docker run --rm <name>-test
2. An equivalent dependency-inspection command for this stack
3. Which dependency files you pinned and which lock files you removed
4. Whether Docker build, tests, and type checks passed`;

const TYPESCRIPT_VALIDATION_PROMPT = [
  "Validate the setup by building the root Dockerfile once, running the repository's inferred TypeScript test command and typecheck command inside the container when available, confirming the README only documents Docker build/run/test usage, and confirming dependency versions are pinned in the existing project artifacts after lock-file removal.",
  "Do not use Docker Compose.",
  "Actually execute the Docker build and test commands when Docker access is available.",
  "Reuse the built image for follow-up docker run checks such as dependency inspection, and only rebuild if you changed a setup file after the last build.",
  "If setup is blocked by out-of-scope changes, stop and report SKIP_SETUP with the concrete blocker instead of trying speculative source-code fixes.",
  "Report the exact docker build/run commands used, the dependency-inspection command you chose, whether checks passed, and any remaining setup blockers.",
].join("\n");

const PYTHON_CONTEXT_PATHS = [
  "README*",
  "Dockerfile",
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "requirements*.txt",
  "constraints*.txt",
  "Pipfile",
  "Pipfile.lock",
  "poetry.lock",
  "uv.lock",
  "pdm.lock",
  "tox.ini",
  "noxfile.py",
  "pytest.ini",
  "Makefile",
];

const PYTHON_WRITABLE_PATHS = [
  "Dockerfile",
  "README*",
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "requirements*.txt",
  "constraints*.txt",
  "Pipfile",
  "Pipfile.lock",
  "poetry.lock",
  "uv.lock",
  "pdm.lock",
  "tox.ini",
  "noxfile.py",
  "pytest.ini",
  "Makefile",
  "**/*.lock",
];

const JAVASCRIPT_CONTEXT_PATHS = [
  "README*",
  "Dockerfile",
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "turbo.json",
  "nx.json",
  "vite.config.*",
  "vitest.config.*",
  "jest.config.*",
  "webpack.config.*",
  "rollup.config.*",
  "Makefile",
];

const JAVASCRIPT_WRITABLE_PATHS = [
  "Dockerfile",
  "README*",
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "turbo.json",
  "nx.json",
  "vite.config.*",
  "vitest.config.*",
  "jest.config.*",
  "webpack.config.*",
  "rollup.config.*",
  "Makefile",
  "**/*.lock",
];

const TYPESCRIPT_CONTEXT_PATHS = [
  ...JAVASCRIPT_CONTEXT_PATHS,
  "tsconfig.json",
  "tsconfig.*.json",
];

const TYPESCRIPT_WRITABLE_PATHS = [
  ...JAVASCRIPT_WRITABLE_PATHS,
  "tsconfig.json",
  "tsconfig.*.json",
];

export const DEFAULT_SETUP_PROFILE_NAMES = {
  python: "Python Initial Setup",
  javascript: "JavaScript Initial Setup",
  typescript: "TypeScript Initial Setup",
} as const;

export function buildDefaultSetupProfiles(cloneRootPath: string): SetupProfileSeed[] {
  return [
    {
      name: DEFAULT_SETUP_PROFILE_NAMES.python,
      prompt: PYTHON_PROMPT,
      contextPaths: PYTHON_CONTEXT_PATHS,
      writablePaths: PYTHON_WRITABLE_PATHS,
      validationPrompt: PYTHON_VALIDATION_PROMPT,
      cloneRootPath,
      model: undefined,
      sandboxMode: "danger-full-access",
    },
    {
      name: DEFAULT_SETUP_PROFILE_NAMES.javascript,
      prompt: JAVASCRIPT_PROMPT,
      contextPaths: JAVASCRIPT_CONTEXT_PATHS,
      writablePaths: JAVASCRIPT_WRITABLE_PATHS,
      validationPrompt: JAVASCRIPT_VALIDATION_PROMPT,
      cloneRootPath,
      model: undefined,
      sandboxMode: "danger-full-access",
    },
    {
      name: DEFAULT_SETUP_PROFILE_NAMES.typescript,
      prompt: TYPESCRIPT_PROMPT,
      contextPaths: TYPESCRIPT_CONTEXT_PATHS,
      writablePaths: TYPESCRIPT_WRITABLE_PATHS,
      validationPrompt: TYPESCRIPT_VALIDATION_PROMPT,
      cloneRootPath,
      model: undefined,
      sandboxMode: "danger-full-access",
    },
  ];
}

function normalizeLanguage(value: string | undefined): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function inferSetupProfileLanguage(language: string | undefined): keyof typeof DEFAULT_SETUP_PROFILE_NAMES | undefined {
  const normalized = normalizeLanguage(language);
  if (!normalized) return undefined;
  if (normalized.includes("typescript")) return "typescript";
  if (normalized.includes("javascript")) return "javascript";
  if (normalized.includes("python")) return "python";
  return undefined;
}

export function pickPreferredSetupProfile<T extends { name: string }>(
  profiles: T[],
  language: string | undefined,
): T | undefined {
  const inferred = inferSetupProfileLanguage(language);
  if (inferred) {
    const preferred = profiles.find((profile) => profile.name === DEFAULT_SETUP_PROFILE_NAMES[inferred]);
    if (preferred) {
      return preferred;
    }
  }
  return profiles.find((profile) => profile.name === DEFAULT_SETUP_PROFILE_NAMES.python) ?? profiles[0];
}
