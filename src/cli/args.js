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
    verboseFailures: false,
    concurrency: CONFIG.translationConcurrency,
    chapterSelector: null,
    dryRun: false,
    segmentDebug: false,
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
    if (token === "--verbose-failures") {
      opts.verboseFailures = true;
      continue;
    }
    if (token === "--concurrency") {
      const raw = args[++i];
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error("--concurrency 必须是大于等于 1 的整数。");
      }
      opts.concurrency = parsed;
      continue;
    }
    if (token === "--chap") {
      const selector = args[++i];
      if (!selector) {
        throw new Error("--chap 需要提供选择器（例如 1-3,\"Introduction\"）。");
      }
      opts.chapterSelector = selector;
      continue;
    }
    if (token === "--dry-run") {
      opts.dryRun = true;
      continue;
    }
    if (token === "--segment") {
      opts.segmentDebug = true;
      continue;
    }
    if (token.startsWith("--")) {
      throw new Error(`Unknown option: ${token}`);
    }
    if (!input) input = token;
    else throw new Error(`Unexpected extra positional argument: ${token}`);
  }

  if (!input) {
    throw new Error("用法: node index.js <input_file> [--to zh-CN] [--from auto] [--concurrency 4] [--chap <selector>] [--dry-run] [--segment] [--verbose-failures]");
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
