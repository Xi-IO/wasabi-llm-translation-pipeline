export function writeEpubDocument(epubDoc, outputPath) {
  epubDoc.docs.forEach((doc) => {
    const html = doc.$.html();
    epubDoc.zip.updateFile(doc.entryName, Buffer.from(html, "utf8"));
  });

  epubDoc.zip.writeZip(outputPath);
}
