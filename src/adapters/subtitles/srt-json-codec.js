export function buildSrtTranslationCodecs() {
  return {
    serializeItem(item) {
      return JSON.stringify({
        timeLine: String(item?.timeLine || ""),
        text: String(item?.cleaned || item?.text || ""),
      });
    },
    deserializeTranslation(item, translation) {
      const raw = String(translation || "").trim();
      try {
        const parsedTranslation = JSON.parse((raw.match(/\{[\s\S]*\}/) || [])[0] || raw);
        const translatedText = String(parsedTranslation?.text ?? "").trim();
        if (!translatedText) {
          throw new Error("SRT translation payload text is empty.");
        }
        if (parsedTranslation?.timeLine && String(parsedTranslation.timeLine) !== String(item?.timeLine || "")) {
          throw new Error(`SRT translation timeline mismatch for item ${item?.key || "<unknown>"}.`);
        }
        return translatedText;
      } catch {
        return raw;
      }
    },
  };
}
