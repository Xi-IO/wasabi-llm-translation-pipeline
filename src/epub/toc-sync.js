/**
 * First-pass placeholder for TOC/NCX synchronization.
 * Current implementation keeps chapter entry names unchanged,
 * so manifest/spine/toc links remain valid after write-back.
 */
export function syncTocNcx(epubDoc) {
  return epubDoc;
}
