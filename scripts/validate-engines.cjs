'use strict';
// Local, opt-in integration validation. Never touches ordinary user jobs.
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');
const { resolvePublisher } = require('../publisher-catalog.cjs');
const { resolveLatestISO, reference } = require('../iso-catalog.cjs');
const designation = require('../dist/standard-reference.js');
const { searchAllDocuments, runSearchJob } = require('../search.cjs');
const { browserChannel } = require('../runtime.cjs');
const { atomicWrite } = require('../checkpoints.cjs');
const root = path.resolve(__dirname, '../.data/engine-validation');
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
const argument = (key, fallback) =>
  process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : fallback;
const queries = argument('--query') ? [argument('--query')] : ['ISO 5459', 'ASME Y14.3', 'DIN 276'];
const slug = (query) => query.toLowerCase().replace(/[^a-z0-9]+/g, '-');
async function discover(query) {
  const directory = path.join(root, slug(query));
  await fs.mkdir(directory, { recursive: true });
  const national = designation.parse(query);
  const edition = argument('--edition')
    ? JSON.parse(await fs.readFile(argument('--edition')))
    : national
      ? await resolvePublisher(national, { signal: controller.signal })
      : await resolveLatestISO(reference(query), {
          signal: controller.signal,
          dataDirectory: directory,
          launchContext: (profile, options) =>
            chromium.launchPersistentContext(profile, {
              ...options,
              headless: process.argv.includes('--normal-catalogue') ? false : true,
              channel: browserChannel(),
            }),
        });
  console.log(JSON.stringify({ query, reference: edition.reference, pages: edition.pageCount }));
  const candidates = await searchAllDocuments(edition.reference, controller.signal);
  const selection = { query, edition, candidates };
  await atomicWrite(path.join(directory, 'selection.json'), JSON.stringify(selection, null, 2));
  console.log(
    JSON.stringify({
      query,
      candidates: candidates.length,
      viable: candidates
        .filter((row) => row.pageCount >= edition.pageCount)
        .map((row) => ({ title: row.title, pages: row.pageCount })),
    }),
  );
  return selection;
}
async function run(query) {
  const selection = JSON.parse(await fs.readFile(path.join(root, slug(query), 'selection.json')));
  const mode = argument('--mode', 'auto');
  const directory = path.join(root, slug(query), mode);
  await fs.mkdir(directory, { recursive: true });
  const job = {
    id: slug(query) + '-' + mode,
    directory,
    query,
    resolvedQuery: selection.edition.reference,
    ...(designation.parse(selection.edition.reference)
      ? { catalogueEdition: selection.edition }
      : { isoEdition: selection.edition }),
    controller,
    cacheDirectory: path.resolve(__dirname, '../.data/models'),
    processingMode: mode,
    stage: 'queued',
    title: selection.edition.reference,
    enhanceImages: true,
    log(message) {
      console.log(query + ': ' + message);
    },
    update(value) {
      const changed = value.stage && this.stage !== value.stage;
      Object.assign(this, value);
      if (changed || (value.current && value.current % 20 === 0))
        console.log(
          JSON.stringify({
            query,
            stage: this.stage,
            current: this.current,
            total: this.total,
            message: this.message,
          }),
        );
    },
  };
  const started = performance.now();
  try {
    await runSearchJob(job, path.resolve(__dirname, '../.data'), {
      candidates: selection.candidates,
      ...(argument('--max-candidates')
        ? { maxCandidates: Number(argument('--max-candidates')) }
        : {}),
      downloadOptions: { headless: true, rejectChallenges: true },
    });
  } catch (error) {
    job.stage = controller.signal.aborted ? 'cancelled' : 'error';
    job.error = error.message;
  }
  const result = {
    ...job,
    elapsedMs: performance.now() - started,
    controller: undefined,
    log: undefined,
    update: undefined,
  };
  await atomicWrite(path.join(directory, 'job.json'), JSON.stringify(result, null, 2));
  console.log(
    JSON.stringify({
      query,
      stage: result.stage,
      error: result.error,
      pages: result.total,
      mode: result.processingMode,
      used: result.processingEngine,
      elapsedMs: result.elapsedMs,
    }),
  );
  if (!result.pdfReady) process.exitCode = 1;
}
(async () => {
  if (process.argv.includes('--discover')) {
    const results = await Promise.allSettled(queries.map(discover));
    results.forEach((result, i) => {
      if (result.status === 'rejected') {
        console.error(queries[i] + ': ' + result.reason.message);
        process.exitCode = 1;
      }
    });
  } else for (const query of queries) await run(query);
})().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
