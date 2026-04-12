import { normalizeNewlines, stripBom } from "../utils/system.js";

export function parseSrt(text) {
  const clean = normalizeNewlines(stripBom(text)).trim();
  if (!clean) return [];

  const blocks = clean.split(/\n{2,}/);
  const entries = [];

  for (const block of blocks) {
    const lines = block.split("\n");
    if (lines.length < 2) continue;

    let idx = 0;
    let seq = null;
    if (/^\d+$/.test(lines[0].trim())) {
      seq = Number(lines[0].trim());
      idx = 1;
    }

    const timeLine = lines[idx]?.trim();
    if (!timeLine || !timeLine.includes("-->")) continue;

    const contentLines = lines.slice(idx + 1);
    entries.push({ seq, timeLine, text: contentLines.join("\n") });
  }

  return entries;
}

export function buildSrt(entries) {
  return entries.map((e, i) => `${i + 1}\n${e.timeLine}\n${e.text}`).join("\n\n") + "\n";
}
