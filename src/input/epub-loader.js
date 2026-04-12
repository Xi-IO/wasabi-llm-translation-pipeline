import AdmZip from "adm-zip";
import { parseChapterDocument } from "../epub/document.js";

function isHtmlEntry(entryName) {
  const lower = entryName.toLowerCase();
  return lower.endsWith(".xhtml") || lower.endsWith(".html") || lower.endsWith(".htm");
}

export function loadEpubDocument(inputPath) {
  const zip = new AdmZip(inputPath);
  const entries = zip.getEntries();

  const chapters = entries
    .filter((entry) => !entry.isDirectory && isHtmlEntry(entry.entryName))
    .map((entry, idx) => {
      const rawHtml = entry.getData().toString("utf8");
      return {
        entryName: entry.entryName,
        chapterId: `chapter-${idx}`,
        document: parseChapterDocument(`chapter-${idx}`, rawHtml),
      };
    });

  if (chapters.length === 0) {
    throw new Error("EPUB 中未找到可翻译的 HTML/XHTML 文档内容。");
  }

  return { zip, chapters };
}
