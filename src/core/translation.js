import fs from "fs/promises";
import OpenAI from "openai";
import { CONFIG, languageLabel } from "../config/runtime.js";
import { sleep } from "../utils/system.js";

export const DEFAULT_SUBTITLE_PROMPT_PATH = new URL(
  "../../prompts/subtitle_system.txt",
  import.meta.url,
);
export const DEFAULT_EPUB_PROMPT_PATH = new URL("../../prompts/epub_system.txt", import.meta.url);

function itemText(item) {
  return String(item.text ?? item.cleaned ?? "").trim();
}

function makeBatches(items) {
  const batches = [];
  let current = [];
  let chars = 0;

  for (const item of items) {
    const piece = itemText(item).length + 40;
    const shouldFlush =
      current.length >= CONFIG.maxBatchItems || chars + piece > CONFIG.maxBatchChars;

    if (shouldFlush && current.length > 0) {
      batches.push(current);
      current = [];
      chars = 0;
    }

    current.push(item);
    chars += piece;
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

function createClient() {
  if (!CONFIG.provider.apiKey) {
    throw new Error("Missing API key. Set OPENAI_API_KEY or QWEN_API_KEY in .env");
  }

  return new OpenAI({
    apiKey: CONFIG.provider.apiKey,
    baseURL: CONFIG.provider.baseURL,
  });
}

async function buildMessages(batch, langOptions, promptPath) {
  const template = await fs.readFile(promptPath || DEFAULT_SUBTITLE_PROMPT_PATH, "utf8");
  const systemPrompt = template
    .replaceAll("{{SOURCE_LANGUAGE}}", languageLabel(langOptions.from))
    .replaceAll("{{TARGET_LANGUAGE}}", languageLabel(langOptions.to));

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: JSON.stringify(batch.map((x) => ({ id: x.key, text: itemText(x) })), null, 2) },
  ];
}

function extractJsonArray(text) {
  const trimmed = text.trim();
  const match = trimmed.startsWith("[") ? trimmed : (trimmed.match(/\[[\s\S]*\]/) || [])[0];
  if (!match) throw new Error("Model response does not contain a JSON array.");
  return match;
}

async function translateBatch(client, batch, langOptions, promptPath) {
  const messages = await buildMessages(batch, langOptions, promptPath);
  const completion = await client.chat.completions.create({
    model: CONFIG.provider.model,
    messages,
    temperature: 0.2,
  });

  const text = completion.choices?.[0]?.message?.content || "";
  const parsed = JSON.parse(extractJsonArray(text));
  const map = new Map(parsed.map((x) => [String(x.id), String(x.translation || "")]));

  return batch.map((item) => ({
    key: item.key,
    translation: map.get(item.key) || itemText(item),
  }));
}

const cache = {
  load: (p) => fs.readFile(p, "utf8").then((r) => JSON.parse(r)).catch(() => ({})),
  save: (p, d) => fs.writeFile(p, JSON.stringify(d, null, 2), "utf8"),
};

export async function translateAll(items, cachePath, langOptions, options = {}) {
  const promptPath = options.promptPath || DEFAULT_SUBTITLE_PROMPT_PATH;
  const client = createClient();
  const existing = await cache.load(cachePath);
  const done = new Map(Object.entries(existing));
  const pending = items.filter((x) => !done.has(x.key));
  const batches = makeBatches(pending);

  console.log(`待翻译条目: ${pending.length}\n批次数: ${batches.length}`);

  for (let i = 0; i < batches.length; i++) {
    let success = false;
    for (let attempt = 1; attempt <= CONFIG.retry; attempt++) {
      try {
        const translated = await translateBatch(client, batches[i], langOptions, promptPath);
        for (const row of translated) done.set(row.key, row.translation);
        await cache.save(cachePath, Object.fromEntries(done));
        console.log(`批次 ${i + 1}/${batches.length} 完成`);
        success = true;
        break;
      } catch (err) {
        console.error(`批次 ${i + 1} 第 ${attempt} 次失败: ${err.message}`);
        if (attempt < CONFIG.retry) await sleep(1500 * attempt);
      }
    }
    if (!success) throw new Error(`Batch ${i + 1} failed after ${CONFIG.retry} retries.`);
  }

  return Object.fromEntries(done);
}
