import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";

import {
  appendRunFailureLog,
  buildBatchFailureTerminalMessage,
  buildRetryRecoveredMessage,
  createRunLogger,
  finalizeRunLog,
  formatNodePreview,
} from "../src/core/run-logger.js";

test("preview truncation helper", () => {
  const text = "a".repeat(200);
  const preview = formatNodePreview(text, 80);
  assert.equal(preview.length, 81);
  assert.ok(preview.endsWith("…"));
});

test("failure log entry shape", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "runlog-shape-"));
  const logger = await createRunLogger({
    inputFile: "demo.srt",
    provider: "qwen",
    model: "qwen-plus",
    baseDir: dir,
  });

  await logger.logBatchFailure({
    batchIndex: 1,
    totalBatches: 3,
    attempt: 1,
    errorType: "ModelResponseParseError",
    errorMessage: "Model response does not contain a JSON array.",
    failedNodes: [{ key: "1", sourceLength: 10, preview: "hello", fullSourceText: "hello world" }],
    modelResponsePreview: "oops",
  });

  const content = await fs.readFile(logger.runLogPath, "utf8");
  const lines = content.trim().split("\n").map((line) => JSON.parse(line));
  const last = lines[lines.length - 1];

  assert.equal(last.type, "batch-failure");
  assert.equal(last.batchIndex, 1);
  assert.equal(last.attempt, 1);
  assert.equal(last.provider, "qwen");
  assert.equal(last.model, "qwen-plus");
  assert.ok(Array.isArray(last.failedNodes));
});

test("successful run removes temp log", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "runlog-clean-"));
  const logPath = path.join(dir, "temp", "run-logs", "a.jsonl");
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.writeFile(logPath, "{}\n", "utf8");

  await finalizeRunLog(logPath, { success: true });
  const exists = await fs.stat(logPath).then(() => true).catch(() => false);
  assert.equal(exists, false);
});

test("interrupted run preserves temp log", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "runlog-keep-"));
  const logPath = path.join(dir, "temp", "run-logs", "a.jsonl");
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.writeFile(logPath, "{}\n", "utf8");

  await finalizeRunLog(logPath, { success: false, reason: "SIGINT" });
  const content = await fs.readFile(logPath, "utf8");
  assert.match(content, /"reason":"SIGINT"/);
});

test("batch retry success prints recovered message", () => {
  const msg = buildRetryRecoveredMessage(4, 3);
  assert.equal(msg, "批次 4 在第 3 次重试后成功");
});

test("terminal output does not include full source text by default", () => {
  const fullSource = "x".repeat(300);
  const msg = buildBatchFailureTerminalMessage({
    batchIndex: 4,
    totalBatches: 10,
    attempt: 1,
    errorMessage: "parse error",
    failedNodes: [
      {
        key: "node-1",
        sourceLength: fullSource.length,
        preview: formatNodePreview(fullSource, 80),
      },
    ],
    verbose: false,
  });

  assert.match(msg, /node-1/);
  assert.ok(!msg.includes(fullSource));
});
