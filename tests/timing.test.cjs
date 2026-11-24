const test = require('node:test');
const assert = require('node:assert/strict');
const { createTimings } = require('../timing.cjs');

test('overlapping stage timings keep wall time distinct from summed work and close every span', () => {
  let clock = 0;
  const job = {
    update(value) {
      Object.assign(this, value);
    },
  };
  const timings = createTimings(job, { now: () => clock });
  const first = timings.start('preview');
  clock = 25;
  const second = timings.start('preview');
  clock = 75;
  first(true);
  clock = 100;
  second();
  timings.finish('done');
  const row = job.performanceMetrics.stages[0];
  assert.equal(row.workMs, 150);
  assert.equal(row.wallMs, 100);
  assert.equal(row.calls, 2);
  assert.equal(row.failures, 1);
  assert.equal(row.active, 0);
  assert.equal(job.performanceMetrics.elapsedMs, 100);
  assert.equal(job.performanceMetrics.status, 'done');
  first();
  assert.equal(job.performanceMetrics.stages[0].calls, 2);
  assert.doesNotThrow(() => JSON.stringify(job));
});

test('stage observation preserves job updates, separates OCR and waiting, and restores methods after an error', async () => {
  let clock = 0;
  const job = {
      update(value) {
        Object.assign(this, value);
      },
    },
    child = { update: job.update };
  const original = child.update,
    timings = createTimings(job, { now: () => clock });
  await assert.rejects(
    timings.observeJob(child, async () => {
      child.update({ stage: 'downloading' });
      clock = 10;
      child.update({ stage: 'waiting' });
      clock = 30;
      child.update({ stage: 'ocr' });
      clock = 45;
      throw Error('cancelled');
    }),
    /cancelled/,
  );
  timings.finish('cancelled');
  assert.equal(child.update, original);
  assert.equal(child.stage, 'ocr');
  const rows = Object.fromEntries(job.performanceMetrics.stages.map((row) => [row.key, row]));
  assert.equal(rows.download.wallMs, 10);
  assert.equal(rows.waiting.wallMs, 20);
  assert.equal(rows.ocr.wallMs, 15);
  assert.equal(rows.ocr.failures, 1);
  assert.ok(Object.values(rows).every((row) => row.active === 0));
});
