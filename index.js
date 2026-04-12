import "dotenv/config";
import fs from "fs/promises";
import path from "path";

import { parseCliArgs, languageLabel, targetSuffix } from "./src/cli/args.js";
import {
  probeSubtitleStreams,
  chooseBestSubtitleStream,
  extractSubtitle,
  muxSubtitle,
} from "./src/media/ffmpeg.js";
import { parseSrt } from "./src/subtitles/srt.js";
import { parseAssDialogue } from "./src/subtitles/ass.js";
import { collectTranslatableItems, applyTranslations } from "./src/subtitles/translation-items.js";
import { translateAll } from "./src/core/translation.js";

async function main() {
  const { input, opts: langOptions } = parseCliArgs(process.argv.slice(2));

  const inputPath = path.resolve(input);
  const fileName = path.basename(inputPath);
  const baseName = path.parse(fileName).name;
  const fileExt = path.extname(fileName).toLowerCase();

  const isMkv = fileExt === ".mkv";
  const isSrt = fileExt === ".srt";
  const isAss = fileExt === ".ass" || fileExt === ".ssa";

  if (!isMkv && !isSrt && !isAss) {
    throw new Error(`不支持的文件格式: ${fileExt}。仅支持 .mkv、.srt、.ass`);
  }

  const inputDir = path.join(process.cwd(), "input");
  const outputDir = path.join(process.cwd(), "output");
  const cacheDir = path.join(process.cwd(), "cache");
  const tempDir = path.join(process.cwd(), "temp");

  await fs.mkdir(inputDir, { recursive: true });
  await fs.mkdir(outputDir, { recursive: true });
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.mkdir(tempDir, { recursive: true });

  const inputSubDir = path.join(inputDir, baseName);
  const outputSubDir = path.join(outputDir, baseName);
  await fs.mkdir(inputSubDir, { recursive: true });
  await fs.mkdir(outputSubDir, { recursive: true });

  console.log(`输入文件: ${inputPath}`);
  console.log(`翻译方向: ${languageLabel(langOptions.from)} -> ${languageLabel(langOptions.to)}`);

  let format;
  let rawText;

  if (isMkv) {
    const streams = await probeSubtitleStreams(inputPath);
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
    const tempSubDir = path.join(tempDir, baseName);
    await fs.mkdir(tempSubDir, { recursive: true });

    const extractedPath = path.resolve(path.join(tempSubDir, `${baseName}.extracted${extractedExt}`));
    format = await extractSubtitle(inputPath, chosen, extractedPath);
    console.log(`已导出字幕: ${extractedPath}`);
    rawText = await fs.readFile(extractedPath, "utf8");
  } else {
    console.log(`直接处理 ${fileExt.toUpperCase()} 字幕文件`);
    format = isSrt ? "srt" : fileExt.substring(1).toLowerCase();
    rawText = await fs.readFile(inputPath, "utf8");
  }

  const outputExt = format === "srt" ? ".srt" : format;
  const translatedPath = path.resolve(
    path.join(outputSubDir, `${baseName}.${targetSuffix(langOptions.to)}${outputExt}`),
  );
  const cachePath = path.resolve(path.join(cacheDir, `${baseName}.translate-cache.json`));

  const parsed = format === "srt" ? parseSrt(rawText) : parseAssDialogue(rawText);
  const items = collectTranslatableItems(format, parsed);
  if (items.length === 0) {
    throw new Error("没有找到可翻译的文本条目。");
  }

  const translationMap = await translateAll(items, cachePath, langOptions);
  const finalText = applyTranslations(format, parsed, translationMap);
  await fs.writeFile(translatedPath, finalText, "utf8");

  console.log(`翻译完成: ${translatedPath}`);
  console.log(`缓存文件: ${cachePath}`);

  if (isMkv) {
    const outputMkv = path.resolve(path.join(outputSubDir, `${baseName}.zh.mkv`));
    await muxSubtitle(inputPath, translatedPath, outputMkv);
    console.log(`已封装: ${outputMkv}`);
  }

  try {
    const finalInputPath = path.join(inputSubDir, fileName);
    if (inputPath !== finalInputPath) {
      await fs.rename(inputPath, finalInputPath);
      console.log(`输入文件已移到: ${finalInputPath}`);
    }
  } catch (err) {
    console.warn(`无法移动输入文件: ${err.message}`);
  }

  try {
    await fs.rm(cacheDir, { recursive: true, force: true });
    await fs.rm(tempDir, { recursive: true, force: true });
    console.log("缓存和临时文件已清除。");
  } catch (err) {
    console.warn("清除缓存和临时文件时出错:", err.message);
  }
}

main().catch((err) => {
  console.error("失败:", err.message);
  process.exit(1);
});
