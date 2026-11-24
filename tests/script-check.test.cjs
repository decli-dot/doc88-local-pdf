const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { inspectScripts, summarize, sampleIndices } = require('../script-check.cjs');
const JSZip = require('jszip');
const { runSearchJob } = require('../search.cjs');
test('script evidence rejects dominant non-Latin text and tolerates sparse pages or isolated symbols', () => {
  assert.equal(
    summarize([
      { script: 'Han', confidence: 0.98 },
      { script: 'Japanese', confidence: 0.79 },
    ]).status,
    'failed',
  );
  assert.equal(
    summarize([
      { script: 'Latin', confidence: 3 },
      { script: 'Latin', confidence: 4 },
      { script: 'Han', confidence: 0.6 },
    ]).status,
    'passed',
  );
  assert.equal(summarize([{ script: null, confidence: 0 }]).status, 'unknown');
  assert.ok(sampleIndices(158).includes(8));
  assert.ok(sampleIndices(158).some((i) => i > 100));
});
test('real script detection rejects a Chinese image even when English OCR would emit Latin characters', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'declipdf-script-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('declipdf-script-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const image = path.join(__dirname, 'fixtures/language-chinese.png');
  const job = {
    directory,
    cacheDirectory: process.env.DOC88_OCR_CACHE || path.resolve(__dirname, '../.data/models'),
    controller: new AbortController(),
  };
  const proof = await inspectScripts(job, [image, image]);
  assert.equal(proof.status, 'failed');
  assert.ok(proof.evidence.some((item) => /Han|Japanese/.test(item.script)));
  let called = false;
  const cached = await inspectScripts(job, [image, image], {
    detect: () => {
      called = true;
      throw Error('Cache must be reused');
    },
  });
  assert.equal(cached.status, 'failed');
  assert.equal(called, false);
});

test('a Chinese scan with a neutral ISO title cannot publish an English PDF through the search pipeline', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'declipdf-script-search-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('declipdf-script-search-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const zip = new JSZip(),
    image = await fs.readFile(path.join(__dirname, 'fixtures/language-chinese.png'));
  zip.file('page001.png', image);
  zip.file('page002.png', image);
  const archive = await zip.generateAsync({ type: 'nodebuffer' });
  const job = {
    query: 'ISO 99999:2026',
    title: 'ISO 99999:2026',
    directory,
    cacheDirectory: process.env.DOC88_OCR_CACHE || path.resolve(__dirname, '../.data/models'),
    controller: new AbortController(),
    isoEdition: {
      reference: 'ISO 99999:2026',
      title: 'Synthetic test document',
      pageCount: 2,
      status: 'Published',
    },
    update(value) {
      Object.assign(this, value);
    },
    log() {},
  };
  await assert.rejects(
    runSearchJob(job, directory, {
      candidates: [
        { url: 'https://www.doc88.com/p-999.html', title: 'ISO 99999:2026', pageCount: 2 },
      ],
      download: async (child) => {
        await fs.writeFile(path.join(child.directory, 'archive.zip'), archive);
        child.total = 2;
        child.archiveReady = true;
      },
    }),
    { code: 'SEARCH_EXHAUSTED' },
  );
  assert.equal(Boolean(job.pdfReady), false);
  assert.equal(job.searchResults[0].checks.language.status, 'failed');
  assert.equal(job.searchResults[0].checks.language.scriptVerification.status, 'failed');
  await assert.rejects(fs.access(path.join(directory, 'result.pdf')));
});
