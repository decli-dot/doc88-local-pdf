const test = require('node:test'),
  assert = require('node:assert/strict');
const { concurrencyFor, runPagePool } = require('../ocr-pool.cjs');
test('OCR worker limits respect CPUs, free memory, small jobs and the heavier WASM engine', () => {
  const large = { cpus: 16, memory: 16 * 1024 ** 3 };
  assert.equal(concurrencyFor(154, true, undefined, large), 4);
  assert.equal(concurrencyFor(154, false, undefined, large), 2);
  assert.equal(concurrencyFor(154, true, undefined, { ...large, cpus: 2 }), 1);
  assert.equal(concurrencyFor(154, true, undefined, { ...large, memory: 1.5 * 1024 ** 3 }), 1);
  assert.equal(concurrencyFor(2, true, undefined, large), 1);
  assert.equal(concurrencyFor(2, true, 2, large), 2);
  for (const requested of [0, 5, 1.5, 'invalid'])
    assert.throws(() => concurrencyFor(154, true, requested, large));
});
test('bounded OCR finishes out of order but returns original page order and closes all workers', async () => {
  let active = 0,
    peak = 0,
    closed = 0;
  const completed = [];
  const results = await runPagePool([0, 1, 2, 3, 4, 5], {
    signal: new AbortController().signal,
    concurrency: 3,
    createWorker: async () => ({ close: async () => closed++ }),
    async work(index) {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, index === 0 ? 35 : 5));
      active--;
      return index;
    },
    onComplete(_result, index) {
      completed.push(index);
    },
  });
  assert.equal(peak, 3);
  assert.equal(active, 0);
  assert.equal(closed, 3);
  assert.notEqual(completed[0], 0);
  assert.deepEqual(results, [0, 1, 2, 3, 4, 5]);
});
test('failure stops new OCR and awaits in-flight cancellation and cleanup before rejecting', async () => {
  let active = 0,
    closed = 0;
  const started = [];
  await assert.rejects(
    runPagePool([0, 1, 2, 3, 4], {
      signal: new AbortController().signal,
      concurrency: 2,
      createWorker: async () => ({ close: async () => closed++ }),
      async work(index, _i, _worker, signal) {
        active++;
        started.push(index);
        try {
          if (index === 0) {
            await new Promise((r) => setTimeout(r, 5));
            throw Error('OCR failed');
          }
          await new Promise((r) =>
            signal.addEventListener('abort', () => setTimeout(r, 15), { once: true }),
          );
          signal.throwIfAborted();
        } finally {
          active--;
        }
      },
    }),
    /OCR failed/,
  );
  assert.deepEqual(started, [0, 1]);
  assert.equal(active, 0);
  assert.equal(closed, 2);
  const controller = new AbortController();
  let disposed = 0;
  await assert.rejects(
    runPagePool([1, 2, 3], {
      signal: controller.signal,
      concurrency: 2,
      createWorker: async () => ({ close: async () => disposed++ }),
      async work() {
        controller.abort();
      },
    }),
    { name: 'AbortError' },
  );
  assert.equal(disposed, 2);
});
