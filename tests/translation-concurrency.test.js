import test from "node:test";
import assert from "node:assert/strict";

import { executeWithConcurrency } from "../src/core/concurrency.js";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("executeWithConcurrency limits workers and runs all tasks", async () => {
  const items = Array.from({ length: 12 }, (_, i) => i);
  let inFlight = 0;
  let maxInFlight = 0;
  const seen = [];

  await executeWithConcurrency(items, 4, async (item) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    seen.push(item);
    await delay(10);
    inFlight -= 1;
  });

  assert.equal(seen.length, 12);
  assert.ok(maxInFlight <= 4);
});
