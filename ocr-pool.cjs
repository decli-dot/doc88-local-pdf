'use strict';
const os = require('node:os');
function concurrencyFor(total, native, requested, environment = {}) {
  const configured = requested ?? environment.workers ?? process.env.DECLIPDF_OCR_WORKERS;
  if (
    configured != null &&
    (!Number.isInteger(Number(configured)) || Number(configured) < 1 || Number(configured) > 4)
  )
    throw Error('Число процессов OCR должно быть от 1 до 4.');
  const cpus = environment.cpus ?? os.availableParallelism();
  const memory = environment.memory ?? os.freemem();
  const cpuLimit = Math.max(1, Math.floor(cpus / 2));
  const memoryLimit = Math.max(1, Math.floor((memory - 1024 ** 3) / (768 * 1024 ** 2)));
  return Math.min(
    total,
    Number(configured) || (total < 4 ? 1 : 4),
    native ? 4 : 2,
    cpuLimit,
    memoryLimit,
  );
}
async function runPagePool(
  items,
  { signal, concurrency, createWorker, work, onComplete = () => {}, onState = () => {} },
) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4)
    throw Error('Invalid OCR concurrency.');
  const stop = new AbortController(),
    combined = AbortSignal.any([signal, stop.signal]);
  const results = new Array(items.length);
  let next = 0,
    active = 0,
    peak = 0,
    completed = 0,
    failure;
  const publish = () =>
    onState({ concurrency, total: items.length, started: next, active, peak, completed });
  publish();
  await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, items.length) }, async (_, slot) => {
      let worker;
      try {
        combined.throwIfAborted();
        worker = await createWorker(slot, combined);
        while (next < items.length) {
          combined.throwIfAborted();
          const index = next++;
          active++;
          peak = Math.max(peak, active);
          publish();
          try {
            results[index] = await work(items[index], index, worker, combined);
            combined.throwIfAborted();
            completed++;
            onComplete(results[index], index, completed);
            publish();
          } finally {
            active--;
            publish();
          }
        }
      } catch (error) {
        if (!failure) failure = error;
        stop.abort();
      } finally {
        try {
          await worker?.close?.();
        } catch (error) {
          if (!failure) failure = error;
          stop.abort();
        }
      }
    }),
  );
  signal.throwIfAborted();
  if (failure) throw failure;
  return results;
}
module.exports = { concurrencyFor, runPagePool };
