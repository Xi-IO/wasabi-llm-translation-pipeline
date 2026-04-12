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

  for (const placeholder of placeholderMap) {
    const open = buildOpenToken(placeholder.token);
    const close = buildCloseToken(placeholder.token);

    const openIdx = text.indexOf(open, cursor);
    if (openIdx === -1) return null;
    if (text.slice(cursor, openIdx).trim()) return null;

    const contentStart = openIdx + open.length;
    const closeIdx = text.indexOf(close, contentStart);
    if (closeIdx === -1) return null;

    segments.set(placeholder.nodeId, text.slice(contentStart, closeIdx));
    cursor = closeIdx + close.length;
  }

  if (text.slice(cursor).trim()) return null;
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

export function applyTranslationUnits(chapter, translationMap, chapterUnits = []) {
  const nodeIndex = collectNodeIndex(chapter.document);

  for (const unit of chapterUnits) {
    const translated = translationMap[unit.key];
    if (!translated) continue;
    if (!Array.isArray(unit.placeholderMap) || unit.placeholderMap.length === 0) continue;

    const segments = extractSegmentsByPlaceholders(String(translated), unit.placeholderMap);
    if (!segments) continue;

    for (const placeholder of unit.placeholderMap) {
      const textNode = nodeIndex.get(placeholder.nodeId);
      if (textNode?.type === "text") {
        textNode.text = segments.get(placeholder.nodeId) ?? textNode.text;
      }
    }
  }

  return chapter;
}
