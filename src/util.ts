import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";

export class CommandAbortedError extends Error {}

export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}

export function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

export function sanitizeTag(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
}

export function parseInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function parseBooleanFlag(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export function stripMarkdownFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```") || !trimmed.endsWith("```")) return trimmed;
  return trimmed.replace(/^```[a-zA-Z0-9_-]*\n?/, "").replace(/```$/, "").trim();
}

export function readUtf8Safe(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

export function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function withTimeoutSignal(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}

export async function runCommand(options: {
  cmd: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  stdinText?: string;
  stdoutPath?: string;
  stderrPath?: string;
  signal?: AbortSignal;
  onStdoutChunk?: (chunk: string) => void;
  onStderrChunk?: (chunk: string) => void;
}): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean; aborted: boolean }> {
  if (options.signal?.aborted) {
    throw new CommandAbortedError(`${options.cmd} was canceled before it started`);
  }

  const stdoutChunks: any[] = [];
  const stderrChunks: any[] = [];
  const child = spawn(options.cmd, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let timedOut = false;
  let aborted = false;
  let forceKillTimer: NodeJS.Timeout | undefined;

  const stdoutStream = options.stdoutPath
    ? createWriteStream(resolve(options.stdoutPath), { flags: "w" })
    : undefined;
  const stderrStream = options.stderrPath
    ? createWriteStream(resolve(options.stderrPath), { flags: "w" })
    : undefined;

  child.stdout.on("data", (chunk: any) => {
    const buffer = Buffer.from(chunk);
    stdoutChunks.push(buffer);
    stdoutStream?.write(chunk);
    options.onStdoutChunk?.(buffer.toString("utf8"));
  });

  child.stderr.on("data", (chunk: any) => {
    const buffer = Buffer.from(chunk);
    stderrChunks.push(buffer);
    stderrStream?.write(chunk);
    options.onStderrChunk?.(buffer.toString("utf8"));
  });

  if (typeof options.stdinText === "string") {
    child.stdin.write(options.stdinText, "utf8");
  }
  child.stdin.end();

  const abortHandler = () => {
    aborted = true;
    child.kill("SIGTERM");
    forceKillTimer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 3000);
  };
  options.signal?.addEventListener("abort", abortHandler, { once: true });

  const killTimer = options.timeoutMs && options.timeoutMs > 0
    ? setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, options.timeoutMs)
    : undefined;

  const code = await new Promise<number | null>((resolvePromise, rejectPromise) => {
    child.on("error", rejectPromise);
    child.on("close", (exitCode: number | null) => resolvePromise(exitCode));
  }).finally(() => {
    if (killTimer) clearTimeout(killTimer);
    if (forceKillTimer) clearTimeout(forceKillTimer);
    options.signal?.removeEventListener("abort", abortHandler);
    stdoutStream?.end();
    stderrStream?.end();
  });

  if (aborted) {
    throw new CommandAbortedError(`${options.cmd} ${options.args.join(" ")} was canceled`);
  }

  return {
    code,
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
    timedOut,
    aborted,
  };
}

export function writeJson(path: string, data: unknown): void {
  ensureDir(dirname(path));
  const payload = `${JSON.stringify(data, null, 2)}\n`;
  writeFileSync(path, payload, "utf8");
}

export function englishHeuristic(text: string): boolean {
  const sample = text.slice(0, 5000);
  if (!sample) return false;
  const printableAscii = [...sample].filter((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) <= 126).length;
  const asciiRatio = printableAscii / sample.length;
  const englishWords = ["the", "and", "install", "test", "usage", "run", "repository", "project", "issue", "pull", "request"];
  const lower = sample.toLowerCase();
  const hits = englishWords.filter((word) => lower.includes(` ${word}`) || lower.startsWith(word)).length;
  return asciiRatio > 0.9 && hits >= 3;
}
