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
