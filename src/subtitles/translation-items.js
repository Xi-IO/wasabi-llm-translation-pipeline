import { buildSrt } from "./srt.js";
import { buildAss } from "./ass.js";

export function cleanSubtitleTextForTranslation(text) {
  return text.replace(/\{\\[^}]+\}/g, "").replace(/<[^>]+>/g, "").trim();
}

export function collectTranslatableItems(format, data) {
  if (format === "srt") {
    return data
      .map((e, i) => ({
        key: String(i),
        original: e.text,
        cleaned: cleanSubtitleTextForTranslation(e.text),
        text: cleanSubtitleTextForTranslation(e.text),
      }))
      .filter((x) => x.cleaned);
  }

  if (format === "ass" || format === "ssa") {
    return data.parsedEvents
      .map((e, i) => {
        if (e.type !== "dialogue") return null;
        return {
          key: String(i),
          original: e.text,
          cleaned: cleanSubtitleTextForTranslation(e.text),
          text: cleanSubtitleTextForTranslation(e.text),
        };
      })
      .filter((x) => x && x.cleaned);
  }

  throw new Error(`Unsupported format: ${format}`);
}

export function applyTranslations(format, data, translationMap) {
  if (format === "srt") {
    for (let i = 0; i < data.length; i++) {
      const translated = translationMap[String(i)];
      if (translated) data[i].text = translated;
    }
    return buildSrt(data);
  }

  if (format === "ass" || format === "ssa") {
    for (let i = 0; i < data.parsedEvents.length; i++) {
      const item = data.parsedEvents[i];
      if (item.type !== "dialogue") continue;
      const translated = translationMap[String(i)];
      if (translated) item.text = translated;
    }
    return buildAss(data.header, data.parsedEvents);
  }

  throw new Error(`Unsupported format: ${format}`);
}
