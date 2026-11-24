'use strict';
// Opt-in experiment. Never writes into existing application jobs.
const fs = require('node:fs/promises');
const path = require('node:path');
const { downloadDirect, mergeExport } = require('../experimental/direct-extractor.cjs');
const { ensureConverter, convertSWF } = require('../experimental/converter.cjs');
const { atomicWrite } = require('../checkpoints.cjs');
const { inspectPDF } = require('../experimental/quality.cjs');
const { resolvePublisher } = require('../publisher-catalog.cjs');
const designation = require('../dist/standard-reference.js');
const { searchAllDocuments } = require('../search.cjs');
const { explicitForeign } = require('../dist/ocr-language.js');
const root = path.resolve(__dirname, '..');
const base = path.join(root, '.data/direct-experiment');
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}
(async () => {
  const signal = controller.signal;
  if (process.argv.includes('--setup')) {
    console.log('Preparing the separate PDF converter…');
    console.log(await ensureConverter(path.join(base, 'tools'), signal));
    return;
  }
  const directory = path.resolve(
    argument(
      '--directory',
      path.join(base, 'runs', new Date().toISOString().replace(/[:.]/g, '-')),
    ),
  );
  if (!directory.startsWith(base + path.sep))
    throw Error('Experiment output must stay inside .data/direct-experiment.');
  await fs.mkdir(directory, { recursive: true });
  console.log('Experiment output: ' + directory);
  const query = argument('--query', 'DIN 129-1');
  if (designation.parse(query)?.publisher !== 'DIN')
    throw Error('This pilot currently supports DIN documents only.');
  let edition;
  const metadataFile = argument('--edition', path.join(directory, 'edition.json'));
  try {
    edition = JSON.parse(await fs.readFile(metadataFile));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    edition = await resolvePublisher(designation.parse(query), { signal });
  }
  if (
    !designation.family(designation.parse(query), designation.parse(edition.reference)) ||
    !edition.pageCount
  )
    throw Error('The catalogue metadata does not match the requested document.');
  await atomicWrite(path.join(directory, 'edition.json'), JSON.stringify(edition, null, 2));
  if (process.argv.includes('--resolve-only')) {
    const candidates = await searchAllDocuments(edition.reference, signal);
    const selected = candidates.find(
      (row) => row.pageCount >= edition.pageCount && !explicitForeign(row.title, edition.reference),
    );
    if (!selected) throw Error('No suitable source found for the experiment.');
    const selection = {
      query,
      reference: edition.reference,
      officialPages: edition.pageCount,
      candidates: candidates.length,
      selected,
    };
    await atomicWrite(path.join(directory, 'selection.json'), JSON.stringify(selection, null, 2));
    console.log(JSON.stringify(selection));
    return;
  }
  if (process.argv.includes('--inspect-only')) {
    const quality = await inspectPDF(path.join(directory, 'source.pdf'), directory, edition, {
      signal,
    });
    console.log(
      JSON.stringify({
        ready: quality.ready,
        checksPassed: quality.checksPassed,
        pages: quality.pages,
        nativeTextPages: quality.nativeTextPages,
        sparsePages: quality.sparsePages,
        language: quality.language.status,
        identity: quality.identity.status,
        extent: quality.extent.status,
      }),
    );
    if (!quality.ready) process.exitCode = 2;
    return;
  }
  const started = performance.now();
  let report;
  if (process.argv.includes('--convert-only')) {
    report = JSON.parse(await fs.readFile(path.join(directory, 'download-report.json')));
  } else {
    let url = argument('--url');
    if (!url) {
      const candidates = await searchAllDocuments(edition.reference, signal);
      url = candidates.find(
        (row) =>
          row.pageCount >= edition.pageCount && !explicitForeign(row.title, edition.reference),
      )?.url;
      if (!url) throw Error('No suitable source found for the experiment.');
    }
    report = await downloadDirect(url, directory, {
      signal,
      concurrency: Number(argument('--workers', '4')),
      onProgress(value) {
        if (value.current === 1 || value.current % 10 === 0 || value.current === value.total)
          console.log(JSON.stringify(value));
      },
    });
    console.log(
      JSON.stringify({
        stage: 'downloaded',
        total: report.total,
        bootstrapMs: report.bootstrapMs,
        downloadMs: report.downloadMs,
      }),
    );
  }
  if (process.argv.includes('--download-only')) return;
  const jar = await ensureConverter(path.join(base, 'tools'), signal);
  const converted = await convertSWF(
    jar,
    path.join(directory, 'swf'),
    path.join(directory, 'export'),
    {
      signal,
      logFile: path.join(directory, 'conversion.log'),
      workers: Number(argument('--convert-workers', '3')),
    },
  );
  await mergeExport(
    path.join(directory, 'export'),
    report.total,
    path.join(directory, 'source.pdf'),
  );
  const summary = { ...report, ...converted, totalMs: performance.now() - started };
  const quality = await inspectPDF(path.join(directory, 'source.pdf'), directory, edition, {
    signal,
  });
  summary.qualityMs = performance.now() - started - summary.totalMs;
  summary.totalMs = performance.now() - started;
  summary.checksPassed = quality.checksPassed;
  summary.ready = quality.ready;
  await atomicWrite(path.join(directory, 'report.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ ...summary, pages: undefined }));
  if (!summary.ready) process.exitCode = 2;
})().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
