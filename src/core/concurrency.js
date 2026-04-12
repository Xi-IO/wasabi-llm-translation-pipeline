export async function executeWithConcurrency(items, concurrency, worker) {
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length || 1));

  const runners = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  });

  await Promise.all(runners);
}
