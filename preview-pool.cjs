'use strict';

// A bounded look-ahead window, consumed in discovery order. Finishing a later
// preview cannot outrank an earlier candidate or start full OCR on its own.
function createPreviewPool(items, work, { signal, concurrency = 2, onState = () => {} } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 5)
    throw Error('Invalid preview concurrency.');
  const stop = new AbortController(),
    tasks = new Map();
  const combined = AbortSignal.any([signal, stop.signal]);
  let active = 0,
    peak = 0,
    completed = 0,
    cancelled = 0,
    closed = false,
    taking = false,
    nextIndex = 0;
  function publish() {
    onState({
      concurrency,
      total: items.length,
      started: tasks.size,
      active,
      peak,
      completed,
      cancelled,
    });
  }
  function launch(index) {
    if (tasks.has(index) || closed || combined.aborted) return;
    const promise = Promise.resolve()
      .then(async () => {
        let running = false;
        try {
          combined.throwIfAborted();
          active++;
          running = true;
          peak = Math.max(peak, active);
          publish();
          const value = await work(items[index], index, combined);
          combined.throwIfAborted();
          return { ok: true, value };
        } catch (error) {
          if (combined.aborted) cancelled++;
          return { ok: false, error };
        } finally {
          if (running) active--;
          completed++;
          publish();
        }
      })
      .catch((error) => ({ ok: false, error }));
    tasks.set(index, promise);
  }
  return {
    async take(index) {
      if (closed) throw Error('Preview pool is closed.');
      if (!Number.isInteger(index) || index < 0 || index >= items.length)
        throw Error('Invalid preview index.');
      if (taking || index !== nextIndex) throw Error('Previews must be consumed in order.');
      signal.throwIfAborted();
      taking = true;
      try {
        for (let n = index; n < Math.min(items.length, index + concurrency); n++) launch(n);
        const result = await tasks.get(index);
        nextIndex++;
        return result;
      } finally {
        taking = false;
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      stop.abort();
      await Promise.allSettled([...tasks.values()]);
      publish();
    },
  };
}
module.exports = { createPreviewPool };
