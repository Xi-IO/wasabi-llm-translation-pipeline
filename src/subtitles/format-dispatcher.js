import { parseSrt } from "./srt.js";
import { parseAssDialogue } from "./ass.js";

export function parseByFormat(format, rawText) {
  if (format === "srt") return parseSrt(rawText);
  if (format === "ass" || format === "ssa") return parseAssDialogue(rawText);
  throw new Error(`Unsupported format: ${format}`);
}
