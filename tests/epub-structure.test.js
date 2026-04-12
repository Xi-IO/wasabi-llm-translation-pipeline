import test from "node:test";
import assert from "node:assert/strict";

import { collectNodeIds, parseChapterDocument, renderDocument } from "../src/epub/document.js";
import { applyTranslationUnits, extractTranslationUnits } from "../src/epub/translation-units.js";

const SAMPLE_HTML = `<!DOCTYPE html><html><body>
<h1>Chapter One</h1>
<p>Hello <em>beautiful</em> <strong>world</strong> and <a href="https://example.com">link</a>.</p>
<p><img src="cover.jpg" alt="cover"> Keep image untouched.</p>
<script>var hidden = 'do not translate';</script>
</body></html>`;

function chapterFrom(html = SAMPLE_HTML) {
  return {
    entryName: "OPS/ch1.xhtml",
    chapterId: "chapter-0",
    document: parseChapterDocument("chapter-0", html),
  };
}

test("parse -> reconstruct no-translation preserves core structure", () => {
  const chapter = chapterFrom();
  const rendered = renderDocument(chapter.document);

  assert.match(rendered, /<h1>Chapter One<\/h1>/);
  assert.match(rendered, /<p>Hello <em>beautiful<\/em> <strong>world<\/strong> and <a href="https:\/\/example.com">link<\/a>\.<\/p>/);
  assert.match(rendered, /<img src="cover.jpg" alt="cover">/);
});

test("heading preservation", () => {
  const chapter = chapterFrom();
  const units = extractTranslationUnits(chapter);
  const headingUnits = units.filter((u) => u.kind === "h1");

  assert.equal(headingUnits.length, 1);
  assert.equal(headingUnits[0].sourceText, "Chapter One");
});

test("paragraph preservation", () => {
  const chapter = chapterFrom();
  const units = extractTranslationUnits(chapter);
  const pUnits = units.filter((u) => u.kind === "p");

  assert.ok(pUnits.length >= 2);
  assert.ok(pUnits.some((u) => u.sourceText.includes("Hello")));
});

test("inline formatting preservation after apply", () => {
  const chapter = chapterFrom();
  const units = extractTranslationUnits(chapter);
  const map = Object.fromEntries(units.map((u) => [u.key, `[${u.sourceText}]`]));

  applyTranslationUnits(chapter, map);
  const rendered = renderDocument(chapter.document);

  assert.match(rendered, /<em>\[beautiful\]<\/em>/);
  assert.match(rendered, /<strong>\[world\]<\/strong>/);
  assert.match(rendered, /<a href="https:\/\/example.com">\[link\]<\/a>/);
});

test("mixed translatable/non-translatable content", () => {
  const chapter = chapterFrom();
  const units = extractTranslationUnits(chapter);

  assert.ok(units.every((u) => !u.sourceText.includes("do not translate")));

  const rendered = renderDocument(chapter.document);
  assert.match(rendered, /<script>var hidden = 'do not translate';<\/script>/);
  assert.match(rendered, /<img src="cover.jpg" alt="cover">/);
});

test("stable IDs across parse and write-back", () => {
  const chapter = chapterFrom();
  const idsA = collectNodeIds(chapter.document);

  const rendered = renderDocument(chapter.document);
  const reparsed = parseChapterDocument("chapter-0", rendered);
  const idsB = collectNodeIds(reparsed);

  assert.deepEqual(idsA, idsB);
});
