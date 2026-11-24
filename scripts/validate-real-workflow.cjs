'use strict';
// Opt-in live checks. Ordinary jobs and their files are never changed.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { runSearchJob } = require('../search.cjs');
const { atomicWrite } = require('../checkpoints.cjs');
const { PDFDocument } = require('pdf-lib');
const { digest } = require('../page-check.cjs');
const { feedback } = require('../dist/job-feedback.js');
const data = path.resolve(__dirname, '../.data');
const root = path.join(data, 'workflow-review');
const value = (name, fallback) =>
  process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const cases = {
  'iso-1101': { query: 'ISO 1101' },
  'din-129-1': { query: 'DIN 129-1', language: value('--language') },
  'asme-y14-3': { query: 'ASME Y14.3', language: 'eng' },
  'iso-series': { query: 'ISO 17450' },
  'iso-wrong-year': { query: 'iso 5458-2013' },
};
(async () => {
  const selected = value('--case');
  if (!cases[selected]) throw Error('Choose --case ' + Object.keys(cases).join(', '));
  const state = await (await fetch('http://127.0.0.1:8968/api/status')).json();
  if (state.app !== 'doc88-local-pdf' || state.activeId)
    throw Error('Ordinary application is busy.');
  const label =
    selected +
    (value('--language') ? '-' + value('--language') : '') +
    (process.argv.includes('--cold') ? '-cold' : '');
  const directory = path.join(root, label);
  await fs.mkdir(directory, { recursive: true });
  let saved = {};
  if (process.argv.includes('--resume'))
    saved = JSON.parse(await fs.readFile(path.join(directory, 'job.json')));
  const controller = new AbortController(),
    deadline = setTimeout(() => controller.abort(), Number(value('--seconds', 480)) * 1000);
  process.once('SIGINT', () => controller.abort());
  let writing = Promise.resolve();
  const job = {
    ...saved,
    id: saved.id || randomUUID(),
    directory,
    kind: 'search',
    query: saved.query || cases[selected].query,
    documentLanguage: saved.documentLanguage || cases[selected].language,
    stage: 'queued',
    error: null,
    errorCode: null,
    controller,
    cacheDirectory: path.join(data, 'models'),
    processingMode: 'auto',
    enhanceImages: true,
    createdAt: saved.createdAt || new Date().toISOString(),
    log(message) {
      console.log(new Date().toISOString() + ' ' + message);
    },
    update(patch) {
      const previous = this.stage;
      Object.assign(this, patch);
      if (patch.stage && patch.stage !== previous)
        console.log(
          JSON.stringify({
            at: new Date().toISOString(),
            case: label,
            stage: this.stage,
            message: this.message,
            current: this.current,
            total: this.total,
          }),
        );
      const { controller, log, update, ...snapshot } = this;
      const json = JSON.stringify(snapshot, null, 2);
      writing = writing.then(() => atomicWrite(path.join(directory, 'job.json'), json));
    },
  };
  const start = performance.now();
  try {
    await runSearchJob(job, data, {
      resume: process.argv.includes('--resume'),
      _cacheAttempted: process.argv.includes('--cold'),
      downloadOptions: { headless: true, rejectChallenges: true },
    });
  } catch (error) {
    job.update({
      stage: controller.signal.aborted ? 'cancelled' : 'error',
      errorCode: error.code,
      error: error.message,
      pdfReady: false,
    });
  } finally {
    clearTimeout(deadline);
    await writing;
  }
  const result = {
    case: label,
    query: job.query,
    resolved: job.resolvedQuery,
    stage: job.stage,
    milliseconds: Math.round(performance.now() - start),
    language: job.documentLanguage,
    edition: job.catalogueEdition || job.isoEdition,
    choices: job.isoChoices,
    series: job.seriesOptions,
    languageChoices: job.languageChoices,
    cache: job.cacheUsage,
    checks: job.verification,
    script: job.scriptVerification,
    quality: feedback(job).qualityNotes,
    candidates: (job.searchResults || []).map((x) => ({
      title: x.title,
      url: x.url,
      pages: x.pageCount,
      status: x.status,
      code: x.errorCode,
      checks: x.checks,
      error: x.error,
    })),
    errorCode: job.errorCode,
    error: job.error,
    metrics: job.performanceMetrics,
  };
  if (job.pdfReady) {
    const bytes = await fs.readFile(path.join(directory, 'result.pdf'));
    const pdf = await PDFDocument.load(bytes, { parseSpeed: 1500, updateMetadata: false });
    result.pdf = {
      file: path.join(directory, 'result.pdf'),
      pages: pdf.getPageCount(),
      bytes: bytes.length,
      sha256: digest(bytes),
      headings: job.documentStructure?.count,
    };
    if (result.pdf.pages !== job.total)
      throw Error('Physical PDF page count differs from verified pages.');
  }
  await atomicWrite(path.join(directory, 'report.json'), JSON.stringify(result, null, 2));
  console.log(
    JSON.stringify({
      case: label,
      stage: result.stage,
      resolved: result.resolved,
      milliseconds: result.milliseconds,
      pdf: result.pdf,
      choices: result.choices?.map((x) => x.reference),
      series: result.series?.map((x) => x.reference),
      languageChoices: result.languageChoices,
      error: result.error,
    }),
  );
})().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
