import path from "path";
import * as cheerio from "cheerio";

function normalizeZipPath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "");
}

function isHtmlResource(href, mediaType = "") {
  const lowerHref = normalizeZipPath(href).toLowerCase();
  const lowerMedia = String(mediaType || "").toLowerCase();
  return lowerMedia.includes("xhtml")
    || lowerMedia.includes("html")
    || lowerHref.endsWith(".xhtml")
    || lowerHref.endsWith(".html")
    || lowerHref.endsWith(".htm");
}

function resolveRelativePath(baseFilePath, href) {
  const normalizedBase = normalizeZipPath(baseFilePath);
  const normalizedHref = normalizeZipPath(href).split("#")[0];
  const baseDir = path.posix.dirname(normalizedBase);
  return path.posix.normalize(path.posix.join(baseDir, normalizedHref));
}

function findOpfPath(zip) {
  const containerEntry = zip.getEntry("META-INF/container.xml");
  if (containerEntry) {
    const xml = containerEntry.getData().toString("utf8");
    const $ = cheerio.load(xml, { xmlMode: true, decodeEntities: false });
    const rootfiles = $("rootfile").toArray();
    for (const node of rootfiles) {
      const fullPath = normalizeZipPath($(node).attr("full-path"));
      if (fullPath && zip.getEntry(fullPath)) {
        return fullPath;
      }
    }
  }

  const fallback = zip.getEntries().find((entry) => (
    !entry.isDirectory && entry.entryName.toLowerCase().endsWith(".opf")
  ));
  return fallback ? normalizeZipPath(fallback.entryName) : "";
}

export function loadChapterEntryNamesFromOpf(zip) {
  const opfPath = findOpfPath(zip);
  if (!opfPath) {
    throw new Error("OPF not found.");
  }
  const opfEntry = zip.getEntry(opfPath);
  if (!opfEntry) {
    throw new Error(`OPF entry missing: ${opfPath}`);
  }

  const xml = opfEntry.getData().toString("utf8");
  const $ = cheerio.load(xml, { xmlMode: true, decodeEntities: false });
  const manifest = new Map();
  $("manifest > item").each((_idx, node) => {
    const id = String($(node).attr("id") || "").trim();
    const href = String($(node).attr("href") || "").trim();
    if (!id || !href) return;
    manifest.set(id, {
      href,
      mediaType: String($(node).attr("media-type") || "").trim(),
      properties: String($(node).attr("properties") || "").trim().toLowerCase(),
    });
  });

  const chapters = [];
  $("spine > itemref").each((_idx, node) => {
    const idref = String($(node).attr("idref") || "").trim();
    if (!idref || !manifest.has(idref)) return;
    const item = manifest.get(idref);
    if (!isHtmlResource(item.href, item.mediaType)) return;
    if (item.properties.includes("nav")) return;
    const resolved = resolveRelativePath(opfPath, item.href);
    const lower = resolved.toLowerCase();
    if (lower.includes("toc") || lower.includes("nav")) return;
    if (!zip.getEntry(resolved)) return;
    chapters.push(resolved);
  });

  if (chapters.length === 0) {
    throw new Error(`Spine has no usable HTML chapters in ${opfPath}.`);
  }

  return {
    opfPath,
    chapterEntryNames: [...new Set(chapters)],
  };
}
