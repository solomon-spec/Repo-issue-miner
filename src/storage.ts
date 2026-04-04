import { Dirent, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { Config } from "./types.js";

const STALE_WORKTREE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const STALE_MIRROR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MIRROR_CACHE_LIMIT_BYTES = 512 * 1024 * 1024;
const LOG_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const REPORT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const CLEANUP_THROTTLE_MS = 5 * 60 * 1000;
const MIRROR_DIRNAME = "_repo_mirrors";

let lastCleanupAt = 0;

type CleanupItem = {
  path: string;
  bytes: number;
};

export type StorageCleanupSummary = {
  removedBytes: number;
  removedItems: CleanupItem[];
  skipped: boolean;
};

function walkSize(path: string): number {
  try {
    const stats = statSync(path);
    if (stats.isFile()) return stats.size;
    if (!stats.isDirectory()) return 0;
  } catch {
    return 0;
  }

  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    total += walkSize(join(path, entry.name));
  }
  return total;
}

function mtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function removePath(path: string, removedItems: CleanupItem[]): void {
  if (!existsSync(path)) return;
  const bytes = walkSize(path);
  rmSync(path, { recursive: true, force: true });
  removedItems.push({ path, bytes });
}

function listEntries(path: string): Dirent[] {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

function pruneDirectoryByAge(
  root: string,
  maxAgeMs: number,
  removedItems: CleanupItem[],
  predicate: (entry: Dirent) => boolean = () => true,
): void {
  if (!existsSync(root)) return;
  const cutoff = Date.now() - maxAgeMs;
  for (const entry of listEntries(root)) {
    if (!predicate(entry)) continue;
    const fullPath = join(root, entry.name);
    if (mtimeMs(fullPath) > cutoff) continue;
    removePath(fullPath, removedItems);
  }
}

function pruneMirrorCache(root: string, removedItems: CleanupItem[]): void {
  if (!existsSync(root)) return;

  const cutoff = Date.now() - STALE_MIRROR_MAX_AGE_MS;
  const mirrors = listEntries(root)
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const path = join(root, entry.name);
      return {
        path,
        bytes: walkSize(path),
        modifiedAtMs: mtimeMs(path),
      };
    })
    .sort((left, right) => left.modifiedAtMs - right.modifiedAtMs);

  let remainingBytes = mirrors.reduce((sum, mirror) => sum + mirror.bytes, 0);
  for (const mirror of mirrors) {
    if (mirror.modifiedAtMs <= cutoff || remainingBytes > MIRROR_CACHE_LIMIT_BYTES) {
      removePath(mirror.path, removedItems);
      remainingBytes -= mirror.bytes;
    }
  }
}

export function cleanupProjectStorage(config: Config): StorageCleanupSummary {
  const now = Date.now();
  if (now - lastCleanupAt < CLEANUP_THROTTLE_MS) {
    return { removedBytes: 0, removedItems: [], skipped: true };
  }
  lastCleanupAt = now;

  const removedItems: CleanupItem[] = [];

  pruneDirectoryByAge(
    config.workRoot,
    STALE_WORKTREE_MAX_AGE_MS,
    removedItems,
    (entry) => entry.isDirectory() && entry.name !== MIRROR_DIRNAME,
  );
  pruneMirrorCache(join(config.workRoot, MIRROR_DIRNAME), removedItems);
  pruneDirectoryByAge(join(config.outputRoot, "logs"), LOG_RETENTION_MS, removedItems, (entry) => entry.isDirectory());
  pruneDirectoryByAge(
    config.outputRoot,
    REPORT_RETENTION_MS,
    removedItems,
    (entry) => entry.isFile() && /^scan-\d+\.json$/i.test(entry.name),
  );

  return {
    removedBytes: removedItems.reduce((sum, item) => sum + item.bytes, 0),
    removedItems,
    skipped: false,
  };
}
