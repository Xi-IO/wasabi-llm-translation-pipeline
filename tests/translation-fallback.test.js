import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";

async function loadTranslateAll() {
  process.env.QWEN_API_KEY = process.env.QWEN_API_KEY || "test-key";
  const mod = await import("../src/core/translation.js");
  return mod.translateAll;
}

function makeItems() {
  return [
    { key: "1", text: "alpha" },
    { key: "2", text: "beta" },
    { key: "3", text: "gamma" },
  ];
}

test("batch failure falls back to per-node retries and keeps pipeline running", async () => {
  const translateAll = await loadTranslateAll();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "translation-fallback-"));
  const cachePath = path.join(dir, "cache.json");
  const calls = [];
  const unresolvedLogs = [];

  const batchTranslator = async (batch) => {
    const keys = batch.map((x) => x.key).join(",");
    calls.push(keys);

    if (batch.length > 1) {
      throw new Error("batch parse error");
    }

    const [item] = batch;
    if (item.key === "2") {
      throw new Error("single node keeps failing");
    }

    return [{ key: item.key, translation: `T-${item.text}` }];
  };

  const runSummary = {};
  const result = await translateAll(makeItems(), cachePath, { from: "en", to: "zh-cn" }, {
    batchTranslator,
    concurrency: 1,
    batchRetryDelayMs: 0,
    singleRetryDelayMs: 0,
    runSummary,
    runLogger: {
      async logBatchFailure() {},
      async logUnresolvedNode(payload) {
        unresolvedLogs.push(payload);
      },
    },
  });

  assert.equal(result["1"], "T-alpha");
  assert.equal(result["2"], "beta");
  assert.equal(result["3"], "T-gamma");
  assert.ok(calls.includes("1,2,3"));
  assert.ok(calls.includes("1"));
  assert.ok(calls.includes("2"));
  assert.ok(calls.includes("3"));

  assert.equal(runSummary.totalNodes, 3);
  assert.equal(runSummary.batchSuccessNodes, 0);
  assert.equal(runSummary.singleRecoveredNodes, 2);
  assert.equal(runSummary.unresolvedNodes, 1);
  assert.deepEqual(runSummary.unresolvedNodeKeys, ["2"]);
  assert.equal(unresolvedLogs.length, 1);
  assert.equal(unresolvedLogs[0].key, "2");
  assert.equal(unresolvedLogs[0].sourceLength, 4);
});

test("successful nodes persist incrementally when some nodes fail", async () => {
  const translateAll = await loadTranslateAll();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "translation-cache-"));
  const cachePath = path.join(dir, "cache.json");

  const batchTranslator = async (batch) => {
    if (batch.length > 1) throw new Error("batch fail");
    const [item] = batch;
    if (item.key === "2") throw new Error("still failing");
    return [{ key: item.key, translation: `ok-${item.key}` }];
  };

  await translateAll(makeItems(), cachePath, { from: "en", to: "zh-cn" }, {
    batchTranslator,
    concurrency: 1,
    batchRetryDelayMs: 0,
    singleRetryDelayMs: 0,
    runSummary: {},
  });

  const persisted = JSON.parse(await fs.readFile(cachePath, "utf8"));
  assert.equal(persisted["1"], "ok-1");
  assert.equal(persisted["2"], "beta");
  assert.equal(persisted["3"], "ok-3");
});
