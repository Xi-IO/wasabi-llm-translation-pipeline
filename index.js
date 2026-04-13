import "dotenv/config";
import fs from "fs/promises";

import { parseCliArgs, targetSuffix } from "./src/cli/args.js";
import {
  buildChapterIndexList,
  resolveChapterSelector,
  formatChapterSelection,
} from "./src/cli/chapter-selector.js";
import { CONFIG, languageLabel } from "./src/config/runtime.js";
import { muxSubtitle } from "./src/media/ffmpeg.js";
import { collectTranslatableItems, applyTranslations } from "./src/subtitles/translation-items.js";
import { parseByFormat } from "./src/subtitles/format-dispatcher.js";
import { translateAll } from "./src/core/translation.js";
import { extractEpubItems, applyEpubTranslations, translateEpubItems } from "./src/adapters/epub/index.js";
import { buildSrtTranslationCodecs } from "./src/adapters/subtitles/srt-json-codec.js";
import { createRunLogger, preserveRunLogOnCrash } from "./src/core/run-logger.js";
import {
  prepareWorkspace,
  buildJobPaths,
  archiveInput,
  cleanupWorkspace,
} from "./src/workspace/workspace.js";
import { loadSubtitleInput } from "./src/input/subtitle-loader.js";
import { loadEpubDocument } from "./src/input/epub-loader.js";
import { writeEpubDocument } from "./src/output/epub-writer.js";

async function main() {
  const { input, opts: langOptions } = parseCliArgs(process.argv.slice(2));
  const workspace = await prepareWorkspace(input);
  const runSummary = {};
  const runLogger = await createRunLogger({
    inputFile: workspace.inputPath,
    provider: CONFIG.provider.provider,
    model: CONFIG.provider.model,
    tempDir: workspace.tempDir,
    verboseFailures: langOptions.verboseFailures,
  });
  const unregisterCrashHooks = preserveRunLogOnCrash(runLogger);

  try {
    console.log(`输入文件: ${workspace.inputPath}`);
    console.log(`翻译方向: ${languageLabel(langOptions.from)} -> ${languageLabel(langOptions.to)}`);

    const isEpub = workspace.fileExt === ".epub";

    if (isEpub) {
      const epubDoc = loadEpubDocument(workspace.inputPath);
      const chapterIndexList = buildChapterIndexList(epubDoc.chapters);
      let selectedChapterSet = null;

      if (langOptions.chapterSelector) {
        selectedChapterSet = resolveChapterSelector(langOptions.chapterSelector, chapterIndexList);
      }

      const selectedChapters = selectedChapterSet
        ? formatChapterSelection(selectedChapterSet, chapterIndexList)
        : chapterIndexList;

      if (selectedChapters.length === 0) {
        throw new Error("--chap 没有选中任何章节。请检查选择器。");
      }

      console.log("已选章节:");
      selectedChapters.forEach((chapter) => {
        console.log(`- [${chapter.index}] ${chapter.title} (${chapter.file})`);
      });

      if (langOptions.dryRun) {
        console.log("Dry run 模式：仅打印章节选择，不执行翻译。");
        await cleanupWorkspace(workspace);
        await runLogger.finalize({ success: true, summary: { ...runSummary, dryRun: true } });
        unregisterCrashHooks();
        return;
      }

      const workingDoc = selectedChapterSet
        ? {
          ...epubDoc,
          chapters: epubDoc.chapters.filter((_, idx) => selectedChapterSet.has(idx + 1)),
        }
        : epubDoc;

      const items = extractEpubItems(workingDoc);
      if (items.length === 0) throw new Error("EPUB 中没有找到可翻译段落。");

      const { translatedPath, cachePath } = buildJobPaths(
        workspace,
        "epub",
        targetSuffix(langOptions.to),
      );
      const translationMap = await translateEpubItems(items, cachePath, langOptions, {
        concurrency: langOptions.concurrency,
        runLogger,
        verboseFailures: runLogger.verboseFailures,
        runSummary,
      });
      applyEpubTranslations(workingDoc, items, translationMap);
      writeEpubDocument(epubDoc, translatedPath);

      console.log(`翻译完成: ${translatedPath}`);
      console.log(`缓存文件: ${cachePath}`);
    } else {
      if (langOptions.chapterSelector) {
        throw new Error("--chap 仅支持 EPUB 输入文件。");
      }
      if (langOptions.dryRun) {
        throw new Error("--dry-run 当前仅支持 EPUB 章节预览。");
      }

      const { isMkv, format, rawText } = await loadSubtitleInput(workspace);

      const { translatedPath, cachePath, outputMkv } = buildJobPaths(
        workspace,
        format,
        targetSuffix(langOptions.to),
      );

      const parsed = parseByFormat(format, rawText);
      const items = collectTranslatableItems(format, parsed);
      if (items.length === 0) {
        throw new Error("没有找到可翻译的文本条目。");
      }

      const subtitleSerializationOptions = format === "srt" ? buildSrtTranslationCodecs() : {};

      const translationMap = await translateAll(items, cachePath, langOptions, {
        concurrency: langOptions.concurrency,
        runLogger,
        verboseFailures: runLogger.verboseFailures,
        runSummary,
        ...subtitleSerializationOptions,
      });
      const finalText = applyTranslations(format, parsed, translationMap);

      await fs.writeFile(translatedPath, finalText, "utf8");

      console.log(`翻译完成: ${translatedPath}`);
      console.log(`缓存文件: ${cachePath}`);

      if (isMkv) {
        await muxSubtitle(workspace.inputPath, translatedPath, outputMkv, langOptions.to);
        console.log(`已封装: ${outputMkv}`);
      }
    }

    await archiveInput(workspace);
    await cleanupWorkspace(workspace);
    await runLogger.finalize({ success: true, summary: runSummary });
    unregisterCrashHooks();
  } catch (err) {
    await runLogger.finalize({ success: false, reason: err.message, summary: runSummary });
    unregisterCrashHooks();
    throw err;
  }
}

main().catch((err) => {
  console.error("失败:", err.message);
  process.exit(1);
});
