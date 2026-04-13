import AdmZip from "adm-zip";
import { parseChapterDocument } from "../epub/document.js";
import { loadChapterEntryNamesFromOpf } from "../epub/opf-loader.js";
import { buildEpubPreprocessContext } from "../epub/epub-preprocess.js";

function isHtmlEntry(entryName) {
  const lower = entryName.toLowerCase();
  return lower.endsWith(".xhtml") || lower.endsWith(".html") || lower.endsWith(".htm");
}

export function loadEpubDocument(inputPath) {
  const zip = new AdmZip(inputPath);
  let chapterEntryNames = [];
  let chapterOrderSource = "opf";
  try {
    const ordered = loadChapterEntryNamesFromOpf(zip);
    chapterEntryNames = ordered.chapterEntryNames;
  } catch {
    chapterOrderSource = "scan";
    chapterEntryNames = zip.getEntries()
      .filter((entry) => !entry.isDirectory && isHtmlEntry(entry.entryName))
      .map((entry) => entry.entryName)
      .filter((entryName) => !/\/(toc|nav)\b/i.test(entryName));
  }

  const chapters = chapterEntryNames
    .map((entryName, idx) => {
      const entry = zip.getEntry(entryName);
      if (!entry) return null;
      const rawHtml = entry.getData().toString("utf8");
      return {
        entryName,
        chapterId: `chapter-${idx}`,
        document: parseChapterDocument(`chapter-${idx}`, rawHtml),
      };
    })
    .filter(Boolean);

  if (chapters.length === 0) {
    throw new Error("EPUB 中未找到可翻译的 HTML/XHTML 文档内容。");
  }

  const preprocessContext = buildEpubPreprocessContext(zip, chapters);
  return {
    zip,
    chapters,
    chapterOrderSource,
    ...preprocessContext,
  };
}
