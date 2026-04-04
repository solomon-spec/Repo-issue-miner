import { existsSync, rmSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { Config, RepoSnapshot, SearchRepo } from "./types.js";
import { ensureDir, runCommand } from "./util.js";

const MIRROR_DIRNAME = "_repo_mirrors";

function listFilesRecursive(rootDir: string, current = ""): string[] {
  const dir = current ? join(rootDir, current) : rootDir;
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if ([".git", "node_modules", ".venv", "venv", "dist", "build", "coverage"].includes(entry.name)) {
      continue;
    }
    const rel = current ? `${current}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(rootDir, rel));
    } else if (entry.isFile()) {
      files.push(rel);
    }
  }
  return files;
}

function directorySize(rootDir: string): number {
  let total = 0;
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        total += statSync(full).size;
      }
    }
  };
  walk(rootDir);
  return total;
}

function mirrorPathForRepo(config: Config, repo: SearchRepo): string {
  return resolve(config.workRoot, MIRROR_DIRNAME, `${repo.owner}__${repo.name}.git`);
}

async function ensureRepoMirror(
  config: Config,
  repo: SearchRepo,
  mirrorDir: string,
  signal?: AbortSignal,
): Promise<void> {
  ensureDir(resolve(config.workRoot, MIRROR_DIRNAME));

  if (!existsSync(mirrorDir)) {
    const clone = await runCommand({
      cmd: "git",
      args: ["clone", "--mirror", `https://github.com/${repo.fullName}.git`, mirrorDir],
      timeoutMs: config.buildTimeoutMs,
      signal,
    });
    if (clone.code !== 0) {
      throw new Error(`git mirror clone failed for ${repo.fullName}: ${clone.stderr || clone.stdout}`);
    }
    return;
  }

  const update = await runCommand({
    cmd: "git",
    args: ["remote", "update", "--prune", "origin"],
    cwd: mirrorDir,
    timeoutMs: config.buildTimeoutMs,
    signal,
  });
  if (update.code !== 0) {
    throw new Error(`git mirror update failed for ${repo.fullName}: ${update.stderr || update.stdout}`);
  }
}

export async function prepareSnapshot(
  config: Config,
  repo: SearchRepo,
  sha: string,
  options: { signal?: AbortSignal } = {},
): Promise<RepoSnapshot> {
  const targetDir = resolve(config.workRoot, `${repo.owner}__${repo.name}__${sha.slice(0, 12)}`);
  const mirrorDir = mirrorPathForRepo(config, repo);
  rmSync(targetDir, { recursive: true, force: true });
  ensureDir(config.workRoot);
  try {
    await ensureRepoMirror(config, repo, mirrorDir, options.signal);

    const clone = await runCommand({
      cmd: "git",
      args: ["clone", "--shared", "--no-checkout", mirrorDir, targetDir],
      timeoutMs: config.buildTimeoutMs,
      signal: options.signal,
    });
    if (clone.code !== 0) {
      throw new Error(`git clone from mirror failed for ${repo.fullName}: ${clone.stderr || clone.stdout}`);
    }

    const setRemote = await runCommand({
      cmd: "git",
      args: ["remote", "set-url", "origin", `https://github.com/${repo.fullName}.git`],
      cwd: targetDir,
      timeoutMs: config.buildTimeoutMs,
      signal: options.signal,
    });
    if (setRemote.code !== 0) {
      throw new Error(`git remote set-url failed for ${repo.fullName}: ${setRemote.stderr || setRemote.stdout}`);
    }

    const hasCommit = await runCommand({
      cmd: "git",
      args: ["cat-file", "-e", `${sha}^{commit}`],
      cwd: targetDir,
      timeoutMs: config.buildTimeoutMs,
      signal: options.signal,
    });
    if (hasCommit.code !== 0) {
      const fetch = await runCommand({
        cmd: "git",
        args: ["fetch", "origin", sha],
        cwd: targetDir,
        timeoutMs: config.buildTimeoutMs,
        signal: options.signal,
      });
      if (fetch.code !== 0) {
        throw new Error(`git fetch failed for ${repo.fullName}@${sha}: ${fetch.stderr || fetch.stdout}`);
      }
    }

    const checkout = await runCommand({
      cmd: "git",
      args: ["checkout", "-B", repo.defaultBranch, sha],
      cwd: targetDir,
      timeoutMs: config.buildTimeoutMs,
      signal: options.signal,
    });
    if (checkout.code !== 0) {
      throw new Error(`git checkout failed for ${repo.fullName}@${sha} on ${repo.defaultBranch}: ${checkout.stderr || checkout.stdout}`);
    }

    const sizeBytes = directorySize(targetDir);
    const files = listFilesRecursive(targetDir);
    return {
      rootDir: targetDir,
      fullName: repo.fullName,
      owner: repo.owner,
      repo: repo.name,
      sha,
      sizeBytes,
      files,
    };
  } catch (err) {
    rmSync(targetDir, { recursive: true, force: true });
    throw err;
  }
}

export function cleanupSnapshot(
  config: Config,
  snapshot: RepoSnapshot,
  options: { force?: boolean } = {},
): void {
  if (config.keepWorktree && !options.force) return;
  rmSync(snapshot.rootDir, { recursive: true, force: true });
}
