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
  "README changes must explain native installation and test instructions, not Docker-only usage.",
  "Pin dependency versions using the repository's existing dependency artifacts and remove lock files instead of introducing a new file structure.",
  "Keep the project structure intact and make the smallest setup-focused changes that work.",
  "Build the project and run tests successfully before finishing when the repository allows it.",
  "If Docker access is available, actually run the Docker build and test commands during setup instead of only suggesting them.",
  "Do not create commits yourself. The platform will configure git author details and create the setup commit after validation.",
].join("\n");

const PYTHON_PROMPT = `${COMMON_SETUP_RULES}

Prepare this Python repository for later issue work:
- Carefully scan the repository for dependency files, test configuration, and existing setup instructions.
- Prefer editing existing files such as requirements files, constraints files, setup.py, setup.cfg, pyproject.toml, Pipfile, tox.ini, noxfile.py, pytest.ini, and README files.
- If the repository already has a Dockerfile at the root, improve it only as needed. Otherwise create a simple working root-level Dockerfile.
- Avoid listing project dependencies directly inside the Dockerfile. Install from the repository's dependency files instead.
- Freeze and pin dependencies everywhere they are defined, and remove Python lock files that are present.
- Update the README with native installation and test steps for humans. Do not tell the reader to git clone the repository and do not make Docker the primary workflow.
- In your final summary, include:
  1. The Docker build and run command in the form: docker build -t <name>-test . && docker run --rm <name>-test
  2. The equivalent command for: docker run --rm <name>-test python -m pip freeze --all
  3. Which dependency files you pinned
  4. Whether Docker build and tests passed`;

const PYTHON_VALIDATION_PROMPT = [
  "Validate the setup by building the root Dockerfile, running the inferred Python test command inside the container, confirming the README's native install/test instructions match the repository, and confirming dependency versions are pinned consistently across the existing Python dependency files.",
  "Do not use Docker Compose.",
  "Actually execute the Docker build and test commands when Docker access is available.",
  "Report the exact docker build/run commands used, the equivalent pip-freeze command, whether tests passed, and any remaining setup blockers.",
].join("\n");

const JAVASCRIPT_PROMPT = `${COMMON_SETUP_RULES}

Prepare this JavaScript repository for later issue work:
- Carefully scan the repository for package manager files, workspaces, build scripts, test scripts, and existing setup instructions.
- Prefer editing existing files such as package.json, lock files, workspace config files, test config files, Makefile, and README files.
- If the repository already has a Dockerfile at the root, improve it only as needed. Otherwise create a simple working root-level Dockerfile.
- Install dependencies through the repository's package manager files rather than hardcoding package lists inside the Dockerfile.
- Pin dependency versions in the existing JavaScript dependency files and remove lock files that are present.
- Update the README with native install and test steps for humans. Do not tell the reader to git clone the repository and do not make Docker the primary workflow.
- In your final summary, include:
  1. The Docker build and run command in the form: docker build -t <name>-test . && docker run --rm <name>-test
  2. An equivalent dependency-inspection command for this stack
  3. Which dependency files you pinned and which lock files you removed
  4. Whether Docker build and tests passed`;

const JAVASCRIPT_VALIDATION_PROMPT = [
  "Validate the setup by building the root Dockerfile, running the repository's inferred JavaScript test command inside the container, confirming the README's native install/test instructions match the repository, and confirming dependency versions are pinned in the existing project artifacts after lock-file removal.",
  "Do not use Docker Compose.",
  "Actually execute the Docker build and test commands when Docker access is available.",
  "Report the exact docker build/run commands used, the dependency-inspection command you chose, whether tests passed, and any remaining setup blockers.",
].join("\n");

const TYPESCRIPT_PROMPT = `${COMMON_SETUP_RULES}

Prepare this TypeScript repository for later issue work:
- Carefully scan the repository for package manager files, tsconfig files, build scripts, test scripts, typecheck commands, and existing setup instructions.
- Prefer editing existing files such as package.json, tsconfig files, lock files, workspace config files, test config files, Makefile, and README files.
- If the repository already has a Dockerfile at the root, improve it only as needed. Otherwise create a simple working root-level Dockerfile.
- Install dependencies through the repository's package manager files rather than hardcoding package lists inside the Dockerfile.
- Pin dependency versions in the existing TypeScript dependency files and remove lock files that are present.
- Update the README with native install, typecheck, and test steps for humans. Do not tell the reader to git clone the repository and do not make Docker the primary workflow.
- In your final summary, include:
  1. The Docker build and run command in the form: docker build -t <name>-test . && docker run --rm <name>-test
  2. An equivalent dependency-inspection command for this stack
  3. Which dependency files you pinned and which lock files you removed
  4. Whether Docker build, tests, and type checks passed`;

const TYPESCRIPT_VALIDATION_PROMPT = [
  "Validate the setup by building the root Dockerfile, running the repository's inferred TypeScript test command and typecheck command inside the container when available, confirming the README's native install/typecheck/test instructions match the repository, and confirming dependency versions are pinned in the existing project artifacts after lock-file removal.",
  "Do not use Docker Compose.",
  "Actually execute the Docker build and test commands when Docker access is available.",
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
