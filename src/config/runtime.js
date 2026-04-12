import { getProviderConfig } from "./provider.js";

export const CONFIG = {
  provider: getProviderConfig(),
  defaultSourceLanguage: "auto",
  defaultTargetLanguage: "zh-CN",
  translationConcurrency: Number(process.env.TRANSLATION_CONCURRENCY || 4),
  maxBatchItems: 40,
  maxBatchChars: 5000,
  retry: 3,
  preferredEnglishTags: ["eng", "en", "english"],
  textSubtitleCodecs: new Set(["subrip", "ass", "ssa", "webvtt", "mov_text"]),
};

export const LANGUAGE_LABELS = {
  auto: "Auto-detect",
  "zh-cn": "Simplified Chinese (zh-CN)",
  "zh-hans": "Simplified Chinese (zh-Hans)",
  en: "English",
  fr: "French",
  ru: "Russian",
  ja: "Japanese",
  ko: "Korean",
  "ko-kr": "Korean (ko-KR)",
  es: "Spanish",
  "es-es": "Spanish (es-ES)",
};

export function languageLabel(lang) {
  return LANGUAGE_LABELS[lang] || lang;
}
