import test from "node:test";
import assert from "node:assert/strict";

import {
  parseBooleanFlag,
  parseInteger,
  runCommand,
  sanitizeTag,
  stripMarkdownFence,
} from "../dist/util.js";

test("runCommand writes stdinText to the child process", async () => {
  const result = await runCommand({
    cmd: "node",
    args: ["-e", "process.stdin.setEncoding('utf8');let data='';process.stdin.on('data', c => data += c);process.stdin.on('end', () => process.stdout.write(data.toUpperCase()));"],
    stdinText: "hello world",
    timeoutMs: 5000,
  });

  assert.equal(result.code, 0);
  assert.equal(result.stdout, "HELLO WORLD");
});

test("runCommand reports timeout when a process exceeds timeoutMs", async () => {
  const result = await runCommand({
    cmd: "node",
    args: ["-e", "setTimeout(() => console.log('late'), 2000)"],
    timeoutMs: 50,
  });

  assert.equal(result.timedOut, true);
});

test("utility helpers normalize config and markdown values", () => {
  assert.equal(parseInteger("12", 5), 12);
  assert.equal(parseInteger("oops", 5), 5);
  assert.equal(parseBooleanFlag("yes", false), true);
  assert.equal(parseBooleanFlag(undefined, true), true);
  assert.equal(sanitizeTag(" Repo / Name "), "repo-name");
  assert.equal(stripMarkdownFence("```json\n{\"ok\":true}\n```"), "{\"ok\":true}");
});
