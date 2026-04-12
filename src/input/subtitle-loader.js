import fs from "fs/promises";
import path from "path";
import {
  chooseBestSubtitleStream,
  extractSubtitle,
  probeSubtitleStreams,
} from "../media/ffmpeg.js";

export function resolveInputKind(fileExt) {
  const isMkv = fileExt === ".mkv";
  const isSrt = fileExt === ".srt";
  const isAss = fileExt === ".ass" || fileExt === ".ssa";

  return { isMkv, isSrt, isAss };
}

export function assertSupportedInput(fileExt) {
  const { isMkv, isSrt, isAss } = resolveInputKind(fileExt);
  if (!isMkv && !isSrt && !isAss) {
    throw new Error(`不支持的文件格式: ${fileExt}。仅支持 .mkv、.srt、.ass`);
  }

  return { isMkv, isSrt, isAss };
}

export async function loadSubtitleInput(workspace) {
  const { isMkv, isSrt } = assertSupportedInput(workspace.fileExt);

  if (isMkv) {
    const streams = await probeSubtitleStreams(workspace.inputPath);
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
    const tempSubDir = path.join(workspace.tempDir, workspace.baseName);
    await fs.mkdir(tempSubDir, { recursive: true });

    const extractedPath = path.resolve(
      path.join(tempSubDir, `${workspace.baseName}.extracted${extractedExt}`),
    );
    const format = await extractSubtitle(workspace.inputPath, chosen, extractedPath);
    console.log(`已导出字幕: ${extractedPath}`);
    const rawText = await fs.readFile(extractedPath, "utf8");

    return { isMkv, format, rawText };
  }

  console.log(`直接处理 ${workspace.fileExt.toUpperCase()} 字幕文件`);
  const format = isSrt ? "srt" : workspace.fileExt.substring(1).toLowerCase();
  const rawText = await fs.readFile(workspace.inputPath, "utf8");

  return { isMkv, format, rawText };
}
