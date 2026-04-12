import fs from "fs/promises";
import path from "path";

export async function prepareWorkspace(inputArg) {
  const inputPath = path.resolve(inputArg);
  const fileName = path.basename(inputPath);
  const baseName = path.parse(fileName).name;
  const fileExt = path.extname(fileName).toLowerCase();

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

  return {
    inputPath,
    fileName,
    baseName,
    fileExt,
    inputDir,
    outputDir,
    cacheDir,
    tempDir,
    inputSubDir,
    outputSubDir,
  };
}

export function buildJobPaths(workspace, format, targetLangSuffix) {
  const outputExt = String(format || "").startsWith(".") ? format : `.${format}`;
  const translatedPath = path.resolve(
    path.join(workspace.outputSubDir, `${workspace.baseName}.${targetLangSuffix}${outputExt}`),
  );
  const cachePath = path.resolve(
    path.join(workspace.cacheDir, `${workspace.baseName}.translate-cache.json`),
  );
  const outputMkv = path.resolve(
    path.join(workspace.outputSubDir, `${workspace.baseName}.${targetLangSuffix}.mkv`),
  );

  return { translatedPath, cachePath, outputMkv };
}

export async function archiveInput(workspace) {
  try {
    const finalInputPath = path.join(workspace.inputSubDir, workspace.fileName);
    if (workspace.inputPath !== finalInputPath) {
      await fs.rename(workspace.inputPath, finalInputPath);
      console.log(`输入文件已移到: ${finalInputPath}`);
    }
  } catch (err) {
    console.warn(`无法移动输入文件: ${err.message}`);
  }
}

export async function cleanupWorkspace(workspace) {
  try {
    await fs.rm(workspace.cacheDir, { recursive: true, force: true });
    await fs.rm(workspace.tempDir, { recursive: true, force: true });
    console.log("缓存和临时文件已清除。");
  } catch (err) {
    console.warn("清除缓存和临时文件时出错:", err.message);
  }
}
