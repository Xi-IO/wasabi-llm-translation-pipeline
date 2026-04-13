import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import AdmZip from "adm-zip";
import { loadEpubDocument } from "../src/input/epub-loader.js";
import { extractTranslationUnits } from "../src/epub/translation-units.js";

async function buildTempEpub(builder) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "epub-loader-"));
  const filePath = path.join(dir, "book.epub");
  const zip = new AdmZip();
  builder(zip);
  zip.writeZip(filePath);
  return filePath;
}

test("epub loader prefers opf spine order and skips nav docs", async () => {
  const epubPath = await buildTempEpub((zip) => {
    zip.addFile("META-INF/container.xml", Buffer.from(
      `<?xml version="1.0"?>
      <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
        <rootfiles>
          <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
        </rootfiles>
      </container>`,
      "utf8",
    ));
    zip.addFile("OEBPS/content.opf", Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?>
      <package xmlns="http://www.idpf.org/2007/opf" version="3.0">
        <manifest>
          <item id="c2" href="chap2.xhtml" media-type="application/xhtml+xml"/>
          <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
          <item id="c1" href="chap1.xhtml" media-type="application/xhtml+xml"/>
        </manifest>
        <spine>
          <itemref idref="c2"/>
          <itemref idref="nav"/>
          <itemref idref="c1"/>
        </spine>
      </package>`,
      "utf8",
    ));
    zip.addFile("OEBPS/chap1.xhtml", Buffer.from("<html><body><p>One</p></body></html>", "utf8"));
    zip.addFile("OEBPS/chap2.xhtml", Buffer.from("<html><body><p>Two</p></body></html>", "utf8"));
    zip.addFile("OEBPS/nav.xhtml", Buffer.from("<html><body><nav>TOC</nav></body></html>", "utf8"));
    zip.addFile("OEBPS/styles/main.css", Buffer.from(".keep-wrapper { color: red; }", "utf8"));
  });

  const epubDoc = loadEpubDocument(epubPath);
  assert.equal(epubDoc.chapterOrderSource, "opf");
  assert.deepEqual(
    epubDoc.chapters.map((chapter) => chapter.entryName),
    ["OEBPS/chap2.xhtml", "OEBPS/chap1.xhtml"],
  );
});

test("epub loader fallback scan works without opf and builds preprocess context", async () => {
  const epubPath = await buildTempEpub((zip) => {
    zip.addFile("book/ch1.xhtml", Buffer.from(
      "<html><body><p><span id=\"note-anchor\">A</span><a href=\"#note-anchor\">*</a></p></body></html>",
      "utf8",
    ));
    zip.addFile("book/ch2.xhtml", Buffer.from(
      "<html><head><style>.special-wrap { font-weight: bold; }</style></head><body><div><span class=\"special-wrap\">B</span></div></body></html>",
      "utf8",
    ));
  });

  const epubDoc = loadEpubDocument(epubPath);
  assert.equal(epubDoc.chapterOrderSource, "scan");
  assert.equal(epubDoc.referencedIds.has("note-anchor"), true);
  assert.equal(epubDoc.definedClasses.has("special-wrap"), true);

  const chapter = epubDoc.chapters.find((item) => item.entryName.endsWith("ch2.xhtml"));
  chapter.preprocessContext = {
    referencedIds: epubDoc.referencedIds,
    definedClasses: epubDoc.definedClasses,
  };
  const units = extractTranslationUnits(chapter);
  assert.equal(units.length, 1);
  assert.equal(units[0].mode, "simple");
});
