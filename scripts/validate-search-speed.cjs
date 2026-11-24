'use strict';
// Private live validation: no ordinary jobs or downloaded documents are changed.
const fs = require('node:fs/promises'),
  path = require('node:path');
const { runSearchJob } = require('../search.cjs');
const { atomicWrite } = require('../checkpoints.cjs');
const data = path.resolve(__dirname, '../.data'),
  root = path.join(data, 'performance-review');
const cases = [
  { query: 'ISO 17450-4:2017', language: 'eng' },
  { query: 'DIN 276', language: 'deu' },
  { query: 'ASME Y14.6', language: 'eng' },
  { query: 'BS 8015', language: 'eng' },
  { query: 'NF 8015', language: 'fra' },
];
const selected = process.argv.includes('--query')
  ? process.argv[process.argv.indexOf('--query') + 1]
  : null;
const all = [];
(async () => {
  const state = await fetch('http://127.0.0.1:8968/api/status').then((response) => response.json());
  if (state.app !== 'doc88-local-pdf' || state.activeId)
    throw Error('Local application is busy or unidentified.');
  for (const item of cases.filter((item) => !selected || item.query === selected)) {
    const directory = path.join(root, item.query.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
    await fs.mkdir(directory, { recursive: true });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5 * 60 * 1000);
    const stop = () => controller.abort();
    process.once('SIGINT', stop);
    let writing = Promise.resolve();
    const job = {
      query: item.query,
      title: item.query,
      directory,
      controller,
      stage: 'queued',
      cacheDirectory: path.join(data, 'models'),
      documentLanguage: item.language,
      enhanceImages: true,
      processingMode: 'auto',
      createdAt: new Date().toISOString(),
      log(message) {
        console.log(item.query + ': ' + message);
      },
      update(value) {
        const changed = value.stage && this.stage !== value.stage;
        Object.assign(this, value);
        if (changed)
          console.log(
            JSON.stringify({ query: this.query, stage: this.stage, message: this.message }),
          );
        const { controller, log, update, ...saved } = this;
        const text = JSON.stringify(saved, null, 2);
        writing = writing.then(() => atomicWrite(path.join(directory, 'job.json'), text));
      },
    };
    try {
      await runSearchJob(job, data, {
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
      clearTimeout(timeout);
      process.removeListener('SIGINT', stop);
      await writing;
    }
    const result = {
      query: item.query,
      resolvedQuery: job.resolvedQuery || job.query,
      documentLanguage: job.documentLanguage,
      status: job.stage,
      error: job.error,
      pages: job.total,
      pdfReady: job.pdfReady,
      language: job.verification?.language?.status,
      identity: job.verification?.identity?.status,
      extent: job.verification?.extent?.status,
      completeness: job.verification?.completeness?.status,
      integrity: job.verification?.pageIntegrity?.status,
      candidates: job.searchResults?.length,
      preview: job.previewDiagnostics,
      metrics: job.performanceMetrics,
      file: job.pdfReady ? path.join(directory, 'result.pdf') : null,
    };
    all.push(result);
    await atomicWrite(path.join(root, 'report.json'), JSON.stringify(all, null, 2));
    console.log(JSON.stringify(result));
  }
})().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
