import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { evaluateNodeQuality } from "../src/core/quality-checks.js";

async function loadTranslationModule() {
  process.env.QWEN_API_KEY = process.env.QWEN_API_KEY || "test-key";
  return import("../src/core/translation.js");
}

function makeItems() {
  return [
    { key: "1", text: "alpha" },
    { key: "2", text: "beta" },
    { key: "3", text: "gamma" },
  ];
}

test("batch failure falls back to per-node retries and keeps pipeline running", async () => {
  const { translateAll } = await loadTranslationModule();
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
  const { translateAll, __internal } = await loadTranslationModule();
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

  assert.throws(
    () => __internal.validateBatchOutput(makeItems().slice(0, 2), [{ id: "1", translation: "x" }]),
    /length mismatch/i,
  );
  assert.throws(
    () => __internal.validateBatchOutput(makeItems().slice(0, 2), [
      { id: "1", translation: "x" },
      { id: "unknown", translation: "y" },
    ]),
    /unknown node id/i,
  );
});

test("heuristics detect mixed-language residue and glossary artifacts", () => {
  const mixed = evaluateNodeQuality({
    sourceText: "This paragraph is long enough to trigger quality checks and should be translated.",
    translation: "这是明显的中文译文部分，叙述也已经翻译成中文，但是 still a large part remains in English and keeps going for many words here.",
  });
  assert.equal(mixed.reasons.includes("source-language-residue"), true);

  const glossary = evaluateNodeQuality({
    sourceText: "He moved rapidly across the field.",
    translation: "他快速地移动，rapid（迅捷的）穿过了场地。",
  });
  assert.equal(glossary.reasons.includes("inline-glossary-artifact"), true);
});

test("only suspicious nodes trigger repair and preserve output cardinality", async () => {
  const { translateAll } = await loadTranslationModule();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "translation-repair-"));
  const cachePath = path.join(dir, "cache.json");
  const items = [
    { key: "clean", text: "Hello world." },
    { key: "sus", text: "The cat runs rapidly through the yard." },
  ];

  let repairCalls = 0;
  const { nodeResults, translations } = await translateAll(items, cachePath, { from: "en", to: "zh-cn" }, {
    batchRetryDelayMs: 0,
    singleRetryDelayMs: 0,
    concurrency: 1,
    returnNodeResults: true,
    batchTranslator: async (batch) => batch.map((x) => ({
      id: x.key,
      translation: x.key === "sus" ? "猫跑得很快 rapid（迅捷的）在院子里。" : "你好，世界。",
    })),
    repairTranslator: async () => {
      repairCalls += 1;
      return "猫在院子里飞快地奔跑。";
    },
  });

  assert.equal(repairCalls, 1);
  assert.equal(nodeResults.clean.status, "translated");
  assert.equal(nodeResults.sus.status, "translated");
  assert.equal(Object.keys(translations).length, items.length);
});
