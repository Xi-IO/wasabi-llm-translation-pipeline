const BLOCK_TAGS = new Set([
  "h1", "h2", "h3", "h4", "h5", "h6",
  "p", "li", "blockquote", "div", "section", "article",
  "figcaption", "caption", "td", "th", "dt", "dd",
]);
const NEVER_TRANSLATE_TAGS = new Set(["script", "style", "code", "pre"]);

const TOKEN_OPEN = "[[[";
const TOKEN_CLOSE = "]]]";

function buildOpenToken(token) {
  return `${TOKEN_OPEN}${token}${TOKEN_CLOSE}`;
}

function buildCloseToken(token) {
  return `${TOKEN_OPEN}/${token}${TOKEN_CLOSE}`;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findPlaceholder(text, token, startIndex, isClose = false) {
  const slashPart = isClose ? "\\/\\s*" : "";
  const pattern = new RegExp(`\\[\\[\\[\\s*${slashPart}${escapeRegExp(token)}\\s*\\]\\]\\]`, "g");
  pattern.lastIndex = startIndex;
  const match = pattern.exec(text);
  if (!match) return null;
  return { index: match.index, end: match.index + match[0].length };
}

function normalizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function isElement(node) {
  return node?.type === "element";
}

function collectNodeIndex(root) {
  const index = new Map();
  function walk(node) {
    index.set(node.id, node);
    for (const child of node.children || []) walk(child);
  }
  walk(root);
  return index;
}

function incrementReason(reasons, reason) {
  reasons[reason] = (reasons[reason] || 0) + 1;
}

function hasNestedBlockStructure(blockNode) {
  function walk(node, isRoot = false) {
    if (node.type !== "element") return false;
    if (NEVER_TRANSLATE_TAGS.has(node.tagName)) return false;
    if (!isRoot && BLOCK_TAGS.has(node.tagName)) return true;
    return (node.children || []).some((child) => walk(child, false));
  }
  return (blockNode.children || []).some((child) => walk(child, false));
}

function collectTextNodes(blockNode) {
  const textNodes = [];
  function walk(node, parent = null, siblingIndex = 0) {
    if (node.type === "element" && NEVER_TRANSLATE_TAGS.has(node.tagName)) return;
    if (node.type === "text") {
      if (normalizeText(node.text)) {
        textNodes.push({
          id: node.id,
          text: node.text || "",
          parentId: parent?.id || null,
          siblingIndex,
        });
      }
      return;
    }
    (node.children || []).forEach((child, idx) => walk(child, node, idx));
  }
  (blockNode.children || []).forEach((child, idx) => walk(child, blockNode, idx));
  return textNodes;
}

function isShortToken(text) {
  return normalizeText(text).length > 0 && normalizeText(text).length < 3;
}

function isInlineSymbolToken(text) {
  const trimmed = normalizeText(text);
  if (!trimmed) return false;
  return /^[\p{P}\p{S}]+$/u.test(trimmed);
}

function shouldMergeSegment(prev, current) {
  if (!prev || !current) return false;
  if (!prev.parentId || prev.parentId !== current.parentId) return false;

  const adjacentSibling = typeof prev.lastSiblingIndex === "number"
    && typeof current.siblingIndex === "number"
    && current.siblingIndex === prev.lastSiblingIndex + 1;

  if (adjacentSibling) return true;

  const prevText = prev.text;
  const currentText = current.text;
  return isShortToken(prevText) || isShortToken(currentText) || isInlineSymbolToken(prevText) || isInlineSymbolToken(currentText);
}

function buildSegmentPayload(textNodes) {
  const segmentMap = [];
  const grouped = [];
  for (const node of textNodes) {
    const prev = grouped[grouped.length - 1];
    if (shouldMergeSegment(prev, node)) {
      prev.text += node.text;
      prev.nodeIds.push(node.id);
      prev.lastSiblingIndex = node.siblingIndex;
      continue;
    }
    grouped.push({
      parentId: node.parentId,
      lastSiblingIndex: node.siblingIndex,
      nodeIds: [node.id],
      text: node.text,
    });
  }

  const segments = grouped.map((group, idx) => {
    const sid = `S${idx}`;
    segmentMap.push({ sid, nodeIds: group.nodeIds });
    return { sid, text: group.text || "" };
  });

  return {
    segmentPayload: { segments },
    segmentMap,
  };
}

function parseSegmentTranslationPayload(value) {
  if (!value) return null;

  const parsed = typeof value === "string"
    ? JSON.parse((String(value).match(/\{[\s\S]*\}/) || [])[0] || value)
    : value;

  const segments = Array.isArray(parsed?.segments) ? parsed.segments : null;
  if (!segments) return null;

  const bySid = new Map();
  for (const segment of segments) {
    const sid = String(segment?.sid || "").trim();
    const text = String(segment?.text ?? "");
    if (!sid) return null;
    bySid.set(sid, text);
  }

  return bySid;
}

export function extractTranslationUnits(chapter, diagnostics = null) {
  const units = [];
  const stats = {
    chapter: chapter.entryName,
    blockCandidates: 0,
    producedUnits: 0,
    skippedReasons: {},
  };

  function walk(node) {
    if (!isElement(node)) {
      for (const child of node.children || []) walk(child);
      return;
    }

    if (BLOCK_TAGS.has(node.tagName)) {
      stats.blockCandidates += 1;
      if (!hasNestedBlockStructure(node)) {
        const textNodes = collectTextNodes(node);
        if (textNodes.length > 0) {
          const { segmentPayload, segmentMap } = buildSegmentPayload(textNodes);
          units.push({
            key: `${chapter.entryName}::${node.id}`,
            kind: node.tagName,
            sourceText: JSON.stringify(segmentPayload),
            sourceNodeIds: textNodes.map((textNode) => textNode.id),
            chapter: chapter.entryName,
            blockNodeId: node.id,
            segmentMap,
          });
          stats.producedUnits += 1;
        } else {
          incrementReason(stats.skippedReasons, "empty-text");
        }
      } else {
        incrementReason(stats.skippedReasons, "nested-block-structure");
        for (const child of node.children || []) walk(child);
      }
      return;
    }

    if (NEVER_TRANSLATE_TAGS.has(node.tagName)) return;
    for (const child of node.children || []) walk(child);
  }

  walk(chapter.document);
  if (diagnostics && typeof diagnostics === "object") {
    diagnostics.chapter = stats.chapter;
    diagnostics.blockCandidates = stats.blockCandidates;
    diagnostics.producedUnits = stats.producedUnits;
    diagnostics.skippedReasons = { ...stats.skippedReasons };
  }
  return units;
}

export function applyTranslationUnits(chapter, translationMap, chapterUnits = [], diagnostics = null) {
  const nodeIndex = collectNodeIndex(chapter.document);
  const stats = {
    chapter: chapter.entryName,
    totalUnits: chapterUnits.length,
    appliedUnits: 0,
    skippedMissingTranslation: 0,
    skippedInvalidPlaceholder: 0,
  };

  for (const unit of chapterUnits) {
    const translated = translationMap[unit.key];
    if (!translated) {
      stats.skippedMissingTranslation += 1;
      continue;
    }

    const segmentsBySid = (() => {
      try {
        return parseSegmentTranslationPayload(translated);
      } catch {
        return null;
      }
    })();

    if (!segmentsBySid || !Array.isArray(unit.segmentMap) || unit.segmentMap.length === 0) {
      stats.skippedInvalidPlaceholder += 1;
      continue;
    }

    let missingSid = false;
    for (const mapping of unit.segmentMap) {
      if (!segmentsBySid.has(mapping.sid)) {
        missingSid = true;
        break;
      }
    }
    if (missingSid) {
      stats.skippedInvalidPlaceholder += 1;
      continue;
    }

    for (const mapping of unit.segmentMap) {
      const nodeIds = Array.isArray(mapping.nodeIds)
        ? mapping.nodeIds
        : (mapping.nodeId ? [mapping.nodeId] : []);
      if (nodeIds.length === 0) continue;
      const translatedText = segmentsBySid.get(mapping.sid);
      const firstNode = nodeIndex.get(nodeIds[0]);
      if (firstNode?.type === "text") {
        firstNode.text = translatedText;
      }
      for (const nodeId of nodeIds.slice(1)) {
        const textNode = nodeIndex.get(nodeId);
        if (textNode?.type === "text") {
          textNode.text = "";
        }
      }
    }
    stats.appliedUnits += 1;
  }

  if (diagnostics && typeof diagnostics === "object") {
    diagnostics.chapter = stats.chapter;
    diagnostics.totalUnits = stats.totalUnits;
    diagnostics.appliedUnits = stats.appliedUnits;
    diagnostics.skippedMissingTranslation = stats.skippedMissingTranslation;
    diagnostics.skippedInvalidPlaceholder = stats.skippedInvalidPlaceholder;
  }

  return chapter;
}
