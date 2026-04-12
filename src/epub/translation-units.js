const BLOCK_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "p"]);
const INLINE_TAGS = new Set(["em", "i", "strong", "b", "a"]);
const NEVER_TRANSLATE_TAGS = new Set(["script", "style", "code", "pre"]);

function normalizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

export function extractTranslationUnits(chapter) {
  const units = [];

  function walk(node, context) {
    if (node.type === "document") {
      for (const child of node.children || []) {
        walk(child, context);
      }
      return;
    }

    if (node.type === "element") {
      if (NEVER_TRANSLATE_TAGS.has(node.tagName)) return;

      let nextContext = context;
      if (BLOCK_TAGS.has(node.tagName)) {
        nextContext = { kind: node.tagName, blockNodeId: node.id };
      } else if (!INLINE_TAGS.has(node.tagName) && !context) {
        nextContext = null;
      }

      for (const child of node.children || []) {
        walk(child, nextContext);
      }
      return;
    }

    if (node.type === "text" && context) {
      const sourceText = normalizeText(node.text);
      if (!sourceText) return;

      units.push({
        key: `${chapter.entryName}::${node.id}`,
        kind: context.kind,
        sourceText,
        sourceNodeIds: [node.id],
        chapter: chapter.entryName,
        blockNodeId: context.blockNodeId,
      });
    }
  }

  walk(chapter.document, null);
  return units;
}

export function applyTranslationUnits(chapter, translationMap) {
  function walk(node) {
    if (node.type === "text") {
      const key = `${chapter.entryName}::${node.id}`;
      if (translationMap[key]) {
        node.text = translationMap[key];
      }
      return;
    }

    for (const child of node.children || []) {
      walk(child);
    }
  }

  walk(chapter.document);
  return chapter;
}
