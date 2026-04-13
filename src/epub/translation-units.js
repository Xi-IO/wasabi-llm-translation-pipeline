const STRICT_BLOCK_TAGS = new Set([
  "h1", "h2", "h3", "h4", "h5", "h6",
  "p", "li", "blockquote",
  "figcaption", "caption",
]);
const RELAXED_BLOCK_TAGS = new Set([
  "div", "section", "article", "td", "th", "dt", "dd",
]);
const BLOCK_TAGS = new Set([...STRICT_BLOCK_TAGS, ...RELAXED_BLOCK_TAGS]);
const NEVER_TRANSLATE_TAGS = new Set(["script", "style", "code", "pre"]);
const WRAPPER_TAGS = new Set(["span", "font"]);
const INLINE_EMPHASIS_TAGS = new Set(["i", "em", "strong", "b"]);
const HEAVY_INLINE_TAGS = new Set(["a", "code", "math", "ruby", "rt"]);
const FOOTNOTE_CLASS_HINTS = /(footnote|noteref|citation|ref\b)/i;

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

function hasMeaningfulClass(node, context = null) {
  const classAttr = String(node?.attrs?.class || "").trim();
  if (!classAttr) return false;
  const tokens = classAttr.split(/\s+/).filter(Boolean);
  const definedClasses = context?.definedClasses instanceof Set ? context.definedClasses : null;
  if (definedClasses && tokens.some((token) => definedClasses.has(token))) {
    return true;
  }
  return tokens.some((token) => !/^calibre\d*$/i.test(token) && !/^x-?epub/i.test(token));
}

function textContentLength(node) {
  if (!node) return 0;
  if (node.type === "text") return normalizeText(node.text).length;
  return (node.children || []).reduce((sum, child) => sum + textContentLength(child), 0);
}

function isPagebreakElement(node) {
  if (node?.type !== "element") return false;
  const classAttr = String(node.attrs?.class || "").toLowerCase();
  const idAttr = String(node.attrs?.id || "").toLowerCase();
  const epubType = String(node.attrs?.["epub:type"] || node.attrs?.["data-epub-type"] || "").toLowerCase();
  const role = String(node.attrs?.role || "").toLowerCase();
  return classAttr.includes("pagebreak")
    || idAttr.includes("pagebreak")
    || epubType.includes("pagebreak")
    || role.includes("doc-pagebreak");
}

function nodeTextContent(node) {
  if (!node) return "";
  if (node.type === "text") return String(node.text || "");
  return (node.children || []).map((child) => nodeTextContent(child)).join("");
}

function isFootnoteLikeElement(node) {
  if (node?.type !== "element") return false;
  const classAttr = String(node.attrs?.class || "");
  const role = String(node.attrs?.role || "").toLowerCase();
  const epubType = String(node.attrs?.["epub:type"] || node.attrs?.["data-epub-type"] || "").toLowerCase();
  const href = String(node.attrs?.href || "").trim();
  const text = normalizeText(nodeTextContent(node));
  const isNumericMarker = /^[\[(（]?\d{1,4}[\])）]?$/.test(text);
  const isFootnoteAnchor = node.tagName === "a" && href.startsWith("#");
  if (role.includes("doc-noteref") || epubType.includes("noteref")) return true;
  if (FOOTNOTE_CLASS_HINTS.test(classAttr) && isNumericMarker) return true;
  if (isFootnoteAnchor && isNumericMarker) return true;
  return false;
}

function shouldUnwrapWrapper(node, context = null) {
  if (node?.type !== "element" || !WRAPPER_TAGS.has(node.tagName)) return false;
  if (hasMeaningfulClass(node, context)) return false;
  const nodeId = String(node.attrs?.id || "").trim();
  const referencedIds = context?.referencedIds instanceof Set ? context.referencedIds : null;
  if (nodeId && referencedIds?.has(nodeId)) return false;
  if (node.attrs?.lang || node.attrs?.style || node.attrs?.id || node.attrs?.role) return false;
  if (node.attrs?.["epub:type"] || node.attrs?.title) return false;
  return true;
}

function cleanupBlockNode(blockNode, context = null) {
  function clean(node) {
    if (!node || node.type !== "element") return [node];
    const cleanedChildren = (node.children || []).flatMap((child) => clean(child)).filter(Boolean);
    node.children = cleanedChildren;

    if (isPagebreakElement(node) && textContentLength(node) === 0) {
      return [];
    }
    if (shouldUnwrapWrapper(node, context)) {
      return cleanedChildren;
    }
    return [node];
  }

  blockNode.children = (blockNode.children || []).flatMap((child) => clean(child)).filter(Boolean);
}

export function classifyBlockForTranslation(blockNode, textNodes = []) {
  const reasons = [];
  let emphasisCount = 0;
  let heavyInlineCount = 0;
  let supSubCount = 0;
  let supSubLongCount = 0;
  let linkCount = 0;
  let hasPagebreak = false;

  function scan(node) {
    if (!node) return;
    if (node.type === "element") {
      if (INLINE_EMPHASIS_TAGS.has(node.tagName)) emphasisCount += 1;
      if (HEAVY_INLINE_TAGS.has(node.tagName)) heavyInlineCount += 1;
      if (node.tagName === "a") linkCount += 1;
      if (node.tagName === "sup" || node.tagName === "sub") {
        supSubCount += 1;
        const rawText = (node.children || []).map((child) => String(child?.text || "")).join("");
        if (normalizeText(rawText).length > 2) supSubLongCount += 1;
      }
      if (isPagebreakElement(node)) hasPagebreak = true;
    }
    for (const child of node.children || []) scan(child);
  }
  scan(blockNode);

  const inlineComplexityScore = (heavyInlineCount * 3)
    + (Math.max(0, emphasisCount - 2) * 1)
    + (supSubLongCount * 2)
    + (Math.max(0, linkCount - 1) * 2);
  const fragmented = textNodes.length >= 14;
  const avgFragmentLength = textNodes.length > 0
    ? textNodes.reduce((sum, item) => sum + normalizeText(item.text).length, 0) / textNodes.length
    : 0;

  if (supSubCount > 0 && supSubLongCount > 0) reasons.push("has-sup-sub");
  if (hasPagebreak) reasons.push("has-pagebreak");
  if ((emphasisCount > 0 || linkCount > 0) && textNodes.length >= 2) reasons.push("has-inline-structure");
  if (inlineComplexityScore >= 8) reasons.push("inline-complexity-high");
  if (linkCount >= 2 && textNodes.length >= 6) reasons.push("link-rich-inline");
  if (fragmented || (textNodes.length >= 10 && avgFragmentLength <= 10)) reasons.push("fragmented-text-nodes");

  const mode = reasons.some((reason) => (
    reason === "has-inline-structure"
    || reason === "inline-complexity-high"
    || reason === "link-rich-inline"
    || reason === "fragmented-text-nodes"
  )) ? "complex" : "simple";
  return { mode, reasons };
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
  function walk(node, parent = null, siblingIndex = 0, context = { underPagebreak: false, underFootnote: false }) {
    if (node.type === "element" && NEVER_TRANSLATE_TAGS.has(node.tagName)) return;
    if (node.type === "element") {
      const nextContext = {
        underPagebreak: context.underPagebreak || isPagebreakElement(node),
        underFootnote: context.underFootnote || isFootnoteLikeElement(node),
      };
      (node.children || []).forEach((child, idx) => walk(child, node, idx, nextContext));
      return;
    }
    if (node.type === "text") {
      if (!context.underPagebreak && !context.underFootnote && normalizeText(node.text)) {
        textNodes.push({
          id: node.id,
          text: node.text || "",
          parentId: parent?.id || null,
          siblingIndex,
        });
      }
      return;
    }
    (node.children || []).forEach((child, idx) => walk(child, node, idx, context));
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

  const compacted = [];
  for (const group of grouped) {
    const trimmed = normalizeText(group.text);
    const prev = compacted[compacted.length - 1];
    if (trimmed && isInlineSymbolToken(trimmed) && prev && prev.parentId && prev.parentId === group.parentId) {
      prev.text += group.text;
      prev.nodeIds.push(...group.nodeIds);
      prev.lastSiblingIndex = group.lastSiblingIndex;
      continue;
    }
    compacted.push(group);
  }

  const segments = compacted.map((group, idx) => {
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
    simpleUnits: 0,
    complexUnits: 0,
  };

  const cleanupContext = chapter?.preprocessContext || {};

  function isRelaxedBlockAllowed(node, textNodes, classification) {
    if (!RELAXED_BLOCK_TAGS.has(node.tagName)) return true;
    if (textNodes.length === 0) return false;
    if (classification.mode === "complex" && classification.reasons.includes("inline-complexity-high")) {
      return false;
    }
    if (classification.mode === "complex" && textNodes.length > 12) return false;
    return true;
  }

  function walk(node) {
    if (!isElement(node)) {
      for (const child of node.children || []) walk(child);
      return;
    }

    if (BLOCK_TAGS.has(node.tagName)) {
      stats.blockCandidates += 1;
      if (!hasNestedBlockStructure(node)) {
        cleanupBlockNode(node, cleanupContext);
        const textNodes = collectTextNodes(node);
        if (textNodes.length > 0) {
          const classification = classifyBlockForTranslation(node, textNodes);
          if (!isRelaxedBlockAllowed(node, textNodes, classification)) {
            incrementReason(stats.skippedReasons, "relaxed-block-complex");
            return;
          }
          const { segmentPayload, segmentMap } = buildSegmentPayload(textNodes);
          const isSimple = classification.mode === "simple";
          units.push({
            key: `${chapter.entryName}::${node.id}`,
            kind: node.tagName,
            sourceText: isSimple
              ? textNodes.map((textNode) => textNode.text).join("")
              : JSON.stringify(segmentPayload),
            sourceNodeIds: textNodes.map((textNode) => textNode.id),
            chapter: chapter.entryName,
            blockNodeId: node.id,
            segmentMap: isSimple ? [] : segmentMap,
            mode: classification.mode,
            modeReasons: classification.reasons,
          });
          if (classification.mode === "simple") stats.simpleUnits += 1;
          if (classification.mode === "complex") stats.complexUnits += 1;
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
    diagnostics.simpleUnits = stats.simpleUnits;
    diagnostics.complexUnits = stats.complexUnits;
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

    if (unit.mode === "simple") {
      const simpleText = String(translated || "").trim();
      if (!simpleText) {
        stats.skippedInvalidPlaceholder += 1;
        continue;
      }
      if (simpleText.startsWith("{") || simpleText.startsWith("[")) {
        stats.skippedInvalidPlaceholder += 1;
        continue;
      }
      const nodeIds = Array.isArray(unit.sourceNodeIds) ? unit.sourceNodeIds : [];
      if (nodeIds.length === 0) {
        stats.skippedInvalidPlaceholder += 1;
        continue;
      }
      const firstNode = nodeIndex.get(nodeIds[0]);
      if (firstNode?.type === "text") {
        firstNode.text = simpleText;
      }
      for (const nodeId of nodeIds.slice(1)) {
        const textNode = nodeIndex.get(nodeId);
        if (textNode?.type === "text") textNode.text = "";
      }
      stats.appliedUnits += 1;
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
