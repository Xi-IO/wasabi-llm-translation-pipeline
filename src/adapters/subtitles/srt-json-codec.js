export function buildSrtTranslationCodecs() {
  return {
    serializeItem(item) {
      return JSON.stringify({
        timeLine: String(item?.timeLine || ""),
        text: String(item?.cleaned || item?.text || ""),
      });
    },
    deserializeTranslation(item, rowOrTranslation, rawFallback = "") {
      const raw = typeof rowOrTranslation === "string"
        ? String(rowOrTranslation || "").trim()
        : String(rowOrTranslation?.translation ?? rawFallback ?? "").trim();
      try {
        const parsedTranslation = (() => {
          if (typeof rowOrTranslation !== "object" || rowOrTranslation === null) {
            return JSON.parse((raw.match(/\{[\s\S]*\}/) || [])[0] || raw);
          }
          if (typeof rowOrTranslation.text === "string") return rowOrTranslation;
          const nestedRaw = String(rowOrTranslation.translation ?? raw ?? "").trim();
          return JSON.parse((nestedRaw.match(/\{[\s\S]*\}/) || [])[0] || nestedRaw);
        })();
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
