'use strict';
// Rebuild navigation from existing PDFs. Main page images and OCR stay intact;
// drawn headings can receive a separate, cached recognition pass.
const fs = require('node:fs/promises'),
  path = require('node:path');
const { PDFDocument } = require('pdf-lib');
const { structureFromPDF } = require('../pdf-structure.cjs');
const { addPDFStructure } = require('../document-analysis.cjs');
const { atomicWrite } = require('../checkpoints.cjs');
const { digest } = require('../page-check.cjs');
const root = path.resolve(__dirname, '../.data'),
  jobs = path.join(root, 'jobs');
const argument = (name) =>
  process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined;
(async () => {
  const requested = argument('--id');
  if (requested && !/^[a-f\d-]{36}$/.test(requested)) throw Error('Invalid job ID');
  if (!requested && !process.argv.includes('--all'))
    throw Error('Specify --id UUID or --all; add --apply to update saved results.');
  const reports = [];
  for (const id of requested ? [requested] : await fs.readdir(jobs)) {
    if (!/^[a-f\d-]{36}$/.test(id)) continue;
    const directory = path.join(jobs, id),
      metadata = path.join(directory, 'job.json');
    const saved = await fs.readFile(metadata, 'utf8'),
      job = JSON.parse(saved);
    if (
      job.id !== id ||
      job.stage !== 'done' ||
      !job.pdfReady ||
      job.documentStructure?.version === 2
    )
      continue;
    const original = await fs.readFile(path.join(directory, 'result.pdf'));
    const structure = await structureFromPDF(original, [], {
      language:
        job.documentLanguage ||
        job.verification?.language?.detectedLanguage ||
        job.ocrLanguage ||
        'eng',
      cacheDirectory: path.join(directory, 'structure-cache'),
    });
    const pdf = await PDFDocument.load(original, { parseSpeed: 1500 });
    addPDFStructure(pdf, structure);
    const bytes = await pdf.save({ objectsPerTick: 1500 });
    const verified = await PDFDocument.load(bytes, { parseSpeed: 1500 });
    if (verified.getPageCount() !== pdf.getPageCount()) throw Error('Page count changed');
    const output = path.join(root, 'structure-review', id);
    await fs.mkdir(output, { recursive: true });
    const report = {
      id,
      query: job.resolvedQuery || job.query || job.title,
      pages: pdf.getPageCount(),
      before: job.documentStructure?.count || 0,
      after: structure.count,
      unconfirmed: structure.unconfirmedContents,
      sourceHash: digest(original),
      outputHash: digest(bytes),
      applied: false,
      structure,
    };
    await atomicWrite(path.join(output, 'result.pdf'), bytes);
    if (process.argv.includes('--apply')) {
      if ((await fs.readFile(metadata, 'utf8')) !== saved)
        throw Error('Job changed during structure rebuild: ' + id);
      const backup = path.join(root, 'structure-backups', id, report.sourceHash);
      await fs.mkdir(backup, { recursive: true });
      await fs.writeFile(path.join(backup, 'job.json'), saved, { flag: 'wx' }).catch((e) => {
        if (e.code !== 'EEXIST') throw e;
      });
      await fs.writeFile(path.join(backup, 'result.pdf'), original, { flag: 'wx' }).catch((e) => {
        if (e.code !== 'EEXIST') throw e;
      });
      await atomicWrite(path.join(directory, 'result.pdf'), bytes);
      await atomicWrite(
        metadata,
        JSON.stringify(
          {
            ...job,
            documentStructure: structure,
            bytes: bytes.length,
            structureUpdatedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
      report.applied = true;
    }
    await atomicWrite(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    reports.push({ ...report, structure: undefined });
    console.log(JSON.stringify(reports.at(-1)));
  }
  await atomicWrite(
    path.join(
      root,
      'structure-review',
      process.argv.includes('--apply') ? 'applied.json' : 'preview.json',
    ),
    JSON.stringify(reports, null, 2),
  );
})().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
