import { getProviderConfig, getFallbackProviderConfig } from "./provider.js";

function parseBooleanEnv(raw, fallback = false) {
  if (raw == null || raw === "") return fallback;
  const normalized = String(raw).trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalized);
}

export const CONFIG = {
  provider: getProviderConfig(),
  fallbackProvider: getFallbackProviderConfig(),
  fallbackOnContentFilter: parseBooleanEnv(process.env.FALLBACK_ON_CONTENT_FILTER, false),
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
