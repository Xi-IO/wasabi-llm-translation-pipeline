import { normalizeNewlines, stripBom } from "../utils/system.js";

export function splitAssSections(text) {
  const lines = normalizeNewlines(stripBom(text)).split("\n");
  const header = [];
  const events = [];
  let inEvents = false;

  for (const line of lines) {
    if (/^\[Events\]/i.test(line.trim())) {
      inEvents = true;
      events.push(line);
      continue;
    }

    if (!inEvents) header.push(line);
    else events.push(line);
  }

  return { header, events };
}

export function parseAssDialogue(text) {
  const { header, events } = splitAssSections(text);
  const formatLine = events.find((l) => /^Format\s*:/i.test(l));
  if (!formatLine) throw new Error("ASS file missing Events Format line.");

  const fields = formatLine
    .replace(/^Format\s*:/i, "")
    .split(",")
    .map((x) => x.trim());

  const textIndex = fields.findIndex((f) => f.toLowerCase() === "text");
  if (textIndex < 0) throw new Error("ASS Events Format has no Text field.");

  const parsedEvents = events.map((line) => {
    if (!/^Dialogue\s*:/i.test(line)) return { type: "raw", raw: line };

    const payload = line.replace(/^Dialogue\s*:/i, "");
    const parts = [];
    let remain = payload;

    for (let i = 0; i < fields.length - 1; i++) {
      const comma = remain.indexOf(",");
      if (comma === -1) {
        parts.push(remain);
        remain = "";
      } else {
        parts.push(remain.slice(0, comma));
        remain = remain.slice(comma + 1);
      }
    }
    parts.push(remain);

    return {
      type: "dialogue",
      parts,
      textIndex,
      text: parts[textIndex] || "",
    };
  });

  return { header, parsedEvents };
}

export function buildAss(header, parsedEvents) {
  const lines = [...header];

  for (const item of parsedEvents) {
    if (item.type === "raw") {
      lines.push(item.raw);
      continue;
    }

    const parts = [...item.parts];
    parts[item.textIndex] = item.text;
    lines.push(`Dialogue: ${parts.join(",")}`);
  }

  return lines.join("\n");
}
