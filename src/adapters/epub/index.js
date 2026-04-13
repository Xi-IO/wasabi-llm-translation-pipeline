import { DEFAULT_EPUB_PROMPT_PATH, translateAll } from "../../core/translation.js";
import { extractTranslationUnits, applyTranslationUnits } from "../../epub/translation-units.js";

const EPUB_SPLIT_THRESHOLD = 8;
const EPUB_SPLIT_CHUNK_SIZE = 6;

export function extractEpubItems(epubDoc) {
  const allItems = [];
  const rollup = {
    blockCandidates: 0,
    producedUnits: 0,
    skippedReasons: {},
  };

  for (const chapter of epubDoc.chapters) {
    const diagnostics = {};
    const units = extractTranslationUnits(chapter, diagnostics);
    const chapterItems = units.map((unit) => ({
      key: unit.key,
      kind: unit.kind,
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
    for (const [reason, count] of Object.entries(diagnostics.skippedReasons || {})) {
      rollup.skippedReasons[reason] = (rollup.skippedReasons[reason] || 0) + count;
    }

    const reasonText = Object.entries(diagnostics.skippedReasons || {})
      .map(([reason, count]) => `${reason}=${count}`)
      .join(", ") || "none";
    console.log(
      `[EPUB识别] ${chapter.entryName}: candidates=${diagnostics.blockCandidates || 0}, units=${diagnostics.producedUnits || 0}, skipped=${reasonText}`,
    );
  }

  const totalReasonText = Object.entries(rollup.skippedReasons)
    .map(([reason, count]) => `${reason}=${count}`)
    .join(", ") || "none";
  console.log(
    `[EPUB识别汇总] candidates=${rollup.blockCandidates}, units=${rollup.producedUnits}, skipped=${totalReasonText}`,
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
  function serializeSegmentItem(item) {
    return String(item?.sourceText ?? item?.text ?? "");
  }

  function deserializeSegmentTranslation(item, translation) {
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
      parsed = JSON.parse((String(translation || "").match(/\{[\s\S]*\}/) || [])[0] || translation);
    } catch {
      console.warn(`[EPUB编解码] 非法JSON，回退原文分段: ${item?.key || "<unknown>"}`);
      return serializeSegmentItem(item);
    }

    const translatedSegments = Array.isArray(parsed?.segments) ? parsed.segments : [];
    const translatedBySid = new Map();
    for (const segment of translatedSegments) {
      const sid = String(segment?.sid || "").trim();
      if (!sid) continue;
      translatedBySid.set(sid, String(segment?.text ?? ""));
    }

    const normalized = {
      segments: expectedSids.map((sid) => ({
        sid,
        text: translatedBySid.has(sid) ? translatedBySid.get(sid) : (sourceBySid.get(sid) || ""),
      })),
    };

    if (translatedBySid.size !== expectedSids.length) {
      console.warn(
        `[EPUB编解码] sid不完整，已按原sid补齐: ${item?.key || "<unknown>"} expected=${expectedSids.length} got=${translatedBySid.size}`,
      );
    }
    return JSON.stringify(normalized);
  }

  return {
    serializeItem: serializeSegmentItem,
    deserializeTranslation: deserializeSegmentTranslation,
  };
}

export function splitSegmentItem(item, chunkSize = EPUB_SPLIT_CHUNK_SIZE) {
  if (!Array.isArray(item?.segmentMap) || item.segmentMap.length <= EPUB_SPLIT_THRESHOLD) {
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

  const totalParts = Math.ceil(item.segmentMap.length / chunkSize);
  const splitItems = [];

  for (let start = 0; start < item.segmentMap.length; start += chunkSize) {
    const end = Math.min(start + chunkSize, item.segmentMap.length);
    const splitIndex = Math.floor(start / chunkSize);
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
  const expandedItems = items.flatMap((item) => splitSegmentItem(item));
  const splitMap = await translateAll(expandedItems, cachePath, langOptions, {
    promptPath: DEFAULT_EPUB_PROMPT_PATH,
    persistNodeResults: true,
    returnNodeResults: false,
    enableRepair: false,
    ...buildEpubTranslationCodecs(),
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
