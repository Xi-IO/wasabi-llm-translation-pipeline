function walkNode(node, visitor) {
  if (!node) return;
  visitor(node);
  for (const child of node.children || []) {
    walkNode(child, visitor);
  }
}

function normalizeCss(raw) {
  return String(raw || "").replace(/\/\*[\s\S]*?\*\//g, " ");
}

function collectClassesFromCss(cssText, outSet) {
  const css = normalizeCss(cssText);
  const regex = /\.([_a-zA-Z]+[_a-zA-Z0-9-]*)/g;
  let match;
  while ((match = regex.exec(css)) !== null) {
    outSet.add(match[1]);
  }
}

function collectReferencedIdsFromChapter(chapter, outSet) {
  walkNode(chapter.document, (node) => {
    if (node?.type !== "element" || node.tagName !== "a") return;
    const href = String(node.attrs?.href || "").trim();
    if (!href) return;
    const hashIndex = href.indexOf("#");
    if (hashIndex < 0) return;
    const id = href.slice(hashIndex + 1).trim();
    if (id) outSet.add(id);
  });
}

function collectInlineCssFromChapter(chapter, outSet) {
  walkNode(chapter.document, (node) => {
    if (node?.type !== "element" || node.tagName !== "style") return;
    const cssText = (node.children || [])
      .filter((child) => child?.type === "text")
      .map((child) => child.text || "")
      .join("\n");
    collectClassesFromCss(cssText, outSet);
  });
}

export function buildEpubPreprocessContext(zip, chapters = []) {
  const referencedIds = new Set();
  const definedClasses = new Set();

  for (const chapter of chapters) {
    collectReferencedIdsFromChapter(chapter, referencedIds);
    collectInlineCssFromChapter(chapter, definedClasses);
  }

  const cssEntries = zip.getEntries().filter((entry) => (
    !entry.isDirectory && entry.entryName.toLowerCase().endsWith(".css")
  ));
  for (const entry of cssEntries) {
    const cssText = entry.getData().toString("utf8");
    collectClassesFromCss(cssText, definedClasses);
  }

  return {
    referencedIds,
    definedClasses,
  };
}
