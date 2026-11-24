'use strict';

// Only serializable totals are stored on a job. Parallel work is reported as
// both summed work and elapsed wall time, never as an invented speedup.
function unionMs(spans) {
  let total = 0,
    end = -Infinity;
  for (const [start, stop] of [...spans].sort((a, b) => a[0] - b[0])) {
    total += Math.max(0, stop - Math.max(start, end));
    end = Math.max(end, stop);
  }
  return total;
}
function createTimings(job, { now = () => performance.now() } = {}) {
  const started = now(),
    stages = new Map();
  let finished = null,
    outcome = 'running';
  const startedAt = new Date().toISOString();
  function snapshot() {
    const current = finished ?? now();
    return {
      version: 1,
      startedAt,
      updatedAt: new Date().toISOString(),
      status: outcome,
      elapsedMs: Math.max(0, current - started),
      stages: [...stages].map(([key, stage]) => {
        const active = [...stage.active.values()].map((start) => [start, current]);
        return {
          key,
          calls: stage.calls,
          failures: stage.failures,
          active: active.length,
          workMs: stage.work + active.reduce((sum, [a, b]) => sum + b - a, 0),
          wallMs: unionMs([...stage.spans, ...active]),
        };
      }),
    };
  }
  const publish = () => job.update({ performanceMetrics: snapshot() });
  function start(key) {
    if (finished !== null) throw Error('Timing run is already finished.');
    let stage = stages.get(key);
    if (!stage)
      stages.set(key, (stage = { calls: 0, failures: 0, work: 0, spans: [], active: new Map() }));
    const token = Symbol(key),
      begin = now();
    stage.calls++;
    stage.active.set(token, begin);
    publish();
    let stopped = false;
    return (failed = false) => {
      if (stopped) return;
      stopped = true;
      const end = now();
      stage.active.delete(token);
      stage.work += end - begin;
      stage.spans.push([begin, end]);
      if (failed) stage.failures++;
      publish();
    };
  }
  return {
    snapshot,
    start,
    async measure(key, task) {
      const stop = start(key);
      try {
        return await task();
      } catch (error) {
        stop(true);
        throw error;
      } finally {
        stop();
      }
    },
    finish(status) {
      if (finished !== null) return;
      finished = now();
      outcome = status;
      publish();
    },
    async observeJob(child, task) {
      const original = child.update;
      const keys = {
        opening: 'download',
        downloading: 'download',
        unpacking: 'prepare',
        ocr: 'ocr',
        merging: 'pdf',
        checking: 'verification',
        waiting: 'waiting',
        challenge: 'waiting',
      };
      let key, stop;
      child.update = function (value) {
        if (value.stage !== undefined) {
          const next = keys[value.stage];
          if (next !== key) {
            stop?.();
            key = next;
            stop = key ? start(key) : null;
          }
        }
        return original.call(this, value);
      };
      try {
        return await task();
      } catch (error) {
        stop?.(true);
        stop = null;
        throw error;
      } finally {
        stop?.();
        child.update = original;
      }
    },
  };
}
module.exports = { createTimings, unionMs };
