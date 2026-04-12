import { spawn } from "child_process";
import { CONFIG } from "../config/runtime.js";
import { run } from "../utils/system.js";

function isEnglishLike(stream) {
  const tags = stream.tags || {};
  const lang = String(tags.language || tags.LANGUAGE || "").toLowerCase();
  const title = String(tags.title || tags.handler_name || "").toLowerCase();
  return (
    CONFIG.preferredEnglishTags.includes(lang)
    || CONFIG.preferredEnglishTags.some((x) => title.includes(x))
    || title.includes("english")
  );
}

function isForcedOrCommentary(stream) {
  const tags = stream.tags || {};
  const title = String(tags.title || tags.handler_name || "").toLowerCase();
  return title.includes("commentary") || title.includes("forced");
}

export async function probeSubtitleStreams(mkvPath) {
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-print_format", "json", "-show_streams",
    "-select_streams", "s", mkvPath,
  ]);
  const data = JSON.parse(stdout);
  return Array.isArray(data.streams) ? data.streams : [];
}

export function chooseBestSubtitleStream(streams) {
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

export async function extractSubtitle(mkvPath, stream, outPath) {
  const codec = String(stream.codec_name || "").toLowerCase();

  if (codec === "subrip" || codec === "webvtt" || codec === "mov_text") {
    await run("ffmpeg", [
      "-y", "-i", mkvPath, "-map", `0:${stream.index}`,
      "-c:s", "srt", outPath,
    ]);
    return "srt";
  }

  if (codec === "ass" || codec === "ssa") {
    await run("ffmpeg", [
      "-y", "-i", mkvPath, "-map", `0:${stream.index}`,
      "-c:s", "copy", outPath,
    ]);
    return codec;
  }

  throw new Error(`Unsupported text subtitle codec: ${codec}`);
}

export async function countSubtitleStreams(inputPath) {
  const streams = await probeSubtitleStreams(inputPath);
  return streams.filter((s) => s.codec_type === "subtitle").length;
}

function toFfmpegLanguageCode(langCode) {
  const normalized = String(langCode || "").toLowerCase();
  if (normalized.startsWith("zh")) return "chi";
  if (normalized.startsWith("en")) return "eng";
  if (normalized.startsWith("fr")) return "fre";
  if (normalized.startsWith("ru")) return "rus";
  if (normalized.startsWith("ja")) return "jpn";
  if (normalized.startsWith("ko")) return "kor";
  if (normalized.startsWith("es")) return "spa";
  return "und";
}

export async function muxSubtitle(inputPath, subtitlePath, outputPath, targetLanguageCode = "zh-CN") {
  const subtitleCount = await countSubtitleStreams(inputPath);
  const newSubtitleIndex = subtitleCount;
  const ffmpegLanguage = toFfmpegLanguageCode(targetLanguageCode);

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
    `-metadata:s:s:${newSubtitleIndex}`, `language=${ffmpegLanguage}`,
    `-disposition:s:${newSubtitleIndex}`, "default",
    outputPath,
  );

  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", args);

    ff.stderr.on("data", (d) => process.stderr.write(d));
    ff.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}`));
    });
  });
}
