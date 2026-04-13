const BLOCK_TAGS = new Set([
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "li",
  "blockquote",
  "div",
  "section",
  "article",
  "figcaption",
  "caption",
  "td",
  "th",
  "dt",
  "dd",
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

  function walk(node) {
    if (node.type === "element" && NEVER_TRANSLATE_TAGS.has(node.tagName)) return;

    if (node.type === "text") {
      if (normalizeText(node.text)) textNodes.push(node);
      return;
    }

    for (const child of node.children || []) walk(child);
  }

  for (const child of blockNode.children || []) walk(child);
  return textNodes;
}

function buildProtectedText(textNodes) {
  const placeholderMap = [];
  const chunks = [];

  textNodes.forEach((node, idx) => {
    const token = `T${idx}`;
    placeholderMap.push({ token, nodeId: node.id });
    chunks.push(`${buildOpenToken(token)}${node.text || ""}${buildCloseToken(token)}`);
  });

  return {
    protectedSourceText: chunks.join(""),
    placeholderMap,
  };
}

function extractSegmentsByPlaceholders(text, placeholderMap) {
  let cursor = 0;
  const segments = new Map();
  let previousNodeId = null;

  for (const placeholder of placeholderMap) {
    const open = findPlaceholder(text, placeholder.token, cursor, false);
    if (!open) return null;

    const interstitial = text.slice(cursor, open.index);
    if (previousNodeId) {
      segments.set(previousNodeId, `${segments.get(previousNodeId) || ""}${interstitial}`);
    }

    const close = findPlaceholder(text, placeholder.token, open.end, true);
    if (!close) return null;

    const current = text.slice(open.end, close.index);
    segments.set(placeholder.nodeId, current);
    previousNodeId = placeholder.nodeId;
    cursor = close.end;
  }

  if (previousNodeId) {
    segments.set(previousNodeId, `${segments.get(previousNodeId) || ""}${text.slice(cursor)}`);
  }

  if (segments.size !== placeholderMap.length) return null;
  return segments;
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
          const { protectedSourceText, placeholderMap } = buildProtectedText(textNodes);
          units.push({
            key: `${chapter.entryName}::${node.id}`,
            kind: node.tagName,
            sourceText: protectedSourceText,
            sourceNodeIds: textNodes.map((textNode) => textNode.id),
            chapter: chapter.entryName,
            blockNodeId: node.id,
            placeholderMap,
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
    if (!Array.isArray(unit.placeholderMap) || unit.placeholderMap.length === 0) {
      stats.skippedInvalidPlaceholder += 1;
      continue;
    }

    const segments = extractSegmentsByPlaceholders(String(translated), unit.placeholderMap);
    if (!segments) {
      stats.skippedInvalidPlaceholder += 1;
      continue;
    }

    for (const placeholder of unit.placeholderMap) {
      const textNode = nodeIndex.get(placeholder.nodeId);
      if (textNode?.type === "text") {
        textNode.text = segments.get(placeholder.nodeId) ?? textNode.text;
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
