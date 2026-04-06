import "dotenv/config";
import fs from "fs/promises";
import path from "path";
import { spawn } from "child_process";
import OpenAI from "openai";

const PROVIDERS = {
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

function getProviderConfig() {
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


// =========================
// 配置区
// =========================
const CONFIG = {
  provider: getProviderConfig(),
  targetLanguage: "简体中文",
  maxBatchItems: 40,
  maxBatchChars: 5000,
  retry: 3,
  outputSuffix: "zh",
  preferredEnglishTags: ["eng", "en", "english"],
  textSubtitleCodecs: new Set(["subrip", "ass", "ssa", "webvtt", "mov_text"]),
};

// =========================
// 基础工具
// =========================
function run(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      ...options,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });

    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    child.on("error", reject);

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(
          new Error(
            `${cmd} exited with code ${code}\n${stderr || stdout || "No output"}`,
          ),
        );
      }
    });
  });
}

function stripBom(text) {
  return text.replace(/^\uFEFF/, "");
}

function normalizeNewlines(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function ensureArray(x) {
  return Array.isArray(x) ? x : [];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function safeFileStem(filePath) {
  const parsed = path.parse(filePath);
  return path.join(parsed.dir, parsed.name);
}

function isEnglishLike(stream) {
  const tags = stream.tags || {};
  const lang = String(tags.language || tags.LANGUAGE || "").toLowerCase();
  const title = String(tags.title || tags.handler_name || "").toLowerCase();
  return (
    CONFIG.preferredEnglishTags.includes(lang) ||
    CONFIG.preferredEnglishTags.some((x) => title.includes(x)) ||
    title.includes("english")
  );
}

function isForcedOrCommentary(stream) {
  const tags = stream.tags || {};
  const title = String(tags.title || tags.handler_name || "").toLowerCase();
  return title.includes("commentary") || title.includes("forced");
}

// =========================
// FFprobe / FFmpeg
// =========================
async function probeSubtitleStreams(mkvPath) {
  const args = [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_streams",
    "-select_streams",
    "s",
    mkvPath,
  ];

  const { stdout } = await run("ffprobe", args);
  const data = JSON.parse(stdout);
  return ensureArray(data.streams);
}

function chooseBestSubtitleStream(streams) {
  const scored = streams
    .filter((s) => CONFIG.textSubtitleCodecs.has(String(s.codec_name || "").toLowerCase()))
    .map((s) => {
      let score = 0;
      if (isEnglishLike(s)) score += 100;
      if (!isForcedOrCommentary(s)) score += 10;
      if (String(s.codec_name).toLowerCase() === "subrip") score += 5;
      return { stream: s, score };
    })
    .sort((a, b) => b.score - a.score);

  return scored[0]?.stream || null;
}

async function extractSubtitle(mkvPath, stream, outPath) {
  const codec = String(stream.codec_name || "").toLowerCase();

  if (codec === "subrip" || codec === "webvtt" || codec === "mov_text") {
    await run("ffmpeg", [
      "-y",
      "-i",
      mkvPath,
      "-map",
      `0:${stream.index}`,
      "-c:s",
      "srt",
      outPath,
    ]);
    return "srt";
  }

  if (codec === "ass" || codec === "ssa") {
    await run("ffmpeg", [
      "-y",
      "-i",
      mkvPath,
      "-map",
      `0:${stream.index}`,
      "-c:s",
      "copy",
      outPath,
    ]);
    return codec;
  }

  throw new Error(`Unsupported text subtitle codec: ${codec}`);
}

// =========================
// SRT 解析/回写
// =========================
function parseSrt(text) {
  const clean = normalizeNewlines(stripBom(text)).trim();
  if (!clean) return [];

  const blocks = clean.split(/\n{2,}/);
  const entries = [];

  for (const block of blocks) {
    const lines = block.split("\n");
    if (lines.length < 2) continue;

    let idx = 0;
    let seq = null;
    if (/^\d+$/.test(lines[0].trim())) {
      seq = Number(lines[0].trim());
      idx = 1;
    }

    const timeLine = lines[idx]?.trim();
    if (!timeLine || !timeLine.includes("-->")) continue;

    const contentLines = lines.slice(idx + 1);
    entries.push({
      seq,
      timeLine,
      text: contentLines.join("\n"),
    });
  }

  return entries;
}

function buildSrt(entries) {
  return entries
    .map((e, i) => `${i + 1}\n${e.timeLine}\n${e.text}`)
    .join("\n\n") + "\n";
}

// =========================
// ASS 解析/回写
// 只翻译 Dialogue 行的文本段，保留样式和时间轴
// =========================
function splitAssSections(text) {
  const lines = normalizeNewlines(stripBom(text)).split("\n");
  const header = [];
  const events = [];
  let inEvents = false;

  for (const line of lines) {
    if (/^\[Events\]/i.test(line.trim())) {
      inEvents = true;
      events.push(line);
      continue;
    }

    if (!inEvents) header.push(line);
    else events.push(line);
  }

  return { header, events };
}

function parseAssDialogue(text) {
  const { header, events } = splitAssSections(text);
  let formatLine = events.find((l) => /^Format\s*:/i.test(l));
  if (!formatLine) {
    throw new Error("ASS file missing Events Format line.");
  }

  const fields = formatLine
    .replace(/^Format\s*:/i, "")
    .split(",")
    .map((x) => x.trim());

  const textIndex = fields.findIndex((f) => f.toLowerCase() === "text");
  if (textIndex < 0) {
    throw new Error("ASS Events Format has no Text field.");
  }

  const parsedEvents = events.map((line) => {
    if (!/^Dialogue\s*:/i.test(line)) {
      return { type: "raw", raw: line };
    }

    const payload = line.replace(/^Dialogue\s*:/i, "");
    const parts = [];
    let remain = payload;

    for (let i = 0; i < fields.length - 1; i++) {
      const comma = remain.indexOf(",");
      if (comma === -1) {
        parts.push(remain);
        remain = "";
      } else {
        parts.push(remain.slice(0, comma));
        remain = remain.slice(comma + 1);
      }
    }
    parts.push(remain);

    const textValue = parts[textIndex] || "";

    return {
      type: "dialogue",
      parts,
      textIndex,
      text: textValue,
    };
  });

  return { header, parsedEvents };
}

function buildAss(header, parsedEvents) {
  const lines = [...header];

  for (const item of parsedEvents) {
    if (item.type === "raw") {
      lines.push(item.raw);
      continue;
    }

    const parts = [...item.parts];
    parts[item.textIndex] = item.text;
    lines.push(`Dialogue: ${parts.join(",")}`);
  }

  return lines.join("\n");
}

// =========================
// 可翻译文本抽取
// =========================
function cleanSubtitleTextForTranslation(text) {
  return text
    .replace(/\{\\[^}]+\}/g, "") // ASS override tags
    .replace(/<[^>]+>/g, "")
    .trim();
}

function collectTranslatableItems(format, data) {
  if (format === "srt") {
    return data
      .map((e, i) => ({
        key: String(i),
        original: e.text,
        cleaned: cleanSubtitleTextForTranslation(e.text),
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
        };
      })
      .filter((x) => x && x.cleaned);
  }

  throw new Error(`Unsupported format: ${format}`);
}

function makeBatches(items) {
  const batches = [];
  let current = [];
  let chars = 0;

  for (const item of items) {
    const piece = item.cleaned.length + 40;
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

// =========================
// AI 翻译
// =========================
function createClient() {
  if (!CONFIG.provider.apiKey) {
    throw new Error("Missing API key. Set OPENAI_API_KEY or QWEN_API_KEY in .env");
  }

  return new OpenAI({
    apiKey: CONFIG.provider.apiKey,
    baseURL: CONFIG.provider.baseURL,
  });
}

function buildMessages(batch) {
  return [
    {
      role: "system",
      content: `
        You are a subtitle translator.

        Translate English subtitles into natural, context-aware Simplified Chinese.

        Style requirements:
        - Choose the appropriate register based on context: colloquial, formal, literary, or archaic.
        - Dialogue must sound like real spoken Chinese when the original is conversational.
        - Preserve tone, attitude, and intensity.
        - Profanity, insults, and offensive language must be translated faithfully and naturally.
        - Do not sanitize or soften the tone.
        - Avoid unnatural or overly literal translations.

        Strict rules:
        1. Preserve item count exactly
        2. Preserve each id exactly
        3. Do not merge or split items
        4. Output ONLY a valid JSON array
        5. Do not output markdown
        6. Do not output explanations
        7. Each element must be:
          {"id":"...","translation":"..."}
        8. All strings must be valid JSON strings (escape quotes properly)
        9. Do not include unescaped line breaks inside strings

        Return ONLY the JSON array.
        `.trim(),
    },
    {
      role: "user",
      content: JSON.stringify(
        batch.map((x) => ({ id: x.key, text: x.cleaned })),
        null,
        2,
      ),
    },
  ];
}

function extractJsonArray(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) return trimmed;

  const match = trimmed.match(/\[[\s\S]*\]/);
  if (match) return match[0];

  throw new Error("Model response does not contain a JSON array.");
}

async function translateBatch(client, batch) {
  const messages = buildMessages(batch);
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
    translation: map.get(item.key) || item.cleaned,
  }));
}

async function translateAll(items, cachePath) {
  const client = createClient();
  const existing = await loadCache(cachePath);
  const done = new Map(Object.entries(existing));
  const pending = items.filter((x) => !done.has(x.key));
  const batches = makeBatches(pending);

  console.log(`待翻译条目: ${pending.length}`);
  console.log(`批次数: ${batches.length}`);

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    let success = false;

    for (let attempt = 1; attempt <= CONFIG.retry; attempt++) {
      try {
        const translated = await translateBatch(client, batch);
        for (const row of translated) done.set(row.key, row.translation);
        await saveCache(cachePath, Object.fromEntries(done));
        console.log(`批次 ${i + 1}/${batches.length} 完成`);
        success = true;
        break;
      } catch (err) {
        console.error(`批次 ${i + 1} 第 ${attempt} 次失败: ${err.message}`);
        if (attempt < CONFIG.retry) await sleep(1500 * attempt);
      }
    }

    if (!success) {
      throw new Error(`Batch ${i + 1} failed after ${CONFIG.retry} retries.`);
    }
  }

  return Object.fromEntries(done);
}

async function loadCache(cachePath) {
  try {
    const raw = await fs.readFile(cachePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveCache(cachePath, data) {
  await fs.writeFile(cachePath, JSON.stringify(data, null, 2), "utf8");
}

// =========================
// 回写翻译结果
// =========================
function applyTranslations(format, data, translationMap) {
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

async function countSubtitleStreams(inputPath) {
  const streams = await probeSubtitleStreams(inputPath);
  return streams.filter(s => s.codec_type === "subtitle").length;
}

async function muxSubtitle(inputPath, subtitlePath, outputPath) {
  const subtitleCount = await countSubtitleStreams(inputPath);
  const newSubtitleIndex = subtitleCount;

  const args = [
    "-y",
    "-i", inputPath,
    "-i", subtitlePath,
    "-map", "0",
    "-map", "1",
    "-c", "copy",
    "-c:s", "srt",
  ];

  for (let i = 0; i < subtitleCount; i++) {
    args.push(`-disposition:s:${i}`, "0");
  }

  args.push(
    `-metadata:s:s:${newSubtitleIndex}`, "language=chi",
    `-disposition:s:${newSubtitleIndex}`, "default",
    outputPath
  );

  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", args);

    ff.stderr.on("data", d => process.stderr.write(d));
    ff.on("close", code => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}`));
    });
  });
}

// =========================
// 主流程
// =========================
async function main() {
  const inputArg = process.argv[2];
  if (!inputArg) {
    console.error("用法: 把 mkv 文件拖到脚本上，或执行 node mkv_subtitle_translate.js your_video.mkv");
    process.exit(1);
  }

  const mkvPath = path.resolve(inputArg);
  const stem = safeFileStem(mkvPath);

  console.log(`输入文件: ${mkvPath}`);

  const streams = await probeSubtitleStreams(mkvPath);
  if (streams.length === 0) {
    throw new Error("这个 MKV 没有字幕流。");
  }

  const chosen = chooseBestSubtitleStream(streams);
  if (!chosen) {
    const codecs = streams.map((s) => s.codec_name).join(", ");
    throw new Error(
      `没有找到可直接处理的文本英文字幕流。当前字幕编码: ${codecs}。图形字幕如 PGS/VobSub 需要 OCR。`,
    );
  }

  console.log(
    `选中字流: index=${chosen.index}, codec=${chosen.codec_name}, language=${chosen.tags?.language || "unknown"}`,
  );

  const extractedExt = chosen.codec_name === "ass" || chosen.codec_name === "ssa" ? ".ass" : ".srt";
  const extractedPath = `${stem}.extracted${extractedExt}`;
  const translatedPath = `${stem}.${CONFIG.outputSuffix}${extractedExt}`;
  const cachePath = `${stem}.translate-cache.json`;

  const format = await extractSubtitle(mkvPath, chosen, extractedPath);
  console.log(`已导出字幕: ${extractedPath}`);

  const rawText = await fs.readFile(extractedPath, "utf8");

  let parsed;
  if (format === "srt") parsed = parseSrt(rawText);
  else parsed = parseAssDialogue(rawText);

  const items = collectTranslatableItems(format, parsed);
  if (items.length === 0) {
    throw new Error("没有找到可翻译的文本条目。");
  }

  const translationMap = await translateAll(items, cachePath);
  const finalText = applyTranslations(format, parsed, translationMap);
  await fs.writeFile(translatedPath, finalText, "utf8");

  console.log(`翻译完成: ${translatedPath}`);
  console.log(`缓存文件: ${cachePath}`);

  const outputMkv = mkvPath.replace(/\.mkv$/i, ".zh.mkv");

  await muxSubtitle(
    mkvPath,
    translatedPath,
    outputMkv
  );

  console.log(`已封装: ${outputMkv}`);
}

main().catch((err) => {
  console.error("失败:", err.message);
  process.exit(1);
});
