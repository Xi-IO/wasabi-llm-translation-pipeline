import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { evaluateNodeQuality } from "../src/core/quality-checks.js";
import { parseChapterDocument, renderDocument } from "../src/epub/document.js";
import { extractTranslationUnits, applyTranslationUnits } from "../src/epub/translation-units.js";

function makeChapter(html, entryName = "OEBPS/ch1.xhtml") {
  return {
    entryName,
    document: parseChapterDocument("chapter-test", html),
  };
}

function translateSegmentPayload(sourceText, transform) {
  const payload = JSON.parse(sourceText);
  payload.segments = payload.segments.map((segment) => ({
    sid: segment.sid,
    text: transform(segment.text),
  }));
  return JSON.stringify(payload);
}

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

test("cached unresolved nodes are retried on next run", async () => {
  const { translateAll } = await loadTranslationModule();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "translation-retry-unresolved-"));
  const cachePath = path.join(dir, "cache.json");
  await fs.writeFile(cachePath, JSON.stringify({
    "1": {
      id: "1",
      sourceText: "alpha",
      translation: "alpha",
      status: "unresolved",
      reasons: ["fallback-to-source"],
      attempts: { batch: 3, single: 3, repair: 0 },
      error: { type: "Error", message: "previous failure" },
    },
  }, null, 2), "utf8");

  let calls = 0;
  const output = await translateAll(makeItems(), cachePath, { from: "en", to: "zh-cn" }, {
    batchRetryDelayMs: 0,
    singleRetryDelayMs: 0,
    concurrency: 1,
    enableRepair: false,
    persistNodeResults: true,
    batchTranslator: async (batch) => {
      calls += 1;
      return batch.map((item) => ({ id: item.key, translation: `retry-${item.text}` }));
    },
  });

  assert.equal(calls > 0, true);
  assert.equal(output["1"], "retry-alpha");
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

test("epub: plain paragraph round-trips through block unit", () => {
  const chapter = makeChapter("<html><body><p>Hello world.</p></body></html>");
  const units = extractTranslationUnits(chapter);
  assert.equal(units.length, 1);
  assert.equal(units[0].kind, "p");

  const translationMap = {
    [units[0].key]: translateSegmentPayload(units[0].sourceText, (txt) => `ZH:${txt}`),
  };
  applyTranslationUnits(chapter, translationMap, units);
  const html = renderDocument(chapter.document);
  assert.equal(html.includes("<p>ZH:Hello world.</p>"), true);
});

test("epub: inline em structure is preserved", () => {
  const chapter = makeChapter("<html><body><p>Hello <em>dear</em> friend.</p></body></html>");
  const units = extractTranslationUnits(chapter);
  assert.equal(units.length, 1);

  const translationMap = {
    [units[0].key]: translateSegmentPayload(units[0].sourceText, (txt) => `译:${txt}`),
  };
  applyTranslationUnits(chapter, translationMap, units);
  const html = renderDocument(chapter.document);
  assert.equal(html.includes("<em>译:dear</em>"), true);
  assert.equal(html.includes("译:Hello "), true);
});

test("epub: link structure and href are preserved", () => {
  const chapter = makeChapter("<html><body><p>Go <a href=\"#fn1\" id=\"r1\">there</a>.</p></body></html>");
  const units = extractTranslationUnits(chapter);
  const translationMap = {
    [units[0].key]: translateSegmentPayload(units[0].sourceText, (txt) => `译:${txt}`),
  };

  applyTranslationUnits(chapter, translationMap, units);
  const html = renderDocument(chapter.document);
  assert.equal(html.includes("href=\"#fn1\""), true);
  assert.equal(html.includes("id=\"r1\""), true);
  assert.equal(html.includes("<a href=\"#fn1\" id=\"r1\">译:there</a>"), true);
});

test("epub: heading tags keep structure after translation", () => {
  const chapter = makeChapter("<html><body><h2>Chapter Title</h2></body></html>");
  const units = extractTranslationUnits(chapter);
  assert.equal(units.length, 1);
  assert.equal(units[0].kind, "h2");

  const translationMap = {
    [units[0].key]: translateSegmentPayload(units[0].sourceText, (txt) => `译:${txt}`),
  };
  applyTranslationUnits(chapter, translationMap, units);
  const html = renderDocument(chapter.document);
  assert.equal(html.includes("<h2>译:Chapter Title</h2>"), true);
});

test("epub: non-block nested tags are preserved while text is still translated", () => {
  const source = "<html><body><p>Hello <span>world</span></p></body></html>";
  const chapter = makeChapter(source);
  const units = extractTranslationUnits(chapter);
  assert.equal(units.length, 1);
  const translationMap = {
    [units[0].key]: translateSegmentPayload(units[0].sourceText, (txt) => `译:${txt}`),
  };
  applyTranslationUnits(chapter, translationMap, units);
  const html = renderDocument(chapter.document);
  assert.equal(html.includes("<span>译:world</span>"), true);
  assert.equal(html.includes("<p>译:Hello <span>译:world</span></p>"), true);
});

test("epub: nested block container is skipped but child block still extracted", () => {
  const chapter = makeChapter("<html><body><ul><li>outer<p>inner</p></li></ul></body></html>");
  const diagnostics = {};
  const units = extractTranslationUnits(chapter, diagnostics);
  assert.equal(units.length, 1);
  assert.equal(units[0].kind, "p");
  assert.equal(diagnostics.blockCandidates >= 2, true);
  assert.equal(diagnostics.skippedReasons["nested-block-structure"], 1);
});

test("epub: extraction diagnostics count empty-text skips", () => {
  const chapter = makeChapter("<html><body><p>   </p><p>filled</p></body></html>");
  const diagnostics = {};
  const units = extractTranslationUnits(chapter, diagnostics);
  assert.equal(units.length, 1);
  assert.equal(diagnostics.blockCandidates, 2);
  assert.equal(diagnostics.producedUnits, 1);
  assert.equal(diagnostics.skippedReasons["empty-text"], 1);
});

test("epub: div containers can be extracted as translatable blocks", () => {
  const chapter = makeChapter("<html><body><div>Paragraph in div.</div></body></html>");
  const units = extractTranslationUnits(chapter);
  assert.equal(units.length, 1);
  assert.equal(units[0].kind, "div");
});

test("epub: reconstructed chapter remains parseable and mapping remains 1:1", () => {
  const chapter = makeChapter("<html><body><blockquote>A <strong>quoted</strong> line.</blockquote></body></html>");
  const units = extractTranslationUnits(chapter);
  assert.equal(units.length, 1);
  assert.equal(units[0].sourceNodeIds.length, units[0].segmentMap.length);

  const translationMap = {
    [units[0].key]: translateSegmentPayload(units[0].sourceText, (txt) => `译:${txt}`),
  };
  const diagnostics = {};
  applyTranslationUnits(chapter, translationMap, units, diagnostics);
  const rendered = renderDocument(chapter.document);
  const reparsed = parseChapterDocument("chapter-reparse", rendered);
  assert.equal(Array.isArray(reparsed.children), true);
  assert.equal(rendered.includes("<blockquote>"), true);
  assert.equal(diagnostics.totalUnits, 1);
  assert.equal(diagnostics.appliedUnits, 1);
});

test("epub: apply diagnostics detect segment-payload mismatch skips", () => {
  const chapter = makeChapter("<html><body><p>Hello</p></body></html>");
  const units = extractTranslationUnits(chapter);
  const diagnostics = {};
  applyTranslationUnits(
    chapter,
    { [units[0].key]: "{\"oops\":true}" },
    units,
    diagnostics,
  );
  assert.equal(diagnostics.totalUnits, 1);
  assert.equal(diagnostics.appliedUnits, 0);
  assert.equal(diagnostics.skippedInvalidPlaceholder, 1);
});

test("epub: apply accepts segment payload with sid variations", () => {
  const chapter = makeChapter("<html><body><p>Hello <em>world</em>!</p></body></html>");
  const units = extractTranslationUnits(chapter);
  const unit = units[0];

  const translationMap = {
    [unit.key]: JSON.stringify({
      segments: unit.segmentMap.map((segment) => ({
        sid: segment.sid,
        text: segment.sid === "S0" ? "你好，" : (segment.sid === "S1" ? "世界" : "！"),
      })),
    }),
  };
  const diagnostics = {};
  applyTranslationUnits(chapter, translationMap, units, diagnostics);
  const html = renderDocument(chapter.document);

  assert.equal(diagnostics.appliedUnits, 1);
  assert.equal(html.includes("<p>你好，<em>世界</em>！</p>"), true);
});
