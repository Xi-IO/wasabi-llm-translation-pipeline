import { renderDocument } from "../epub/document.js";
import { syncTocNcx } from "../epub/toc-sync.js";

export function writeEpubDocument(epubDoc, outputPath) {
  syncTocNcx(epubDoc);
  epubDoc.chapters.forEach((chapter) => {
    const html = renderDocument(chapter.document);
    epubDoc.zip.updateFile(chapter.entryName, Buffer.from(html, "utf8"));
  });

  epubDoc.zip.writeZip(outputPath);
}
