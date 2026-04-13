import fs from "fs/promises";
import OpenAI from "openai";
import { CONFIG, languageLabel } from "../config/runtime.js";
import { sleep } from "../utils/system.js";
import { executeWithConcurrency } from "./concurrency.js";
import { Mutex } from "async-mutex";
import {
  buildBatchFailureTerminalMessage,
  buildRetryRecoveredMessage,
  formatNodePreview,
} from "./run-logger.js";
import { evaluateNodeQuality, isSuspiciousQuality } from "./quality-checks.js";

export const DEFAULT_SUBTITLE_PROMPT_PATH = new URL(
  "../../prompts/subtitle_system.txt",
  import.meta.url,
);
export const DEFAULT_EPUB_PROMPT_PATH = new URL("../../prompts/epub_system.txt", import.meta.url);

function itemText(item) {
  return String(item.text ?? item.cleaned ?? item.sourceText ?? "").trim();
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
  const trimmed = String(text || "").trim();
  const match = trimmed.startsWith("[") ? trimmed : (trimmed.match(/\[[\s\S]*\]/) || [])[0];
  if (!match) throw new Error("Model response does not contain a JSON array.");
  return match;
}

function normalizeResponseRows(parsed) {
  if (!Array.isArray(parsed)) throw new Error("Model response JSON is not an array.");
  return parsed.map((x) => ({
    id: String(x?.id ?? x?.key ?? ""),
    translation: String(x?.translation ?? "").trim(),
  }));
}

function validateBatchOutput(batch, rows) {
  if (!Array.isArray(rows)) {
    throw new Error("Batch output must be an array.");
  }
  if (rows.length !== batch.length) {
    throw new Error(`Batch output length mismatch: expected ${batch.length}, got ${rows.length}.`);
  }

  const expectedIds = new Set(batch.map((item) => String(item.key)));
  const seen = new Set();

  for (const row of rows) {
    if (!row.id || !expectedIds.has(row.id)) {
      throw new Error(`Missing or unknown node id in batch output: ${row.id || "<empty>"}.`);
    }
    if (seen.has(row.id)) {
      throw new Error(`Duplicate node id in batch output: ${row.id}.`);
    }
    if (!String(row.translation || "").trim()) {
      throw new Error(`Empty translation for node id ${row.id}.`);
    }
    seen.add(row.id);
  }

  if (seen.size !== expectedIds.size) {
    throw new Error("Batch output ids do not cover all input ids exactly once.");
  }
}

async function translateBatch(client, batch, langOptions, promptPath) {
  const messages = await buildMessages(batch, langOptions, promptPath);
  const completion = await client.chat.completions.create({
    model: CONFIG.provider.model,
    messages,
    temperature: 0.2,
  });

  const text = completion.choices?.[0]?.message?.content || "";
  let parsed;
  try {
    parsed = normalizeResponseRows(JSON.parse(extractJsonArray(text)));
    validateBatchOutput(batch, parsed);
  } catch (err) {
    const wrapped = new Error(err.message);
    wrapped.name = "ModelResponseParseError";
    wrapped.responseTextPreview = formatNodePreview(text, 300);
    throw wrapped;
  }

  return parsed;
}

async function repairNodeTranslation(client, item, translation, langOptions) {
  const messages = [
    {
      role: "system",
      content: `Repair one translation from ${languageLabel(langOptions.from)} to ${languageLabel(langOptions.to)}. Return strict JSON only: {"translation":"..."}. Keep proper nouns, formulas, symbols, and code unchanged. Remove unjustified source-language residue and glossary artifacts.`,
    },
    {
      role: "user",
      content: JSON.stringify({
        id: item.key,
        source: itemText(item),
        draft: translation,
      }),
    },
  ];

  const completion = await client.chat.completions.create({
    model: CONFIG.provider.model,
    messages,
    temperature: 0.1,
  });

  const text = completion.choices?.[0]?.message?.content || "";
  let parsed;
  try {
    const match = String(text || "").trim().match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : text);
  } catch {
    throw new Error("Repair response is not valid JSON object.");
  }

  const repaired = String(parsed?.translation ?? "").trim();
  if (!repaired) {
    throw new Error("Repair response translation is empty.");
  }

  return repaired;
}

function fromCachedNode(key, value, itemLookup) {
  const base = itemLookup.get(String(key));
  if (!base) return null;

  if (typeof value === "string") {
    return {
      id: String(key),
      sourceText: itemText(base),
      translation: value,
      status: "translated",
      reasons: [],
      attempts: { batch: 0, single: 0, repair: 0 },
      error: null,
    };
  }

  if (!value || typeof value !== "object") return null;
  return {
    id: String(value.id ?? key),
    sourceText: String(value.sourceText ?? itemText(base)),
    translation: String(value.translation ?? itemText(base)),
    status: value.status || "translated",
    reasons: Array.isArray(value.reasons) ? value.reasons : [],
    attempts: value.attempts || { batch: 0, single: 0, repair: 0 },
    error: value.error || null,
  };
}

const cache = {
  load: (p) => fs.readFile(p, "utf8").then((r) => JSON.parse(r)).catch(() => ({})),
  save: (p, d) => fs.writeFile(p, JSON.stringify(d, null, 2), "utf8"),
};

export async function translateAll(items, cachePath, langOptions, options = {}) {
  const promptPath = options.promptPath || DEFAULT_SUBTITLE_PROMPT_PATH;
  const runLogger = options.runLogger;
  const verboseFailures = Boolean(options.verboseFailures);
  const runSummary = options.runSummary || {};
  const batchRetryDelayMs = Number(options.batchRetryDelayMs ?? 1500);
  const singleRetryDelayMs = Number(options.singleRetryDelayMs ?? 700);
  const repairEnabled = options.enableRepair !== false;
  runSummary.totalNodes = items.length;
  runSummary.batchesRetried = 0;
  runSummary.batchesRecovered = 0;
  runSummary.totalFailureEvents = 0;
  runSummary.batchSuccessNodes = 0;
  runSummary.singleRecoveredNodes = 0;
  runSummary.unresolvedNodes = 0;
  runSummary.suspiciousNodes = 0;
  runSummary.repairedNodes = 0;
  runSummary.unresolvedNodeKeys = [];

  const persistNodeResults = Boolean(options.persistNodeResults);
  const customBatchTranslator = options.batchTranslator;
  const customRepairTranslator = options.repairTranslator;
  const needsBatchClient = !customBatchTranslator;
  const needsRepairClient = repairEnabled && !customRepairTranslator;
  const client = needsBatchClient || needsRepairClient ? createClient() : null;
  const batchTranslator = customBatchTranslator
    || ((batch) => translateBatch(client, batch, langOptions, promptPath));
  const repairTranslator = customRepairTranslator
    || ((item, draft) => repairNodeTranslation(client, item, draft, langOptions));

  const itemLookup = new Map(items.map((item) => [String(item.key), item]));
  const existing = await cache.load(cachePath);
  const done = new Map();
  const persistedValues = new Map();
  for (const [key, value] of Object.entries(existing)) {
    const cached = fromCachedNode(key, value, itemLookup);
    if (cached) {
      done.set(String(key), cached);
      persistedValues.set(String(key), value);
    }
  }

  const pending = items.filter((x) => {
    const cached = done.get(String(x.key));
    if (!cached) return true;
    return cached.status === "unresolved";
  });
  const batches = makeBatches(pending);
  const cacheMutex = new Mutex();
  const concurrency = Math.max(1, Number(options.concurrency ?? CONFIG.translationConcurrency) || 1);
  runSummary.cachedNodes = items.length - pending.length;

  console.log(`待翻译条目: ${pending.length}\n批次数: ${batches.length}\n并发度: ${concurrency}`);

  async function saveNodeResults(results) {
    await cacheMutex.runExclusive(async () => {
      for (const row of results) {
        done.set(String(row.id), row);
        persistedValues.set(String(row.id), persistNodeResults ? row : row.translation);
      }
      await cache.save(cachePath, Object.fromEntries(persistedValues));
    });
  }

  function buildNodeResult(item, translation, status, reasons, attempts, error = null) {
    return {
      id: String(item.key),
      sourceText: itemText(item),
      translation,
      status,
      reasons,
      attempts,
      error,
    };
  }

  async function markUnresolved(item, batchIndex, attempts, lastError) {
    const original = itemText(item);
    const unresolved = buildNodeResult(
      item,
      original,
      "unresolved",
      ["fallback-to-source"],
      attempts,
      {
        type: lastError?.name || "Error",
        message: lastError?.message || "Unknown error",
      },
    );
    await saveNodeResults([unresolved]);
    runSummary.unresolvedNodes += 1;
    runSummary.unresolvedNodeKeys.push(item.key);

    if (runLogger?.logUnresolvedNode) {
      await runLogger.logUnresolvedNode({
        batchIndex,
        key: item.key,
        sourceLength: original.length,
        preview: formatNodePreview(original, 90),
        errorType: lastError?.name || "Error",
        errorMessage: lastError?.message || "Unknown error",
        modelResponsePreview: lastError?.responseTextPreview || null,
      });
    }
  }

  function chooseBetterVersion(item, originalCandidate, repairedCandidate) {
    const originalEval = evaluateNodeQuality({ sourceText: itemText(item), translation: originalCandidate });
    const repairedEval = evaluateNodeQuality({ sourceText: itemText(item), translation: repairedCandidate });
    return repairedEval.score > originalEval.score
      ? { translation: repairedCandidate, evalResult: repairedEval }
      : { translation: originalCandidate, evalResult: originalEval };
  }

  async function maybeRepairSuspicious(item, currentResult) {
    if (!repairEnabled || currentResult.status !== "suspicious") return currentResult;

    try {
      const repaired = await repairTranslator(item, currentResult.translation);
      const best = chooseBetterVersion(item, currentResult.translation, repaired);

      if (!isSuspiciousQuality(best.evalResult)) {
        runSummary.repairedNodes += 1;
        return {
          ...currentResult,
          translation: best.translation,
          status: "translated",
          reasons: [],
          attempts: { ...currentResult.attempts, repair: 1 },
          error: null,
        };
      }

      return {
        ...currentResult,
        translation: best.translation,
        reasons: best.evalResult.reasons,
        attempts: { ...currentResult.attempts, repair: 1 },
      };
    } catch (err) {
      runSummary.totalFailureEvents += 1;
      return {
        ...currentResult,
        translation: itemText(item),
        status: "unresolved",
        reasons: ["repair-failed"],
        attempts: { ...currentResult.attempts, repair: 1 },
        error: { type: err.name || "Error", message: err.message || "Repair failed" },
      };
    }
  }

  async function materializeRows(batch, rows, attempts) {
    const normalizedRows = normalizeResponseRows(rows);
    validateBatchOutput(batch, normalizedRows);
    const map = new Map(normalizedRows.map((row) => [row.id, row.translation]));

    const results = [];
    for (const item of batch) {
      const translation = map.get(String(item.key));
      const quality = evaluateNodeQuality({ sourceText: itemText(item), translation });
      const suspicious = isSuspiciousQuality(quality);
      let nodeResult = buildNodeResult(
        item,
        translation,
        suspicious ? "suspicious" : "translated",
        quality.reasons,
        attempts,
      );
      if (suspicious) {
        runSummary.suspiciousNodes += 1;
        nodeResult = await maybeRepairSuspicious(item, nodeResult);
      }
      results.push(nodeResult);
    }

    return results;
  }

  async function fallbackToSingleNode(batch, batchIndex) {
    console.warn(`批次 ${batchIndex}/${batches.length} 进入单节点降级处理`);

    for (const item of batch) {
      let nodeResolved = false;
      let lastError = null;

      for (let attempt = 1; attempt <= CONFIG.retry; attempt++) {
        try {
          const rows = await batchTranslator([item]);
          const nodeResults = await materializeRows([item], rows, {
            batch: CONFIG.retry,
            single: attempt,
            repair: 0,
          });
          await saveNodeResults(nodeResults);
          runSummary.singleRecoveredNodes += 1;
          nodeResolved = true;
          break;
        } catch (err) {
          lastError = err;
          runSummary.totalFailureEvents += 1;
          if (attempt < CONFIG.retry && singleRetryDelayMs > 0) {
            await sleep(singleRetryDelayMs * attempt);
          }
        }
      }

      if (!nodeResolved) {
        const normalized = itemLookup.get(String(item.key)) || item;
        await markUnresolved(normalized, batchIndex, { batch: CONFIG.retry, single: CONFIG.retry, repair: 0 }, lastError);
      }
    }
  }

  async function processBatch(batch, i) {
    let success = false;
    for (let attempt = 1; attempt <= CONFIG.retry; attempt++) {
      try {
        const rows = await batchTranslator(batch);
        const nodeResults = await materializeRows(batch, rows, { batch: attempt, single: 0, repair: 0 });
        await saveNodeResults(nodeResults);
        runSummary.batchSuccessNodes += batch.length;
        if (attempt > 1) {
          runSummary.batchesRecovered += 1;
          console.log(buildRetryRecoveredMessage(i + 1, attempt));
        } else {
          console.log(`批次 ${i + 1}/${batches.length} 完成`);
        }
        success = true;
        break;
      } catch (err) {
        runSummary.totalFailureEvents += 1;
        if (attempt === 2) runSummary.batchesRetried += 1;

        const failedNodes = batch.map((item) => ({
          key: item.key,
          sourceLength: itemText(item).length,
          preview: formatNodePreview(itemText(item), 90),
          fullSourceText: itemText(item),
        }));

        const terminalMessage = buildBatchFailureTerminalMessage({
          batchIndex: i + 1,
          totalBatches: batches.length,
          attempt,
          errorMessage: err.message,
          failedNodes,
          verbose: verboseFailures,
        });
        console.error(terminalMessage);

        if (runLogger) {
          await runLogger.logBatchFailure({
            batchIndex: i + 1,
            totalBatches: batches.length,
            attempt,
            errorType: err.name || "Error",
            errorMessage: err.message,
            stack: err.stack || null,
            modelResponsePreview: err.responseTextPreview || null,
            failedNodes,
          });
        }
        if (attempt < CONFIG.retry && batchRetryDelayMs > 0) {
          await sleep(batchRetryDelayMs * attempt);
        }
      }
    }
    if (!success) {
      await fallbackToSingleNode(batch, i + 1);
    }
  }

  await executeWithConcurrency(batches, concurrency, processBatch);

  const resultMap = {};
  for (const item of items) {
    const nodeResult = done.get(String(item.key));
    const fallback = itemText(item);
    resultMap[item.key] = nodeResult?.status === "unresolved" ? fallback : (nodeResult?.translation || fallback);
  }

  if (options.returnNodeResults) {
    return {
      translations: resultMap,
      nodeResults: Object.fromEntries(done),
    };
  }

  return resultMap;
}

export const __internal = {
  validateBatchOutput,
};
