import { CONFIG } from "../config/runtime.js";

export function normalizeLangCode(value, fallback) {
  if (!value) return fallback.toLowerCase();
  return String(value).trim().replace("_", "-").toLowerCase();
}

export function parseCliArgs(argv) {
  const args = [...argv];
  const opts = {
    from: CONFIG.defaultSourceLanguage,
    to: CONFIG.defaultTargetLanguage,
  };
  let input = null;

  for (let i = 0; i < args.length; i++) {
    const token = args[i];

    if (token === "--from") {
      opts.from = args[++i];
      continue;
    }
    if (token === "--to") {
      opts.to = args[++i];
      continue;
    }
    if (token.startsWith("--")) {
      throw new Error(`Unknown option: ${token}`);
    }
    if (!input) input = token;
    else throw new Error(`Unexpected extra positional argument: ${token}`);
  }

  if (!input) {
    throw new Error("用法: node index.js <input_file> [--to zh-CN] [--from auto]");
  }

  opts.from = normalizeLangCode(opts.from, CONFIG.defaultSourceLanguage);
  opts.to = normalizeLangCode(opts.to, CONFIG.defaultTargetLanguage);

  if (opts.to === "auto") {
    throw new Error("--to 不能是 auto，请指定目标语言（例如 zh-CN / fr / ru / ja / ko / es）。");
  }

  return { input, opts };
}

export function targetSuffix(lang) {
  return lang.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}
