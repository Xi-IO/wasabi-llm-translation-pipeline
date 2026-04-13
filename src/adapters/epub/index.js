import { DEFAULT_EPUB_PROMPT_PATH, translateAll } from "../../core/translation.js";
import { extractTranslationUnits, applyTranslationUnits } from "../../epub/translation-units.js";

const EPUB_SPLIT_THRESHOLD = 8;
const EPUB_SPLIT_CHUNK_SIZE = 6;
const EPUB_SPLIT_CHAR_THRESHOLD = 1200;

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

    const sourcePayload = JSON.parse(String(item?.sourceText || "{}"));
    const sourceSegments = Array.isArray(sourcePayload?.segments) ? sourcePayload.segments : [];
    const sourceBySid = new Map(
      sourceSegments.map((segment) => [String(segment?.sid || "").trim(), String(segment?.text ?? "")]),
    );
    const expectedSids = Array.isArray(item?.segmentMap)
      ? item.segmentMap.map((mapping) => String(mapping?.sid || "").trim()).filter(Boolean)
      : [];
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
    const translatedBySid = new Map();
    for (const segment of translatedSegments) {
      const sid = String(segment?.sid || "").trim();
      if (!sid) continue;
      translatedBySid.set(sid, String(segment?.text ?? ""));
    }

    const missingSids = expectedSids.filter((sid) => !translatedBySid.has(sid));
    if (missingSids.length > 3) {
      throw new Error(
        `EPUB translation missing ${missingSids.length} sid(s) for item ${item?.key || "<unknown>"}: ${missingSids.join(", ")}`,
      );
    }
    if (missingSids.length > 0) {
      console.warn(
        `[EPUB编解码] sid缺失(${missingSids.length})，仅补齐缺失段: ${item?.key || "<unknown>"} ${missingSids.join(", ")}`,
      );
    }

    const normalized = {
      segments: expectedSids.map((sid) => ({
        sid,
        text: translatedBySid.has(sid) ? translatedBySid.get(sid) : (sourceBySid.get(sid) || ""),
      })),
    };
    return JSON.stringify(normalized);
  }

  return {
    serializeItem: serializeSegmentItem,
    deserializeTranslation: deserializeSegmentTranslation,
  };
}

function shouldSplitStructuredItem(item, {
  maxSegments = EPUB_SPLIT_THRESHOLD,
  maxChars = EPUB_SPLIT_CHAR_THRESHOLD,
  aggressiveComplexSplit = true,
} = {}) {
  if (!item || item.mode === "simple") return false;
  const segmentCount = Array.isArray(item.segmentMap) ? item.segmentMap.length : 0;
  const sourceChars = String(item.sourceText || "").length;
  if (segmentCount > maxSegments) return true;
  if (sourceChars > maxChars) return true;
  if (aggressiveComplexSplit && Array.isArray(item.modeReasons)
    && item.modeReasons.includes("inline-complexity-high") && segmentCount > 6) {
    return true;
  }
  return false;
}

export function splitSegmentItem(item, splitOptions = {}) {
  const chunkSize = Number(splitOptions.chunkSize ?? EPUB_SPLIT_CHUNK_SIZE);
  if (!shouldSplitStructuredItem(item, splitOptions)) {
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

  const expandedItems = items.flatMap((item) => splitSegmentItem(item, splitOptions));
  const splitMap = await translateAll(expandedItems, cachePath, langOptions, {
    promptPath: DEFAULT_EPUB_PROMPT_PATH,
    persistNodeResults: true,
    returnNodeResults: false,
    enableRepair: false,
    ...buildEpubTranslationCodecs(),
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
