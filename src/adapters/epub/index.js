import { DEFAULT_EPUB_PROMPT_PATH, translateAll } from "../../core/translation.js";
import { extractTranslationUnits, applyTranslationUnits } from "../../epub/translation-units.js";

export function extractEpubItems(epubDoc) {
  return epubDoc.chapters.flatMap((chapter) =>
    extractTranslationUnits(chapter).map((unit) => ({
      key: unit.key,
      kind: unit.kind,
      sourceText: unit.sourceText,
      sourceNodeIds: unit.sourceNodeIds,
      chapter: unit.chapter,
      blockNodeId: unit.blockNodeId,
      placeholderMap: unit.placeholderMap,
      text: unit.sourceText,
    })),
  );
}

export function applyEpubTranslations(epubDoc, items, translationMap) {
  const unitsByChapter = new Map();
  for (const item of items) {
    const bucket = unitsByChapter.get(item.chapter) || [];
    bucket.push(item);
    unitsByChapter.set(item.chapter, bucket);
  }

  epubDoc.chapters.forEach((chapter) => {
    applyTranslationUnits(chapter, translationMap, unitsByChapter.get(chapter.entryName) || []);
  });

  return epubDoc;
}

export async function translateEpubItems(items, cachePath, langOptions, options = {}) {
  return translateAll(items, cachePath, langOptions, {
    promptPath: DEFAULT_EPUB_PROMPT_PATH,
    persistNodeResults: true,
    returnNodeResults: false,
    ...options,
  });
}
