import * as cheerio from "cheerio";

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function serializeAttrs(attrs = {}) {
  const pairs = Object.entries(attrs);
  if (pairs.length === 0) return "";
  return ` ${pairs.map(([k, v]) => `${k}="${String(v).replaceAll('"', '&quot;')}"`).join(" ")}`;
}

/**
 * @typedef {Object} DocumentNode
 * @property {string} id
 * @property {string} type
 * @property {string} tagName
 * @property {Record<string,string>} attrs
 * @property {string|null} text
 * @property {DocumentNode[]} children
 */

export function parseChapterDocument(chapterId, html) {
  const $ = cheerio.load(html, { decodeEntities: false });
  let nextId = 0;

  function visit(node) {
    const id = `${chapterId}:n${nextId++}`;

    if (node.type === "text") {
      return {
        id,
        type: "text",
        tagName: "#text",
        attrs: {},
        text: node.data ?? "",
        children: [],
      };
    }

    if (node.type === "comment") {
      return {
        id,
        type: "comment",
        tagName: "#comment",
        attrs: {},
        text: node.data ?? "",
        children: [],
      };
    }

    if (node.type === "directive") {
      return {
        id,
        type: "directive",
        tagName: "#directive",
        attrs: {},
        text: node.data ?? "",
        children: [],
      };
    }

    if (node.type === "tag" || node.type === "script" || node.type === "style") {
      const children = (node.children || []).map((child) => visit(child)).filter(Boolean);
      return {
        id,
        type: "element",
        tagName: node.name,
        attrs: node.attribs || {},
        text: null,
        children,
      };
    }

    return null;
  }

  const children = $.root().contents().toArray().map((node) => visit(node)).filter(Boolean);

  return {
    id: `${chapterId}:root`,
    type: "document",
    tagName: "#document",
    attrs: {},
    text: null,
    children,
  };
}

export function renderDocument(node) {
  if (node.type === "document") {
    return node.children.map((child) => renderDocument(child)).join("");
  }

  if (node.type === "text") {
    return escapeHtml(node.text || "");
  }

  if (node.type === "comment") {
    return `<!--${node.text || ""}-->`;
  }

  if (node.type === "directive") {
    return `<${node.text || ""}>`;
  }

  const tagName = node.tagName;
  const attrs = serializeAttrs(node.attrs);

  if (VOID_TAGS.has(tagName)) {
    return `<${tagName}${attrs}>`;
  }

  const inner = node.children.map((child) => renderDocument(child)).join("");
  return `<${tagName}${attrs}>${inner}</${tagName}>`;
}

export function collectNodeIds(node) {
  const ids = [node.id];
  for (const child of node.children || []) {
    ids.push(...collectNodeIds(child));
  }
  return ids;
}
