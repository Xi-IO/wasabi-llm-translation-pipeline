import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";

async function loadTranslationModule() {
  process.env.QWEN_API_KEY = process.env.QWEN_API_KEY || "test-key";
  return import("../src/core/translation.js");
}

async function loadEpubAdapterModule() {
  process.env.QWEN_API_KEY = process.env.QWEN_API_KEY || "test-key";
  return import("../src/adapters/epub/index.js");
}

async function withEnv(envPatch, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(envPatch)) {
    previous.set(key, process.env[key]);
    if (value == null) {
      delete process.env[key];
    } else {
      process.env[key] = String(value);
    }
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function makeCachePath(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  return path.join(dir, "cache.json");
}

test("content-policy error triggers provider fallback and accepts fallback result", { concurrency: false }, async () => {
  const { translateAll } = await loadTranslationModule();
  const items = [{ key: "x1", text: "hello" }];
  let fallbackCalls = 0;
  const output = await translateAll(items, await makeCachePath("fallback-content"), { from: "en", to: "zh-cn" }, {
    concurrency: 1,
    batchRetryDelayMs: 0,
    singleRetryDelayMs: 0,
    fallbackOnContentFilter: true,
    fallbackProviderConfig: { provider: "grok", model: "grok-4.1-fast", apiKey: "test", baseURL: "https://api.x.ai/v1" },
    batchTranslator: async () => {
      throw new Error("HTTP 400: Input data may contain inappropriate content");
    },
    fallbackBatchTranslator: async () => {
      fallbackCalls += 1;
      return [{ id: "x1", translation: "你好" }];
    },
    runSummary: {},
  });
  assert.equal(fallbackCalls, 1);
  assert.equal(output.x1, "你好");
});

test("JSON parse errors do not trigger provider fallback", { concurrency: false }, async () => {
  const { translateAll } = await loadTranslationModule();
  const items = [{ key: "x2", text: "hello" }];
  let fallbackCalls = 0;
  const output = await translateAll(items, await makeCachePath("fallback-json"), { from: "en", to: "zh-cn" }, {
    concurrency: 1,
    batchRetryDelayMs: 0,
    singleRetryDelayMs: 0,
    fallbackOnContentFilter: true,
    fallbackProviderConfig: { provider: "grok", model: "grok-4.1-fast", apiKey: "test", baseURL: "https://api.x.ai/v1" },
    batchTranslator: async () => {
      throw new Error("Model response JSON is not an array.");
    },
    fallbackBatchTranslator: async () => {
      fallbackCalls += 1;
      return [{ id: "x2", translation: "你好" }];
    },
    runSummary: {},
  });
  assert.equal(fallbackCalls, 0);
  assert.equal(output.x2, "hello");
});

test("sid mismatch errors do not trigger provider fallback", { concurrency: false }, async () => {
  const { translateAll } = await loadTranslationModule();
  const { buildEpubTranslationCodecs } = await loadEpubAdapterModule();
  const codecs = buildEpubTranslationCodecs();
  const sourcePayload = JSON.stringify({
    segments: [
      { sid: "S0", text: "a" },
      { sid: "S1", text: "b" },
    ],
  });
  const items = [{ key: "x3", mode: "complex", segmentMap: [{ sid: "S0" }, { sid: "S1" }], sourceText: sourcePayload, text: sourcePayload }];
  let fallbackCalls = 0;
  const output = await translateAll(items, await makeCachePath("fallback-sid"), { from: "en", to: "zh-cn" }, {
    concurrency: 1,
    batchRetryDelayMs: 0,
    singleRetryDelayMs: 0,
    fallbackOnContentFilter: true,
    fallbackProviderConfig: { provider: "grok", model: "grok-4.1-fast", apiKey: "test", baseURL: "https://api.x.ai/v1" },
    ...codecs,
    batchTranslator: async () => [{ id: "x3", segments: [{ sid: "S0", text: "甲" }] }],
    fallbackBatchTranslator: async () => {
      fallbackCalls += 1;
      return [{ id: "x3", translation: "unused" }];
    },
    runSummary: {},
  });
  assert.equal(fallbackCalls, 0);
  assert.equal(output.x3, sourcePayload);
});

test("content-policy fallback failure keeps unresolved behavior", { concurrency: false }, async () => {
  const { translateAll } = await loadTranslationModule();
  const items = [{ key: "x4", text: "hello" }];
  const runSummary = {};
  const output = await translateAll(items, await makeCachePath("fallback-fail"), { from: "en", to: "zh-cn" }, {
    concurrency: 1,
    batchRetryDelayMs: 0,
    singleRetryDelayMs: 0,
    fallbackOnContentFilter: true,
    fallbackProviderConfig: { provider: "grok", model: "grok-4.1-fast", apiKey: "test", baseURL: "https://api.x.ai/v1" },
    batchTranslator: async () => {
      throw new Error("HTTP 400 content policy block");
    },
    fallbackBatchTranslator: async () => {
      throw new Error("grok failed");
    },
    runSummary,
  });
  assert.equal(runSummary.unresolvedCount, 1);
  assert.equal(output.x4, "hello");
});

test("fallback disabled does not call grok even on content-policy errors", { concurrency: false }, async () => {
  const { translateAll } = await loadTranslationModule();
  const items = [{ key: "x5", text: "hello" }];
  let fallbackCalls = 0;
  const output = await translateAll(items, await makeCachePath("fallback-off"), { from: "en", to: "zh-cn" }, {
    concurrency: 1,
    batchRetryDelayMs: 0,
    singleRetryDelayMs: 0,
    fallbackOnContentFilter: false,
    fallbackProviderConfig: { provider: "grok", model: "grok-4.1-fast", apiKey: "test", baseURL: "https://api.x.ai/v1" },
    batchTranslator: async () => {
      throw new Error("HTTP 400 content filter");
    },
    fallbackBatchTranslator: async () => {
      fallbackCalls += 1;
      return [{ id: "x5", translation: "你好" }];
    },
    runSummary: {},
  });
  assert.equal(fallbackCalls, 0);
  assert.equal(output.x5, "hello");
});

test("env config exposes primary/fallback provider and models", { concurrency: false }, async () => {
  await withEnv({
    PRIMARY_PROVIDER: "qwen",
    PRIMARY_MODEL: "qwen3-max",
    FALLBACK_PROVIDER: "grok",
    FALLBACK_MODEL: "grok-4.1-fast",
    FALLBACK_ON_CONTENT_FILTER: "true",
    QWEN_API_KEY: "qwen-key",
    GROK_API_KEY: "grok-key",
    GROK_BASE_URL: "https://api.x.ai/v1",
  }, async () => {
    const runtime = await import(`../src/config/runtime.js?fresh=${Date.now()}_${Math.random()}`);
    assert.equal(runtime.CONFIG.provider.provider, "qwen");
    assert.equal(runtime.CONFIG.provider.model, "qwen3-max");
    assert.equal(runtime.CONFIG.fallbackProvider.provider, "grok");
    assert.equal(runtime.CONFIG.fallbackProvider.model, "grok-4.1-fast");
    assert.equal(runtime.CONFIG.fallbackOnContentFilter, true);
  });
});
