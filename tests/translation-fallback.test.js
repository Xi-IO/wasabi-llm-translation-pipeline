import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { evaluateNodeQuality } from "../src/core/quality-checks.js";
import { parseChapterDocument, renderDocument } from "../src/epub/document.js";
import { extractTranslationUnits, applyTranslationUnits } from "../src/epub/translation-units.js";
import { parseSrt } from "../src/subtitles/srt.js";
import { collectTranslatableItems } from "../src/subtitles/translation-items.js";
import { buildSrtTranslationCodecs } from "../src/adapters/subtitles/srt-json-codec.js";

function makeChapter(html, entryName = "OEBPS/ch1.xhtml") {
  return {
    entryName,
    document: parseChapterDocument("chapter-test", html),
  };
}

function translateSegmentPayload(sourceText, transform) {
  try {
    const payload = JSON.parse(sourceText);
    if (!Array.isArray(payload?.segments)) {
      return transform(sourceText);
    }
    payload.segments = payload.segments.map((segment) => ({
      sid: segment.sid,
      text: transform(segment.text),
    }));
    return JSON.stringify(payload);
  } catch {
    return transform(sourceText);
  }
}

async function loadTranslationModule() {
  process.env.QWEN_API_KEY = process.env.QWEN_API_KEY || "test-key";
  return import("../src/core/translation.js");
}

async function loadEpubAdapterModule() {
  process.env.QWEN_API_KEY = process.env.QWEN_API_KEY || "test-key";
  return import("../src/adapters/epub/index.js");
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
  assert.equal(runSummary.unresolvedCount, 1);
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

  const normalized = __internal.normalizeResponseRows(
    [{ id: "1", segments: [{ sid: "S0", text: "译文" }] }],
    [{ key: "1", mode: "complex", segmentMap: [{ sid: "S0" }], sourceText: "{\"segments\":[{\"sid\":\"S0\",\"text\":\"src\"}]}" }],
    (_item, row) => JSON.stringify({ segments: row.segments }),
  );
  assert.equal(normalized[0].translation, "{\"segments\":[{\"sid\":\"S0\",\"text\":\"译文\"}]}");
});

test("epub codec: sid completeness is strict (missing/duplicate/unexpected fail)", async () => {
  const { buildEpubTranslationCodecs } = await loadEpubAdapterModule();
  const codecs = buildEpubTranslationCodecs();
  const item = {
    key: "epub-1",
    mode: "complex",
    segmentMap: [{ sid: "S0" }, { sid: "S1" }],
    sourceText: JSON.stringify({
      segments: [
        { sid: "S0", text: "hello" },
        { sid: "S1", text: "world" },
      ],
    }),
  };

  assert.throws(
    () => codecs.deserializeTranslation(item, { id: "epub-1", segments: [{ sid: "S0", text: "你好" }] }),
    /sid missing/i,
  );
  assert.throws(
    () => codecs.deserializeTranslation(item, {
      id: "epub-1",
      segments: [{ sid: "S0", text: "你好" }, { sid: "S0", text: "重复" }, { sid: "S1", text: "世界" }],
    }),
    /sid duplicate/i,
  );
  assert.throws(
    () => codecs.deserializeTranslation(item, {
      id: "epub-1",
      segments: [{ sid: "S0", text: "你好" }, { sid: "S1", text: "世界" }, { sid: "S2", text: "!" }],
    }),
    /sid mismatch/i,
  );

  const normalized = codecs.deserializeTranslation(item, {
    id: "epub-1",
    segments: [{ sid: "S1", text: "世界" }, { sid: "S0", text: "你好" }],
  });
  assert.equal(normalized, "{\"segments\":[{\"sid\":\"S0\",\"text\":\"你好\"},{\"sid\":\"S1\",\"text\":\"世界\"}]}");
});

test("epub codec prints compact sid debug only on failure", async () => {
  const { buildEpubTranslationCodecs } = await loadEpubAdapterModule();
  const codecs = buildEpubTranslationCodecs();
  process.env.EPUB_SEGMENT_DEBUG = "1";
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map((entry) => String(entry)).join(" "));

  try {
    const item = {
      key: "OEBPS/ch1.xhtml::n407::part2",
      mode: "complex",
      segmentMap: [{ sid: "S0" }, { sid: "S1" }],
      sourceText: JSON.stringify({
        segments: [
          { sid: "S0", text: "hello" },
          { sid: "S1", text: "world" },
        ],
      }),
    };

    assert.throws(
      () => codecs.deserializeTranslation(item, { id: "epub-1", segments: [{ sid: "S0", text: "你好" }] }),
      /sid missing/i,
    );
    assert.equal(warnings.length, 1);
    const payload = JSON.parse(warnings[0].replace(/^[^\{]*/, ""));
    assert.equal(payload.itemKey, item.key);
    assert.deepEqual(payload.diff.missing, ["S1"]);
    assert.deepEqual(payload.missingDetails, [{ sid: "S1", text: "world" }]);
    assert.equal(payload.mode, "complex");

    codecs.deserializeTranslation(item, {
      id: "epub-1",
      segments: [{ sid: "S0", text: "你好" }, { sid: "S1", text: "世界" }],
    });
    assert.equal(warnings.length, 1);
  } finally {
    console.warn = originalWarn;
    delete process.env.EPUB_SEGMENT_DEBUG;
  }
});

test("epub sid missing routes into fallback and can recover in single-node retry", async () => {
  const { translateAll } = await loadTranslationModule();
  const { buildEpubTranslationCodecs } = await loadEpubAdapterModule();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "translation-epub-sid-fallback-"));
  const cachePath = path.join(dir, "cache.json");
  const codecs = buildEpubTranslationCodecs();
  const items = [{
    key: "n1",
    mode: "complex",
    segmentMap: [{ sid: "S0" }, { sid: "S1" }],
    sourceText: JSON.stringify({
      segments: [
        { sid: "S0", text: "alpha" },
        { sid: "S1", text: "beta" },
      ],
    }),
    text: JSON.stringify({
      segments: [
        { sid: "S0", text: "alpha" },
        { sid: "S1", text: "beta" },
      ],
    }),
  }];

  let calls = 0;
  const batchFailures = [];
  const runSummary = {};
  const output = await translateAll(items, cachePath, { from: "en", to: "zh-cn" }, {
    concurrency: 1,
    batchRetryDelayMs: 0,
    singleRetryDelayMs: 0,
    runSummary,
    ...codecs,
    runLogger: {
      async logBatchFailure(payload) {
        batchFailures.push(payload);
      },
      async logUnresolvedNode() {},
    },
    batchTranslator: async () => {
      calls += 1;
      if (calls <= 3) {
        return [{ id: "n1", segments: [{ sid: "S0", text: "甲" }] }];
      }
      return [{ id: "n1", segments: [{ sid: "S0", text: "甲" }, { sid: "S1", text: "乙" }] }];
    },
  });

  assert.equal(runSummary.singleRecoveredNodes, 1);
  assert.equal(runSummary.unresolvedCount, 0);
  assert.equal(batchFailures.length >= 1, true);
  assert.equal(batchFailures.some((entry) => /sid missing/i.test(entry.errorMessage)), true);
  assert.equal(
    output.n1,
    "{\"segments\":[{\"sid\":\"S0\",\"text\":\"甲\"},{\"sid\":\"S1\",\"text\":\"乙\"}]}",
  );
});

test("epub sid failure unresolved preserves source text only at final stage", async () => {
  const { translateAll } = await loadTranslationModule();
  const { buildEpubTranslationCodecs } = await loadEpubAdapterModule();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "translation-epub-sid-unresolved-"));
  const cachePath = path.join(dir, "cache.json");
  const codecs = buildEpubTranslationCodecs();
  const sourcePayload = JSON.stringify({
    segments: [
      { sid: "S0", text: "left" },
      { sid: "S1", text: "right" },
    ],
  });
  const items = [{
    key: "n2",
    mode: "complex",
    segmentMap: [{ sid: "S0" }, { sid: "S1" }],
    sourceText: sourcePayload,
    text: sourcePayload,
  }];

  const unresolvedLogs = [];
  const runSummary = {};
  const output = await translateAll(items, cachePath, { from: "en", to: "zh-cn" }, {
    concurrency: 1,
    batchRetryDelayMs: 0,
    singleRetryDelayMs: 0,
    runSummary,
    ...codecs,
    runLogger: {
      async logBatchFailure() {},
      async logUnresolvedNode(payload) {
        unresolvedLogs.push(payload);
      },
    },
    batchTranslator: async () => [{ id: "n2", segments: [{ sid: "S0", text: "左" }] }],
  });

  assert.equal(runSummary.unresolvedCount, 1);
  assert.equal(runSummary.unresolvedNodeKeys.includes("n2"), true);
  assert.equal(unresolvedLogs.length, 1);
  assert.equal(/sid missing/i.test(unresolvedLogs[0].errorMessage), true);
  assert.equal(output.n2, sourcePayload);
});

test("missing sid can be repaired by repairMissingSegments hook before unresolved", async () => {
  const { translateAll } = await loadTranslationModule();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "translation-repair-missing-sid-"));
  const cachePath = path.join(dir, "cache.json");
  const item = {
    key: "repair-1",
    mode: "complex",
    segmentMap: [{ sid: "S0" }, { sid: "S1" }],
    sourceText: JSON.stringify({
      segments: [
        { sid: "S0", text: "alpha" },
        { sid: "S1", text: "beta" },
      ],
    }),
    text: JSON.stringify({
      segments: [
        { sid: "S0", text: "alpha" },
        { sid: "S1", text: "beta" },
      ],
    }),
  };
  let repairCalls = 0;
  const output = await translateAll([item], cachePath, { from: "en", to: "zh-cn" }, {
    concurrency: 1,
    batchRetryDelayMs: 0,
    singleRetryDelayMs: 0,
    serializeItem: (x) => x.sourceText,
    deserializeTranslation: (_item, row) => {
      if (row?.translation === "broken") {
        const err = new Error("sid missing");
        err.missingSids = ["S1"];
        err.partialSegments = [{ sid: "S0", text: "甲" }];
        throw err;
      }
      return String(row?.translation || "");
    },
    batchTranslator: async () => [{ id: "repair-1", translation: "broken" }],
    repairMissingSegments: async (_item, lastError) => {
      repairCalls += 1;
      assert.deepEqual(lastError.missingSids, ["S1"]);
      return JSON.stringify({
        segments: [
          { sid: "S0", text: "甲" },
          { sid: "S1", text: "乙" },
        ],
      });
    },
    runSummary: {},
  });

  assert.equal(repairCalls >= 1, true);
  assert.equal(output["repair-1"], "{\"segments\":[{\"sid\":\"S0\",\"text\":\"甲\"},{\"sid\":\"S1\",\"text\":\"乙\"}]}");
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

test("srt items can be serialized as timeline+text JSON and mapped back to plain text", async () => {
  const { translateAll } = await loadTranslationModule();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "translation-srt-json-"));
  const cachePath = path.join(dir, "cache.json");
  const parsed = parseSrt("1\n00:00:01,000 --> 00:00:03,000\nHello world.\n");
  const items = collectTranslatableItems("srt", parsed);
  const codecs = buildSrtTranslationCodecs();
  const outbound = [];

  const translationMap = await translateAll(items, cachePath, { from: "en", to: "zh-cn" }, {
    batchRetryDelayMs: 0,
    singleRetryDelayMs: 0,
    concurrency: 1,
    enableRepair: false,
    ...codecs,
    batchTranslator: async (batch) => {
      outbound.push(codecs.serializeItem(batch[0]));
      return batch.map((item) => ({
        id: item.key,
        translation: JSON.stringify({
          timeLine: item.timeLine,
          text: "你好，世界。",
        }),
      }));
    },
  });

  assert.equal(outbound[0].includes("\"timeLine\":\"00:00:01,000 --> 00:00:03,000\""), true);
  assert.equal(outbound[0].includes("\"text\":\"Hello world.\""), true);
  assert.equal(translationMap["0"], "你好，世界。");
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

test("epub: non-block nested text remains translated after cleanup", () => {
  const source = "<html><body><p>Hello <span>world</span></p></body></html>";
  const chapter = makeChapter(source);
  const units = extractTranslationUnits(chapter);
  assert.equal(units.length, 1);
  const translationMap = {
    [units[0].key]: translateSegmentPayload(units[0].sourceText, (txt) => `译:${txt}`),
  };
  applyTranslationUnits(chapter, translationMap, units);
  const html = renderDocument(chapter.document);
  assert.equal(html.includes("<p>译:Hello world</p>"), true);
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

test("epub: pagebreak and citation markers are excluded from translation segments", () => {
  const chapter = makeChapter(`
    <html><body>
      <p>Alpha<span epub:type="pagebreak" id="p30">30</span> beta
        <span class="ref">30</span>
        <a href="#fn1" epub:type="noteref">31</a>
      </p>
    </body></html>
  `);
  const units = extractTranslationUnits(chapter);
  assert.equal(units.length, 1);
  const unit = units[0];
  const source = unit.mode === "simple"
    ? unit.sourceText
    : JSON.parse(unit.sourceText).segments.map((segment) => segment.text).join("");
  assert.equal(source.includes("30"), false);
  assert.equal(source.includes("31"), false);
  assert.equal(source.includes("Alpha"), true);
  assert.equal(source.includes("beta"), true);
});

test("epub: punctuation-only fragments are merged into neighboring prose segments", () => {
  const chapter = makeChapter("<html><body><p><span>Hello</span><span>.</span><span>World</span></p></body></html>");
  const units = extractTranslationUnits(chapter);
  assert.equal(units.length, 1);
  const unit = units[0];
  if (unit.mode === "complex") {
    const payload = JSON.parse(unit.sourceText);
    const standaloneDot = payload.segments.some((segment) => segment.text.trim() === ".");
    assert.equal(standaloneDot, false);
  } else {
    assert.equal(unit.sourceText.includes("Hello.World"), true);
  }
});

test("epub: reconstructed chapter remains parseable and mapping remains 1:1", () => {
  const chapter = makeChapter("<html><body><blockquote>A <strong>quoted</strong> line.</blockquote></body></html>");
  const units = extractTranslationUnits(chapter);
  assert.equal(units.length, 1);
  assert.equal(units[0].sourceNodeIds.length >= units[0].segmentMap.length, true);

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
