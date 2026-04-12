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
};

export function getProviderConfig() {
  const provider = (process.env.PROVIDER || "qwen").toLowerCase();
  const meta = PROVIDERS[provider];
  if (!meta) throw new Error(`Unsupported provider: ${provider}`);

  const apiKey = process.env[meta.keyEnv];
  const baseURL = meta.baseURL;
  const model = process.env.MODEL || meta.defaultModel;

  if (!apiKey) throw new Error(`Missing ${meta.keyEnv}`);
  if (!baseURL) throw new Error(`Missing baseURL for ${provider}`);

  return { provider, apiKey, baseURL, model };
}
