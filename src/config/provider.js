export const PROVIDERS = {
  qwen: {
    keyEnv: "QWEN_API_KEY",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen-plus",
  },
  mimo: {
    keyEnv: "MIMO_API_KEY",
    baseURL: "https://你的mimo接口地址/v1",
    defaultModel: "mimo-chat",
  },
  gemini: {
    keyEnv: "GEMINI_API_KEY",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-2.5-flash",
  },
  grok: {
    keyEnv: "GROK_API_KEY",
    baseURL: "https://api.x.ai/v1",
    defaultModel: "grok-4.1-fast",
  },
};

function normalizeProviderName(raw, fallback = "qwen") {
  return String(raw || fallback).trim().toLowerCase();
}

function getBaseUrlForProvider(provider, meta) {
  const scopedEnvName = `${provider.toUpperCase()}_BASE_URL`;
  return process.env[scopedEnvName] || meta.baseURL;
}

export function resolveProviderConfig(providerName, modelName = "") {
  const provider = normalizeProviderName(providerName);
  const meta = PROVIDERS[provider];
  if (!meta) throw new Error(`Unsupported provider: ${provider}`);

  const apiKey = process.env[meta.keyEnv];
  const baseURL = getBaseUrlForProvider(provider, meta);
  const model = String(modelName || "").trim() || meta.defaultModel;

  if (!apiKey) throw new Error(`Missing ${meta.keyEnv}`);
  if (!baseURL) throw new Error(`Missing baseURL for ${provider}`);

  return { provider, apiKey, baseURL, model };
}

export function getProviderConfig() {
  const provider = normalizeProviderName(process.env.PRIMARY_PROVIDER || process.env.PROVIDER || "qwen");
  const model = process.env.PRIMARY_MODEL || process.env.MODEL || "";
  return resolveProviderConfig(provider, model);
}

export function getFallbackProviderConfig() {
  const fallbackProvider = String(process.env.FALLBACK_PROVIDER || "").trim().toLowerCase();
  if (!fallbackProvider) return null;
  const fallbackModel = process.env.FALLBACK_MODEL || "";
  return resolveProviderConfig(fallbackProvider, fallbackModel);
}
