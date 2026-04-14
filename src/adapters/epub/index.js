import fs from "fs/promises";
import path from "path";
import OpenAI from "openai";
import { DEFAULT_EPUB_PROMPT_PATH, translateAll } from "../../core/translation.js";
import { CONFIG, languageLabel } from "../../config/runtime.js";
import { extractTranslationUnits, applyTranslationUnits } from "../../epub/translation-units.js";

const EPUB_SPLIT_THRESHOLD = 8;
const EPUB_SPLIT_CHUNK_SIZE = 6;
const EPUB_SPLIT_CHAR_THRESHOLD = 1200;
const EPUB_MISSING_SEGMENTS_PROMPT_PATH = new URL("../../../prompts/epub_missing_segments_repair.txt", import.meta.url);

function isEpubSegmentDebugEnabled() {
  const flag = String(process.env.EPUB_SEGMENT_DEBUG || "").trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes" || flag === "on";
}

function resolveEpubFailureDebugDir() {
  return process.env.EPUB_FAILURE_DEBUG_DIR || path.join(process.cwd(), "debug", "epub-failures");
}

function sanitizeDebugName(value) {
  return String(value || "unknown")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "unknown";
}

function parseExpectedSegments(sourceText) {
  try {
    const payload = JSON.parse(String(sourceText || "{}"));
    const segments = Array.isArray(payload?.segments) ? payload.segments : [];
    return segments.map((segment) => ({
      sid: String(segment?.sid || "").trim(),
      text: String(segment?.text ?? ""),
    })).filter((segment) => segment.sid);
  } catch {
    return [];
  }
}

function calcAverageSegmentLength(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return 0;
  const total = segments.reduce((sum, segment) => sum + String(segment?.text ?? "").length, 0);
  return Number((total / segments.length).toFixed(2));
}

async function dumpEpubFailureDebug({
  item,
  expectedSegments,
  actualSegments,
  errorType,
}) {
  if (!isEpubSegmentDebugEnabled()) return;
  try {
    const expectedSids = expectedSegments.map((segment) => segment.sid);
    const actualSids = actualSegments.map((segment) => segment.sid);
    const expectedSidSet = new Set(expectedSids);
    const actualSidSet = new Set(actualSids);
    const missing = expectedSids.filter((sid) => !actualSidSet.has(sid));
    const extra = actualSids.filter((sid) => !expectedSidSet.has(sid));
    const missingDetails = missing.map((sid) => ({
      sid,
      text: expectedSegments.find((segment) => segment.sid === sid)?.text || "",
    }));

    const debugPayload = {
      itemKey: item?.key || "<unknown>",
      mode: item?.mode || "complex",
      errorType: String(errorType || "segment-mismatch"),
      expected: { segments: expectedSegments },
      actual: { segments: actualSegments },
      diff: { missing, extra },
      missingDetails,
      metrics: {
        expectedCount: expectedSegments.length,
        actualCount: actualSegments.length,
        expectedAvgLen: calcAverageSegmentLength(expectedSegments),
        actualAvgLen: calcAverageSegmentLength(actualSegments),
      },
    };
    const debugDir = resolveEpubFailureDebugDir();
    await fs.mkdir(debugDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeKey = sanitizeDebugName(item?.key);
    const outputPath = path.join(debugDir, `${timestamp}-${safeKey}.json`);
    await fs.writeFile(outputPath, JSON.stringify(debugPayload, null, 2), "utf8");
  } catch {
    // Debug dump should never break translation flow.
  }
}

export function extractEpubItems(epubDoc) {
  const allItems = [];
  const rollup = {
    blockCandidates: 0,
    producedUnits: 0,
    simpleUnits: 0,
    complexUnits: 0,
    skippedReasons: {},
  };

  for (const chapter of epubDoc.chapters) {
    chapter.preprocessContext = {
      referencedIds: epubDoc.referencedIds,
      definedClasses: epubDoc.definedClasses,
    };
    const diagnostics = {};
    const units = extractTranslationUnits(chapter, diagnostics);
    const chapterItems = units.map((unit) => ({
      key: unit.key,
      kind: unit.kind,
      mode: unit.mode || "complex",
      modeReasons: unit.modeReasons || [],
      sourceText: unit.sourceText,
      sourceNodeIds: unit.sourceNodeIds,
      chapter: unit.chapter,
      blockNodeId: unit.blockNodeId,
      segmentMap: unit.segmentMap,
      text: unit.sourceText,
    }));
    allItems.push(...chapterItems);

    rollup.blockCandidates += diagnostics.blockCandidates || 0;
    rollup.producedUnits += diagnostics.producedUnits || 0;
    rollup.simpleUnits += diagnostics.simpleUnits || 0;
    rollup.complexUnits += diagnostics.complexUnits || 0;
    for (const [reason, count] of Object.entries(diagnostics.skippedReasons || {})) {
      rollup.skippedReasons[reason] = (rollup.skippedReasons[reason] || 0) + count;
    }

    const reasonText = Object.entries(diagnostics.skippedReasons || {})
      .map(([reason, count]) => `${reason}=${count}`)
      .join(", ") || "none";
    console.log(
      `[EPUB识别] ${chapter.entryName}: candidates=${diagnostics.blockCandidates || 0}, units=${diagnostics.producedUnits || 0}, simple=${diagnostics.simpleUnits || 0}, complex=${diagnostics.complexUnits || 0}, skipped=${reasonText}`,
    );
  }

  const totalReasonText = Object.entries(rollup.skippedReasons)
    .map(([reason, count]) => `${reason}=${count}`)
    .join(", ") || "none";
  console.log(
    `[EPUB识别汇总] candidates=${rollup.blockCandidates}, units=${rollup.producedUnits}, simple=${rollup.simpleUnits}, complex=${rollup.complexUnits}, skipped=${totalReasonText}`,
  );

  return allItems;
}

export function applyEpubTranslations(epubDoc, items, translationMap) {
  const unitsByChapter = new Map();
  for (const item of items) {
    const bucket = unitsByChapter.get(item.chapter) || [];
    bucket.push(item);
    unitsByChapter.set(item.chapter, bucket);
  }

  const rollup = {
    totalUnits: 0,
    appliedUnits: 0,
    skippedMissingTranslation: 0,
    skippedInvalidPlaceholder: 0,
  };

  epubDoc.chapters.forEach((chapter) => {
    const diagnostics = {};
    applyTranslationUnits(chapter, translationMap, unitsByChapter.get(chapter.entryName) || [], diagnostics);
    rollup.totalUnits += diagnostics.totalUnits || 0;
    rollup.appliedUnits += diagnostics.appliedUnits || 0;
    rollup.skippedMissingTranslation += diagnostics.skippedMissingTranslation || 0;
    rollup.skippedInvalidPlaceholder += diagnostics.skippedInvalidPlaceholder || 0;

    console.log(
      `[EPUB回填] ${chapter.entryName}: total=${diagnostics.totalUnits || 0}, applied=${diagnostics.appliedUnits || 0}, missing=${diagnostics.skippedMissingTranslation || 0}, placeholder=${diagnostics.skippedInvalidPlaceholder || 0}`,
    );
  });
  console.log(
    `[EPUB回填汇总] total=${rollup.totalUnits}, applied=${rollup.appliedUnits}, missing=${rollup.skippedMissingTranslation}, placeholder=${rollup.skippedInvalidPlaceholder}`,
  );

  return epubDoc;
}

export function buildEpubTranslationCodecs() {
  function extractFirstJsonObject(raw) {
    const fenced = String(raw || "").replace(/```json|```/gi, "").trim();
    const match = fenced.match(/\{[\s\S]*\}/);
    return (match ? match[0] : fenced).trim();
  }

  function normalizeJsonText(raw) {
    return String(raw || "")
      .replace(/[“”]/g, "\"")
      .replace(/[‘’]/g, "'")
      .replace(/,\s*([}\]])/g, "$1");
  }

  function parseSegmentPayloadLenient(raw) {
    const candidate = normalizeJsonText(extractFirstJsonObject(raw));
    return JSON.parse(candidate);
  }

  function serializeSegmentItem(item) {
    if (item?.mode === "simple") {
      return String(item?.sourceText ?? item?.text ?? "");
    }
    return String(item?.sourceText ?? item?.text ?? "");
  }

  function deserializeSegmentTranslation(item, rowOrTranslation, rawFallback = "") {
    if (item?.mode === "simple") {
      const value = typeof rowOrTranslation === "string"
        ? String(rowOrTranslation || "").trim()
        : String(rowOrTranslation?.translation ?? rawFallback ?? "").trim();
      if (!value) {
        throw new Error(`EPUB simple-block translation is empty for item ${item?.key || "<unknown>"}.`);
      }
      return value;
    }

    const expectedSids = Array.isArray(item?.segmentMap)
      ? item.segmentMap.map((mapping) => String(mapping?.sid || "").trim()).filter(Boolean)
      : [];
    const expectedSegments = parseExpectedSegments(item?.sourceText);
    if (expectedSids.length === 0) {
      throw new Error(`Missing segment map for item ${item?.key || "<unknown>"}.`);
    }

    let parsed = null;
    try {
      if (rowOrTranslation && typeof rowOrTranslation === "object" && Array.isArray(rowOrTranslation.segments)) {
        parsed = rowOrTranslation;
      } else {
        const raw = typeof rowOrTranslation === "string"
          ? rowOrTranslation
          : String(rowOrTranslation?.translation ?? rawFallback ?? "");
        parsed = parseSegmentPayloadLenient(raw);
      }
    } catch {
      throw new Error(`EPUB translation invalid JSON for item ${item?.key || "<unknown>"}.`);
    }

    const translatedSegments = Array.isArray(parsed?.segments) ? parsed.segments : [];
    const normalizedActualSegments = translatedSegments.map((segment) => ({
      sid: String(segment?.sid || "").trim(),
      text: String(segment?.text ?? ""),
    }));
    if (translatedSegments.length === 0) {
      void dumpEpubFailureDebug({
        item,
        expectedSegments,
        actualSegments: normalizedActualSegments,
        errorType: "invalid-placeholder-empty-segments",
      });
      throw new Error(`EPUB translation segments missing/empty for item ${item?.key || "<unknown>"}.`);
    }
    const translatedBySid = new Map();
    const duplicateSids = [];
    const unexpectedSids = [];
    const expectedSidSet = new Set(expectedSids);
    for (const segment of translatedSegments) {
      const sid = String(segment?.sid || "").trim();
      if (!sid) {
        void dumpEpubFailureDebug({
          item,
          expectedSegments,
          actualSegments: normalizedActualSegments,
          errorType: "invalid-placeholder",
        });
        throw new Error(`EPUB translation has empty sid for item ${item?.key || "<unknown>"}.`);
      }
      if (!expectedSidSet.has(sid)) {
        unexpectedSids.push(sid);
        continue;
      }
      if (translatedBySid.has(sid)) {
        duplicateSids.push(sid);
        continue;
      }
      translatedBySid.set(sid, String(segment?.text ?? ""));
    }

    if (duplicateSids.length > 0) {
      void dumpEpubFailureDebug({
        item,
        expectedSegments,
        actualSegments: normalizedActualSegments,
        errorType: "segment-mismatch-duplicate",
      });
      throw new Error(
        `EPUB translation sid duplicate for item ${item?.key || "<unknown>"}: ${[...new Set(duplicateSids)].join(", ")}`,
      );
    }
    if (unexpectedSids.length > 0) {
      void dumpEpubFailureDebug({
        item,
        expectedSegments,
        actualSegments: normalizedActualSegments,
        errorType: "segment-mismatch-unexpected",
      });
      throw new Error(
        `EPUB translation sid mismatch for item ${item?.key || "<unknown>"}: unexpected ${[...new Set(unexpectedSids)].join(", ")}`,
      );
    }
    const missingSids = expectedSids.filter((sid) => !translatedBySid.has(sid));
    if (missingSids.length > 0) {
      void dumpEpubFailureDebug({
        item,
        expectedSegments,
        actualSegments: normalizedActualSegments,
        errorType: "sid-missing",
      });
      const missingError = new Error(
        `EPUB translation sid missing for item ${item?.key || "<unknown>"}: ${missingSids.join(", ")}`,
      );
      missingError.name = "EpubSidMissingError";
      missingError.missingSids = missingSids;
      missingError.expectedSids = expectedSids;
      missingError.partialSegments = Array.from(translatedBySid.entries()).map(([sid, text]) => ({ sid, text }));
      throw missingError;
    }

    const normalized = {
      segments: expectedSids.map((sid) => ({
        sid,
        text: translatedBySid.get(sid),
      })),
    };
    return JSON.stringify(normalized);
  }

  return {
    serializeItem: serializeSegmentItem,
    deserializeTranslation: deserializeSegmentTranslation,
  };
}

function evaluateSplitDecision(item, {
  maxSegments = EPUB_SPLIT_THRESHOLD,
  maxChars = EPUB_SPLIT_CHAR_THRESHOLD,
  aggressiveComplexSplit = true,
} = {}) {
  if (!item) {
    return { shouldSplit: false, reason: "invalid-item", segmentCount: 0, sourceChars: 0 };
  }
  if (item.mode === "simple") {
    return { shouldSplit: false, reason: "simple", segmentCount: 0, sourceChars: 0 };
  }
  const segmentCount = Array.isArray(item.segmentMap) ? item.segmentMap.length : 0;
  const sourceChars = String(item.sourceText || "").length;
  if (segmentCount > maxSegments) {
    return { shouldSplit: true, reason: "segments", segmentCount, sourceChars };
  }
  if (sourceChars > maxChars) {
    return { shouldSplit: true, reason: "chars", segmentCount, sourceChars };
  }
  if (aggressiveComplexSplit && Array.isArray(item.modeReasons)
    && item.modeReasons.includes("inline-complexity-high") && segmentCount > 6) {
    return { shouldSplit: true, reason: "complexity", segmentCount, sourceChars };
  }
  return { shouldSplit: false, reason: "below-threshold", segmentCount, sourceChars };
}

export function splitSegmentItem(item, splitOptions = {}) {
  const chunkSize = Number(splitOptions.chunkSize ?? EPUB_SPLIT_CHUNK_SIZE);
  const splitDecision = evaluateSplitDecision(item, splitOptions);
  if (!splitDecision.shouldSplit) {
    return [item];
  }

  let payload;
  try {
    payload = JSON.parse(String(item.sourceText || "{}"));
  } catch {
    return [item];
  }
  const segments = Array.isArray(payload?.segments) ? payload.segments : [];
  if (segments.length !== item.segmentMap.length) return [item];

  const safeChunkSize = Math.max(2, chunkSize);
  const totalParts = Math.ceil(item.segmentMap.length / safeChunkSize);
  const splitItems = [];

  for (let start = 0; start < item.segmentMap.length; start += safeChunkSize) {
    const end = Math.min(start + safeChunkSize, item.segmentMap.length);
    const splitIndex = Math.floor(start / safeChunkSize);
    const segmentSlice = item.segmentMap.slice(start, end);
    const payloadSlice = segments.slice(start, end);
    splitItems.push({
      ...item,
      key: `${item.key}::part${splitIndex + 1}`,
      parentKey: item.key,
      splitIndex,
      splitTotal: totalParts,
      segmentMap: segmentSlice,
      sourceText: JSON.stringify({ segments: payloadSlice }),
      text: JSON.stringify({ segments: payloadSlice }),
      sourceNodeIds: segmentSlice.flatMap((mapping) => (
        Array.isArray(mapping.nodeIds) ? mapping.nodeIds : (mapping.nodeId ? [mapping.nodeId] : [])
      )),
    });
  }

  return splitItems;
}

export async function translateEpubItems(items, cachePath, langOptions, options = {}) {
  const splitOptions = options.splitOptions || {};
  let missingSegmentsRepairPrompt = null;
  let repairClient = null;
  async function repairMissingSegments(item, lastError) {
    const missingSids = Array.isArray(lastError?.missingSids) ? lastError.missingSids : [];
    if (missingSids.length === 0) return "";
    if (!repairClient) {
      if (!CONFIG.provider?.apiKey) return "";
      repairClient = new OpenAI({
        apiKey: CONFIG.provider.apiKey,
        baseURL: CONFIG.provider.baseURL,
      });
    }
    if (!missingSegmentsRepairPrompt) {
      missingSegmentsRepairPrompt = await fs.readFile(EPUB_MISSING_SEGMENTS_PROMPT_PATH, "utf8");
    }

    let sourcePayload = null;
    try {
      sourcePayload = JSON.parse(String(item?.sourceText || "{}"));
    } catch {
      return "";
    }
    const sourceSegments = Array.isArray(sourcePayload?.segments) ? sourcePayload.segments : [];
    const sourceBySid = new Map(sourceSegments.map((segment) => [String(segment?.sid || "").trim(), String(segment?.text ?? "")]));
    const missingSegments = missingSids
      .map((sid) => ({ sid, text: sourceBySid.get(sid) || "" }))
      .filter((segment) => segment.sid);
    if (missingSegments.length === 0) return "";

    const systemPrompt = missingSegmentsRepairPrompt
      .replaceAll("{{TARGET_LANGUAGE}}", languageLabel(langOptions.to))
      .replaceAll("{{MISSING_SEGMENTS_JSON}}", JSON.stringify({ segments: missingSegments }, null, 2));
    const completion = await repairClient.chat.completions.create({
      model: CONFIG.provider.model,
      temperature: 0.1,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify({ segments: missingSegments }) },
      ],
    });
    const raw = String(completion.choices?.[0]?.message?.content || "").trim();
    const jsonText = (raw.match(/\{[\s\S]*\}/) || [raw])[0];
    const repaired = JSON.parse(jsonText);
    const repairedSegments = Array.isArray(repaired?.segments) ? repaired.segments : [];
    const mergedBySid = new Map(
      (Array.isArray(lastError?.partialSegments) ? lastError.partialSegments : [])
        .map((segment) => [String(segment?.sid || "").trim(), String(segment?.text ?? "")]),
    );
    for (const segment of repairedSegments) {
      const sid = String(segment?.sid || "").trim();
      if (!sid || !missingSids.includes(sid)) continue;
      mergedBySid.set(sid, String(segment?.text ?? ""));
    }
    const expectedSids = Array.isArray(item?.segmentMap)
      ? item.segmentMap.map((segment) => String(segment?.sid || "").trim()).filter(Boolean)
      : [];
    if (expectedSids.some((sid) => !mergedBySid.has(sid))) {
      return "";
    }
    return JSON.stringify({
      segments: expectedSids.map((sid) => ({ sid, text: mergedBySid.get(sid) || "" })),
    });
  }
  const splitStats = {
    total: items.length,
    split: 0,
    keptSimple: 0,
    keptStructured: 0,
    reasons: { segments: 0, chars: 0, complexity: 0 },
  };
  function mergeSplitTranslations(_originalItem, splitNodeResults = []) {
    const mergedSegments = [];
    for (const node of splitNodeResults) {
      const parsed = JSON.parse(String(node?.translation || "{}"));
      const segments = Array.isArray(parsed?.segments) ? parsed.segments : [];
      if (segments.length === 0) {
        throw new Error(`Split part produced empty/invalid segments for item ${node?.id || "<unknown>"}.`);
      }
      mergedSegments.push(...segments);
    }
    if (mergedSegments.length === 0) {
      throw new Error("Split merge produced empty segments.");
    }
    return JSON.stringify({ segments: mergedSegments });
  }

  const expandedItems = [];
  for (const item of items) {
    const decision = evaluateSplitDecision(item, splitOptions);
    if (item?.mode === "simple") {
      splitStats.keptSimple += 1;
    } else if (decision.shouldSplit) {
      splitStats.split += 1;
      splitStats.reasons[decision.reason] = (splitStats.reasons[decision.reason] || 0) + 1;
    } else {
      splitStats.keptStructured += 1;
    }
    expandedItems.push(...splitSegmentItem(item, splitOptions));
  }
  const expandedBy = expandedItems.length - items.length;
  console.log(
    `[EPUB拆分] total=${splitStats.total}, split=${splitStats.split}, keptSimple=${splitStats.keptSimple}, keptStructured=${splitStats.keptStructured}, reasons=segments:${splitStats.reasons.segments},chars:${splitStats.reasons.chars},complexity:${splitStats.reasons.complexity}, expandedBy=${expandedBy}`,
  );
  if (options.runSummary) {
    options.runSummary.epubSplitStats = {
      ...splitStats,
      expandedItems: expandedItems.length,
    };
  }
  const splitMap = await translateAll(expandedItems, cachePath, langOptions, {
    promptPath: DEFAULT_EPUB_PROMPT_PATH,
    persistNodeResults: true,
    returnNodeResults: false,
    enableRepair: false,
    ...buildEpubTranslationCodecs(),
    repairMissingSegments: options.repairMissingSegments || repairMissingSegments,
    splitItemForRetry: (item) => splitSegmentItem(item, splitOptions),
    mergeSplitTranslations,
    ...options,
  });

  const merged = {};
  const splitBuckets = new Map();
  for (const item of expandedItems) {
    const translated = splitMap[item.key];
    if (!item.parentKey) {
      merged[item.key] = translated;
      continue;
    }
    const bucket = splitBuckets.get(item.parentKey) || [];
    bucket.push({ splitIndex: item.splitIndex, value: translated });
    splitBuckets.set(item.parentKey, bucket);
  }

  for (const [parentKey, parts] of splitBuckets.entries()) {
    const ordered = parts.sort((a, b) => a.splitIndex - b.splitIndex);
    const mergedSegments = [];
    for (const part of ordered) {
      try {
        const parsed = JSON.parse(String(part.value || "{}"));
        const segments = Array.isArray(parsed?.segments) ? parsed.segments : [];
        mergedSegments.push(...segments);
      } catch {
        // keep processing other parts
      }
    }
    merged[parentKey] = JSON.stringify({ segments: mergedSegments });
  }

  return merged;
}
