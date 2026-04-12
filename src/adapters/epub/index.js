import { DEFAULT_EPUB_PROMPT_PATH, translateAll } from "../../core/translation.js";

function stripHtmlTags(text) {
  return String(text || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

export function extractEpubItems(epubDoc) {
  const items = [];

  epubDoc.docs.forEach((doc, docIndex) => {
    doc.elements.forEach((el, elementIndex) => {
      const text = stripHtmlTags(doc.$(el).text());
      if (!text) return;
      items.push({
        key: `${docIndex}:${elementIndex}`,
        text,
      });
    });
  });

  return items;
}

export function applyEpubTranslations(epubDoc, translationMap) {
  epubDoc.docs.forEach((doc, docIndex) => {
    doc.elements.forEach((el, elementIndex) => {
      const key = `${docIndex}:${elementIndex}`;
      const translated = translationMap[key];
      if (!translated) return;
      doc.$(el).text(translated);
    });
  });

  return epubDoc;
}

export async function translateEpubItems(items, cachePath, langOptions) {
  return translateAll(items, cachePath, langOptions, {
    promptPath: DEFAULT_EPUB_PROMPT_PATH,
  });
}
