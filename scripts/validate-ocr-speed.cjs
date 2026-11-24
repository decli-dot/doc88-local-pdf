'use strict';
// Opt-in benchmark on an already downloaded archive; no source or ordinary jobs change.
const fs = require('node:fs/promises');
const path = require('node:path');
const { convertArchive } = require('../pipeline.cjs');
const { digest } = require('../page-check.cjs');
const root = path.resolve(__dirname, '..');
const argument = (name, fallback) =>
  process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const label = argument('--label');
if (!/^[a-z0-9-]{1,50}$/.test(label || '')) throw Error('Choose a benchmark label.');
(async () => {
  const directory = path.join(root, '.data/ocr-speed-review', label);
  const input = path.resolve(
    root,
    argument(
      '--archive',
      '.data/workflow-review/iso-1101-cold/candidates/5cfdd1992e03ff51027e1bd4/scanned-pages/archive.zip',
    ),
  );
  const state = await (await fetch('http://127.0.0.1:8968/api/status')).json();
  if (state.activeId) throw Error('Ordinary application is busy.');
  await fs.mkdir(directory, { recursive: true });
  if (!process.argv.includes('--resume')) {
    try {
      await fs.access(path.join(directory, 'ocr'));
      throw Error('Choose a fresh label for a cold run.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  await fs.copyFile(input, path.join(directory, 'archive.zip'));
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  const started = performance.now();
  let lastPrinted = 0,
    ocrStart = null;
  const job = {
    directory,
    query: 'ISO 1101:2017',
    title: 'ISO 1101:2017',
    documentLanguage: 'eng',
    ocrLanguage: 'eng',
    officialPages: 145,
    enhanceImages: true,
    controller,
    cacheDirectory: path.join(root, '.data/models'),
    ocrConcurrency: Number(argument('--workers', 1)),
    log(message) {
      console.log(message);
    },
    update(value) {
      Object.assign(this, value);
      if (this.stage === 'ocr' && ocrStart === null) ocrStart = performance.now();
      if (this.current >= lastPrinted + 20 || value.stage === 'done') {
        lastPrinted = this.current;
        console.log(
          JSON.stringify({
            label,
            stage: this.stage,
            current: this.current,
            total: this.total,
            seconds: Math.round((performance.now() - started) / 1000),
          }),
        );
      }
    },
  };
  try {
    await convertArchive(job);
  } catch (error) {
    job.stage = 'error';
    job.error = error.message;
    throw error;
  } finally {
    const { controller, update, log, ...saved } = job;
    const texts = [];
    for (const name of (await fs.readdir(path.join(directory, 'ocr')).catch(() => []))
      .filter((x) => /^page\d{5}\.txt$/.test(x))
      .sort()) {
      const text = await fs.readFile(path.join(directory, 'ocr', name), 'utf8');
      texts.push({
        page: Number(name.match(/\d+/)[0]),
        sha256: digest(text),
        characters: text.length,
      });
    }
    const report = {
      ...saved,
      milliseconds: Math.round(performance.now() - started),
      ocrMilliseconds: ocrStart === null ? null : Math.round(performance.now() - ocrStart),
      texts,
    };
    await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
    console.log(
      JSON.stringify({
        label,
        stage: job.stage,
        pages: job.total,
        bytes: job.bytes,
        milliseconds: report.milliseconds,
        ocr: job.ocrDiagnostics,
      }),
    );
  }
})().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
