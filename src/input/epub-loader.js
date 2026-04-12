import AdmZip from "adm-zip";
import * as cheerio from "cheerio";

function isHtmlEntry(entryName) {
  const lower = entryName.toLowerCase();
  return lower.endsWith(".xhtml") || lower.endsWith(".html") || lower.endsWith(".htm");
}

export function loadEpubDocument(inputPath) {
  const zip = new AdmZip(inputPath);
  const entries = zip.getEntries();

  const docs = entries
    .filter((entry) => !entry.isDirectory && isHtmlEntry(entry.entryName))
    .map((entry) => {
      const rawHtml = entry.getData().toString("utf8");
      const $ = cheerio.load(rawHtml, { decodeEntities: false });
      const elements = [];

      $("p,li,blockquote,h1,h2,h3,h4,h5,h6").each((_, el) => {
        const text = $(el).text().trim();
        if (text) elements.push(el);
      });

      return {
        entryName: entry.entryName,
        $,
        elements,
      };
    });

  if (docs.length === 0) {
    throw new Error("EPUB 中未找到可翻译的 HTML/XHTML 文档内容。");
  }

  return { zip, docs };
}
