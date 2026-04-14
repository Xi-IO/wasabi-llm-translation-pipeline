import fs from "fs/promises";
import path from "path";

function nowIso() {
  return new Date().toISOString();
}

export function formatNodePreview(text, maxLength = 80) {
  const cleaned = String(text || "").replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength)}…`;
}

export function buildBatchFailureTerminalMessage({
  batchIndex,
  totalBatches,
  attempt,
  errorMessage,
  failedNodes,
  verbose = false,
}) {
  const lines = [
    `批次 ${batchIndex}/${totalBatches} 第 ${attempt} 次失败: ${errorMessage}`,
  ];

  const showNodes = verbose ? failedNodes : failedNodes.slice(0, 3);
  for (const node of showNodes) {
    lines.push(`- ${node.key} len=${node.sourceLength} preview="${node.preview}"`);
  }

  if (!verbose && failedNodes.length > showNodes.length) {
    lines.push(`- ... 还有 ${failedNodes.length - showNodes.length} 个节点未展示`);
  }

  return lines.join("\n");
}

export function buildRetryRecoveredMessage(batchIndex, attempt) {
  return `批次 ${batchIndex} 在第 ${attempt} 次重试后成功`;
}

export async function appendRunFailureLog(runLogPath, entry) {
  await fs.appendFile(runLogPath, `${JSON.stringify(entry)}\n`, "utf8");
}

export async function finalizeRunLog(runLogPath, { success, summary = {}, reason = null }) {
  if (success) {
    await fs.rm(runLogPath, { force: true });
    return { removed: true, preserved: false };
  }

  await appendRunFailureLog(runLogPath, {
    timestamp: nowIso(),
    type: "run-finalized",
    success: false,
    reason,
    summary,
  });

  return { removed: false, preserved: true };
}

export async function createRunLogger({
  inputFile,
  provider,
  model,
  baseDir = process.cwd(),
  tempDir = null,
  verboseFailures = false,
}) {
  const logsDir = tempDir ? path.join(tempDir, "run-logs") : path.join(baseDir, "temp", "run-logs");
  await fs.mkdir(logsDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeName = path.basename(inputFile || "unknown").replace(/[^a-zA-Z0-9._-]/g, "_");
  const runLogPath = path.join(logsDir, `${stamp}.${safeName}.jsonl`);

  await fs.writeFile(runLogPath, `${JSON.stringify({
    timestamp: nowIso(),
    type: "run-start",
    inputFile,
    provider,
    model,
  })}\n`, "utf8");

  return {
    runLogPath,
    verboseFailures,
    inputFile,
    provider,
    model,
    async logBatchFailure(payload) {
      await appendRunFailureLog(runLogPath, {
        timestamp: nowIso(),
        type: "batch-failure",
        inputFile,
        provider,
        model,
        ...payload,
      });
    },
    async logUnresolvedNode(payload) {
      await appendRunFailureLog(runLogPath, {
        timestamp: nowIso(),
        type: "unresolved-node",
        inputFile,
        provider,
        model,
        ...payload,
      });
    },
    async finalize({ success, summary = {}, reason = null }) {
      return finalizeRunLog(runLogPath, { success, summary, reason });
    },
  };
}

export function preserveRunLogOnCrash(runLogger) {
  if (!runLogger) return () => {};

  let finalized = false;

  const finalizeOnce = async (reason) => {
    if (finalized) return;
    finalized = true;
    await runLogger.finalize({ success: false, reason });
  };

  const onSigint = async () => {
    await finalizeOnce("SIGINT");
    process.exit(130);
  };
  const onSigterm = async () => {
    await finalizeOnce("SIGTERM");
    process.exit(143);
  };
  const onUnhandledRejection = async (reason) => {
    await finalizeOnce(`unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`);
  };
  const onUncaughtException = async (err) => {
    await finalizeOnce(`uncaughtException: ${err?.message || String(err)}`);
  };

  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  process.on("unhandledRejection", onUnhandledRejection);
  process.on("uncaughtException", onUncaughtException);

  return () => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    process.off("unhandledRejection", onUnhandledRejection);
    process.off("uncaughtException", onUncaughtException);
  };
}
