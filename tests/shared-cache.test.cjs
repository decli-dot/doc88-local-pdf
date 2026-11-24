const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { PDFDocument } = require('pdf-lib');
const { digest } = require('../page-check.cjs');
const {
  identity,
  keyFor,
  verified,
  saveSharedCache,
  loadSharedCache,
} = require('../shared-cache.cjs');
const { runSearchJob } = require('../search.cjs');
const { feedback } = require('../dist/job-feedback.js');

async function fixture(t) {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'declipdf-cache-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(data)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(data).startsWith('declipdf-cache-'));
    await fs.rm(data, { recursive: true, force: true });
  });
  const edition = {
    reference: 'ISO 14405-1:2025',
    title: 'Fixture standard title',
    pageCount: 2,
    status: 'Published',
    sourceURL: 'https://www.iso.org/standard/86001.html',
  };
  async function job() {
    const id = randomUUID(),
      directory = path.join(data, 'jobs', id);
    await fs.mkdir(directory, { recursive: true });
    return {
      id,
      directory,
      query: edition.reference,
      resolvedQuery: edition.reference,
      isoEdition: structuredClone(edition),
      documentLanguage: 'eng',
      controller: new AbortController(),
      update(value) {
        Object.assign(this, value);
      },
      log() {},
    };
  }
  const saved = await job();
  Object.assign(saved, {
    stage: 'done',
    pdfReady: true,
    total: 2,
    copyTextReady: true,
    archiveReady: true,
    title: edition.reference,
    sourceTitle: 'ISO 14405-1 2025',
    url: 'https://www.doc88.com/p-123456.html',
    processingEngine: 'ocr',
    verification: {
      language: { version: 2, status: 'passed', matchedLanguages: ['eng'] },
      identity: { status: 'passed' },
      extent: { status: 'passed' },
      completeness: { status: 'passed', pages: 2, declaredPages: 2 },
    },
    scriptVerification: {
      version: 1,
      status: 'passed',
      evidence: [{ script: 'Latin', confidence: 2 }],
    },
    pageIntegrity: { status: 'unknown', uncertainPages: [2] },
    documentStructure: { count: 1, nodes: [{ title: 'Scope', label: '1', page: 1, children: [] }] },
  });
  const pdf = await PDFDocument.create();
  pdf.addPage();
  pdf.addPage();
  const bytes = Buffer.from(await pdf.save());
  await fs.writeFile(path.join(saved.directory, 'result.pdf'), bytes);
  await fs.writeFile(path.join(saved.directory, 'copy-text.txt'), 'Verified English text.');
  const child = {
    directory: path.join(saved.directory, 'candidates', digest(saved.url).slice(0, 24)),
  };
  await fs.mkdir(path.join(child.directory, 'ocr'), { recursive: true });
  await fs.writeFile(path.join(child.directory, 'archive.zip'), 'PK-fixture');
  await fs.writeFile(path.join(child.directory, 'ocr/page00001.txt'), 'Checked first page');
  await fs.writeFile(path.join(child.directory, 'ocr/page00002.txt'), 'Checked second page');
  await fs.mkdir(path.join(child.directory, 'scanned-pages/ocr'), { recursive: true });
  await fs.writeFile(path.join(child.directory, 'source.pdf'), bytes);
  await fs.writeFile(path.join(child.directory, 'scanned-pages/archive.zip'), 'PK-scanned-pages');
  await fs.writeFile(
    path.join(child.directory, 'scanned-pages/ocr/page00001.txt'),
    'Preserved fallback OCR',
  );
  await fs.writeFile(path.join(child.directory, 'private.log'), 'DO_NOT_COPY');
  return { data, saved, child, job, bytes, edition };
}
async function entry(f) {
  const base = path.join(f.data, 'document-cache'),
    key = keyFor(identity(f.saved));
  const indexPath = path.join(base, 'index', key + '.json');
  const index = JSON.parse(await fs.readFile(indexPath));
  const directory = path.join(base, 'entries', key, index.generation);
  const manifestPath = path.join(directory, 'manifest.json');
  return {
    directory,
    index,
    indexPath,
    manifestPath,
    manifest: JSON.parse(await fs.readFile(manifestPath)),
  };
}
test('a separate yearless search resolves the catalogue first, then reuses verified PDF and notes without source search or OCR', async (t) => {
  const f = await fixture(t);
  assert.equal(await saveSharedCache(f.saved, f.child, f.data), true);
  const fresh = await f.job();
  delete fresh.isoEdition;
  delete fresh.resolvedQuery;
  fresh.query = 'ISO 14405-1';
  delete fresh.documentLanguage;
  let lookups = 0;
  await runSearchJob(fresh, f.data, {
    resolveISO: async () => {
      lookups++;
      return { ...f.edition, checkedAt: 'fresh-check' };
    },
    search: async () => assert.fail('A cache hit must not search sources'),
    download: async () => assert.fail('A cache hit must not download pages'),
    convert: async () => assert.fail('A cache hit must not run OCR'),
  });
  assert.equal(lookups, 1);
  assert.equal(fresh.isoEdition.checkedAt, 'fresh-check');
  assert.equal(fresh.stage, 'done');
  assert.equal(fresh.cacheUsage.status, 'hit');
  assert.deepEqual(await fs.readFile(path.join(fresh.directory, 'result.pdf')), f.bytes);
  assert.equal(
    (
      await PDFDocument.load(await fs.readFile(path.join(fresh.directory, 'result.pdf')))
    ).getPageCount(),
    2,
  );
  assert.equal(
    await fs.readFile(path.join(fresh.directory, 'copy-text.txt'), 'utf8'),
    'Verified English text.',
  );
  assert.equal(fresh.copyTextReady, true);
  assert.equal(fresh.archiveReady, true);
  assert.deepEqual(fresh.documentStructure, f.saved.documentStructure);
  assert.deepEqual(feedback(fresh).qualityNotes, feedback(f.saved).qualityNotes);
  assert.match(fresh.pdfFilename, /Fixture standard title\.pdf$/);
});
test('cache identity separates publisher, part, edition, language and processing settings', async (t) => {
  const f = await fixture(t);
  const base = keyFor(identity(f.saved));
  for (const patch of [
    { resolvedQuery: 'ISO 14405-2:2025' },
    { resolvedQuery: 'ISO 14405-1:2016' },
    { resolvedQuery: 'ISO 14405-1:2025/Amd 1:2026' },
    { resolvedQuery: 'DIN EN ISO 14405-1:2025-02' },
    { resolvedQuery: 'BS EN ISO 14405-1:2025' },
    { documentLanguage: 'deu' },
    { processingMode: 'direct' },
    { enhanceImages: false },
    { isoEdition: { ...f.edition, pageCount: 3 } },
  ])
    assert.notEqual(keyFor(identity({ ...f.saved, ...patch })), base, JSON.stringify(patch));
  for (const [a, b] of [
    ['DIN EN ISO 129-1:2022-02', 'DIN EN ISO 129-1:2022-03'],
    ['ASME Y14.6-2001 (R2025)', 'ASME Y14.6-2001 (R2020)'],
  ])
    assert.notEqual(
      keyFor(identity({ ...f.saved, resolvedQuery: a })),
      keyFor(identity({ ...f.saved, resolvedQuery: b })),
    );
  assert.equal(identity({ ...f.saved, query: 'ISO 14405-1', resolvedQuery: null }), null);
  await saveSharedCache(f.saved, f.child, f.data);
  const fresh = await f.job();
  fresh.isoEdition = { ...f.edition, pageCount: 3 };
  assert.equal(await loadSharedCache(fresh, f.data), null);
  assert.notEqual(fresh.stage, 'done');
});
test('old incomplete, wrong-language or unproven jobs never enter the shared cache', async (t) => {
  const f = await fixture(t);
  for (const change of [
    { scriptVerification: null },
    { scriptVerification: { version: 1, status: 'failed', evidence: [] } },
    { verification: { ...f.saved.verification, language: { version: 2, status: 'unknown' } } },
    {
      verification: {
        ...f.saved.verification,
        language: { version: 2, status: 'passed', matchedLanguages: ['fra'] },
      },
    },
    {
      verification: {
        ...f.saved.verification,
        completeness: { status: 'passed', pages: 1, declaredPages: 2 },
      },
    },
    { verification: { ...f.saved.verification, extent: { status: 'failed' } } },
    { pageIntegrity: { status: 'failed' } },
    { stage: 'cancelled' },
  ]) {
    const job = { ...f.saved, ...change };
    assert.equal(verified(job), false);
    assert.equal(await saveSharedCache(job, f.child, f.data), false);
  }
  const pdf = await PDFDocument.create();
  pdf.addPage();
  await fs.writeFile(path.join(f.saved.directory, 'result.pdf'), await pdf.save());
  assert.equal(
    await saveSharedCache(f.saved, f.child, f.data),
    false,
    'actual PDF must contain all pages',
  );
});
test('a damaged PDF restores only checksum-valid page assets for normal rechecking', async (t) => {
  const f = await fixture(t);
  await saveSharedCache(f.saved, f.child, f.data);
  const e = await entry(f);
  await fs.writeFile(path.join(e.directory, 'result.pdf'), 'broken PDF');
  await fs.writeFile(path.join(e.directory, 'assets/ocr/page00002.txt'), 'damaged OCR');
  const fresh = await f.job();
  const result = await loadSharedCache(fresh, f.data);
  assert.equal(result.ready, undefined);
  assert.equal(result.candidate.status, 'unverified');
  assert.equal(fresh.cacheUsage.status, 'assets');
  assert.notEqual(fresh.stage, 'done');
  assert.equal(fresh.pdfReady, undefined);
  const restored = path.join(fresh.directory, 'candidates', digest(f.saved.url).slice(0, 24));
  assert.equal(
    await fs.readFile(path.join(restored, 'ocr/page00001.txt'), 'utf8'),
    'Checked first page',
  );
  await assert.rejects(fs.access(path.join(restored, 'ocr/page00002.txt')));
  await assert.rejects(fs.access(path.join(restored, 'private.log')));
  assert.equal(
    await fs.readFile(path.join(restored, 'scanned-pages/ocr/page00001.txt'), 'utf8'),
    'Preserved fallback OCR',
  );
  assert.deepEqual(await fs.readFile(path.join(restored, 'source.pdf')), f.bytes);
  await assert.rejects(fs.access(path.join(fresh.directory, 'result.pdf')));
});
test('damaged copy text or archive does not masquerade as a complete cache hit', async (t) => {
  const f = await fixture(t);
  await saveSharedCache(f.saved, f.child, f.data);
  const e = await entry(f);
  await fs.writeFile(path.join(e.directory, 'copy-text.txt'), 'broken');
  assert.equal((await loadSharedCache(await f.job(), f.data)).ready, undefined);
  await fs.writeFile(path.join(e.directory, 'copy-text.txt'), 'Verified English text.');
  await fs.writeFile(path.join(e.directory, 'assets/archive.zip'), 'broken');
  assert.equal((await loadSharedCache(await f.job(), f.data)).ready, undefined);
});
test('cache metadata and asset paths cannot bypass integrity or escape the job directory', async (t) => {
  const f = await fixture(t);
  await saveSharedCache(f.saved, f.child, f.data);
  const e = await entry(f);
  await fs.appendFile(e.manifestPath, ' ');
  assert.equal(await loadSharedCache(await f.job(), f.data), null);
  e.manifest.files = [{ path: 'assets/../../escaped.txt', size: 4, sha256: digest('test') }];
  const bytes = Buffer.from(JSON.stringify(e.manifest));
  await fs.writeFile(e.manifestPath, bytes);
  await fs.writeFile(e.indexPath, JSON.stringify({ ...e.index, sha256: digest(bytes) }));
  const fresh = await f.job();
  assert.equal(await loadSharedCache(fresh, f.data), null);
  await assert.rejects(fs.access(path.join(f.data, 'escaped.txt')));
  fresh.controller.abort();
  await assert.rejects(loadSharedCache(fresh, f.data), { name: 'AbortError' });
  assert.notEqual(fresh.stage, 'done');
});
test('verified results from earlier jobs seed the cache without copying private files', async (t) => {
  const f = await fixture(t);
  const { directory, controller, update, log, ...metadata } = f.saved;
  await fs.writeFile(path.join(directory, 'job.json'), JSON.stringify(metadata));
  const fresh = await f.job();
  assert.equal((await loadSharedCache(fresh, f.data)).ready, true);
  assert.equal(fresh.cacheUsage.status, 'hit');
  const e = await entry(f);
  assert.equal(
    e.manifest.files.some((file) => file.path.includes('private')),
    false,
  );
  assert.deepEqual(await fs.readFile(path.join(fresh.directory, 'result.pdf')), f.bytes);
});

test('negative user feedback blocks ready cache reuse and can be corrected without losing the dev log', async (t) => {
  const f = await fixture(t);
  await saveSharedCache(f.saved, f.child, f.data);
  const reviews = require('../document-review.cjs');
  await reviews.saveReview(f.saved, { rating: 'bad', comment: 'Wrong cover' }, f.data);
  assert.equal(await loadSharedCache(await f.job(), f.data), null);
  assert.equal((await reviews.rejectedSources(f.saved, f.data)).has(f.saved.url), true);
  await reviews.saveReview(f.saved, { rating: 'good', comment: 'Rechecked' }, f.data);
  assert.equal((await loadSharedCache(await f.job(), f.data)).ready, true);
  assert.equal((await reviews.readReviews(f.data)).events.length, 2);
});

test('verified Anna PDFs can be reused explicitly but never bypass a Doc88-only selection', async (t) => {
  const f = await fixture(t);
  f.saved.url = 'https://annas-archive.pk/md5/0123456789abcdef0123456789abcdef';
  assert.equal(await saveSharedCache(f.saved, f.child, f.data), true);
  const restricted = await f.job();
  restricted.sourcePolicy = 'doc88-only';
  assert.equal(await loadSharedCache(restricted, f.data), null);
  const allowed = await f.job();
  allowed.sourcePolicy = 'anna-only';
  assert.equal((await loadSharedCache(allowed, f.data)).ready, true);
});
