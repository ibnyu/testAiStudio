// Minimal worker pool for the `--jobs` lanes.
//
// Each lane pulls the next item from a shared cursor. JavaScript is
// single-threaded, so `cursor++` before the first `await` guarantees no item is
// handed out twice. `fn` is expected to handle its own errors (batch's runItem
// records failures instead of throwing); an exception ends only that lane's
// loop, which keeps one bad item from cancelling the others.
export async function runPool(items, concurrency, fn) {
  if (!items.length) return;
  const lanes = Math.max(1, Math.min(Math.floor(concurrency) || 1, items.length));
  let cursor = 0;
  await Promise.all(
    Array.from({ length: lanes }, async (_, lane) => {
      for (;;) {
        const index = cursor++;
        if (index >= items.length) return;
        await fn(items[index], index, lane);
      }
    }),
  );
}
