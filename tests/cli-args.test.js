import test from "node:test";
import assert from "node:assert/strict";

async function loadParseCliArgs() {
  process.env.QWEN_API_KEY = process.env.QWEN_API_KEY || "test-key";
  const mod = await import("../src/cli/args.js");
  return mod.parseCliArgs;
}

test("parseCliArgs supports per-run concurrency override", async () => {
  const parseCliArgs = await loadParseCliArgs();
  const { input, opts } = parseCliArgs(["demo.epub", "--concurrency", "4"]);
  assert.equal(input, "demo.epub");
  assert.equal(opts.concurrency, 4);
});

test("parseCliArgs rejects invalid concurrency", async () => {
  const parseCliArgs = await loadParseCliArgs();
  assert.throws(
    () => parseCliArgs(["demo.epub", "--concurrency", "0"]),
    /--concurrency 必须是大于等于 1 的整数/,
  );
});

test("parseCliArgs supports --chap and --dry-run", async () => {
  const parseCliArgs = await loadParseCliArgs();
  const { opts } = parseCliArgs(["book.epub", "--chap", "'Introduction'", "--dry-run"]);
  assert.equal(opts.chapterSelector, "'Introduction'");
  assert.equal(opts.dryRun, true);
});

test("parseCliArgs supports --segment debug switch", async () => {
  const parseCliArgs = await loadParseCliArgs();
  const { opts } = parseCliArgs(["book.epub", "--segment"]);
  assert.equal(opts.segmentDebug, true);
});

test("--chap takes priority even when TEST_MODE is set", async () => {
  process.env.TEST_MODE = "1";
  const parseCliArgs = await loadParseCliArgs();
  const { opts } = parseCliArgs(["book.epub", "--chap", "2-3"]);
  assert.equal(opts.chapterSelector, "2-3");
  delete process.env.TEST_MODE;
});
