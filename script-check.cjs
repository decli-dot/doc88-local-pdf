'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { nativeOCR, dependency } = require('./runtime.cjs');
const { digest } = require('./page-check.cjs');
const { atomicWrite, readJSON } = require('./checkpoints.cjs');
function sampleIndices(total) {
  if (total <= 8) return Array.from({ length: total }, (_, i) => i);
  return [
    ...new Set([
      0,
      2,
      5,
      8,
      ...[0.2, 0.4, 0.6, 0.8].map((f) => Math.min(total - 1, Math.floor(total * f))),
      total - 1,
    ]),
  ];
}
function summarize(evidence) {
  const certain = evidence.filter((item) => item.script && item.confidence >= 0.5);
  const foreign = certain.filter((item) => !['Latin', 'Common', 'Fraktur'].includes(item.script));
  const latin = certain.filter((item) => ['Latin', 'Fraktur'].includes(item.script));
  const failed =
    foreign.length >= Math.min(2, evidence.length) && foreign.length >= certain.length * 0.5;
  return {
    version: 1,
    status: failed ? 'failed' : latin.length ? 'passed' : 'unknown',
    evidence,
    message: failed
      ? 'Письменность основного текста не соответствует выбранному языку документа.'
      : latin.length
        ? 'Латинская письменность подтверждена по изображениям.'
        : 'Письменность по изображениям не определена уверенно.',
  };
}
function waitFor(promise, signal) {
  return new Promise((resolve, reject) => {
    const stop = () => reject(Error('Обработка остановлена.'));
    signal.addEventListener('abort', stop, { once: true });
    Promise.resolve(promise)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', stop));
    if (signal.aborted) stop();
  });
}
async function nativeDetect(executable, image, signal) {
  return new Promise((resolve, reject) => {
    const process = spawn(executable, [image, 'stdout', '-l', 'osd', '--psm', '0'], {
      windowsHide: true,
      signal,
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    process.stdout.on('data', (bytes) => (output = (output + bytes.toString()).slice(-4000)));
    process.stderr.resume();
    process.once('error', reject);
    process.once('close', () =>
      resolve({
        script: output.match(/Script: ([^\r\n]+)/)?.[1] || null,
        confidence: Number(output.match(/Script confidence: ([\d.]+)/)?.[1]) || 0,
      }),
    );
  });
}
async function inspectScripts(job, images, { detect, sampleAll = false } = {}) {
  const signal = job.controller.signal;
  signal.throwIfAborted();
  const samples = sampleAll ? images.map((_, index) => index) : sampleIndices(images.length);
  const hashes = await Promise.all(
    samples.map(async (index) => digest(await fs.readFile(images[index]))),
  );
  const filename = path.join(job.directory, 'script-check.json');
  const cached = await readJSON(filename);
  if (
    cached?.version === 1 &&
    ['passed', 'failed', 'unknown'].includes(cached.result?.status) &&
    Array.isArray(cached.result?.evidence) &&
    JSON.stringify(cached.hashes) === JSON.stringify(hashes)
  )
    return cached.result;
  let executable;
  try {
    executable = nativeOCR('osd');
  } catch {
    /* The script detector can use WASM independently of the OCR engine. */
  }
  let worker = null;
  const stop = () => {
    if (worker) void worker.terminate().catch(() => {});
  };
  signal.addEventListener('abort', stop, { once: true });
  try {
    const evidence = [];
    for (const index of samples) {
      signal.throwIfAborted();
      let data;
      if (detect) data = await detect(images[index]);
      else if (executable) data = await nativeDetect(executable, images[index], signal);
      else {
        if (!worker) {
          await fs.mkdir(
            process.env.DOC88_OCR_CACHE || job.cacheDirectory || path.join(job.directory, 'models'),
            { recursive: true },
          );
          const creating = dependency('tesseract.js')
            .createWorker('osd', 0, {
              legacyCore: true,
              legacyLang: true,
              cachePath:
                process.env.DOC88_OCR_CACHE ||
                job.cacheDirectory ||
                path.join(job.directory, 'models'),
              errorHandler: () => {},
            })
            .then(async (ready) => {
              if (signal.aborted) {
                await ready.terminate();
                throw Error('Обработка остановлена.');
              }
              return ready;
            });
          worker = await waitFor(creating, signal);
        }
        const result = await waitFor(worker.detect(images[index]), signal);
        data = { script: result.data.script, confidence: result.data.script_confidence || 0 };
      }
      evidence.push({ page: index + 1, ...data });
    }
    const result = summarize(evidence);
    await atomicWrite(filename, JSON.stringify({ version: 1, hashes, result }));
    return result;
  } finally {
    signal.removeEventListener('abort', stop);
    if (worker) await worker.terminate().catch(() => {});
  }
}
module.exports = { inspectScripts, sampleIndices, summarize };
