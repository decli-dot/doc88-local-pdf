const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { capturePages, cachedArchive } = require('../checkpoints.cjs');
const { inspectPages, printedPage, digest } = require('../page-check.cjs');
const { convertArchive } = require('../pipeline.cjs');
const { dependency } = require('../runtime.cjs');
const JSZip = dependency('jszip');
const { PDFDocument } = dependency('pdf-lib');
const fixture = (name) => fs.readFile(path.join(__dirname, 'fixtures', name));
async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'doc88-recovery-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('doc88-recovery-test-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}
function job(directory, extras = {}) {
  return {
    directory,
    title: 'Recovery test',
    controller: new AbortController(),
    update(value) {
      Object.assign(this, value);
    },
    log() {},
    ...extras,
  };
}
const body =
  'The operator shall inspect the workpiece and record the results of the measurement in the report. '.repeat(
    5,
  );
const page = (number) => body + `\n© ISO 2018 — All rights reserved ${number}\n`;
test('page inspection detects gaps, swaps and nonblank image duplicates without blaming blanks or one OCR error', () => {
  assert.equal(printedPage('Title\n© ISO 2018 — All rights reserved 45'), 45);
  assert.equal(printedPage('Title\n19 © ISO 2016 — All rights reserved'), 19);
  assert.equal(inspectPages([1, 2, 3, 4].map(page), [], 4).status, 'passed');
  assert.equal(inspectPages([1, 2, 4, 5].map(page), [], 5).status, 'failed');
  assert.equal(inspectPages([1, 2, 4, 3, 5, 6].map(page), [], 6).status, 'failed');
  assert.equal(inspectPages([1, 2, 8, 4, 5].map(page), [], 8).status, 'unknown');
  assert.equal(inspectPages([page(1), page(1)], ['same', 'same']).duplicates.length, 1);
  assert.equal(inspectPages(['', ''], ['same', 'same']).duplicates.length, 0);
  assert.equal(inspectPages([1, 2, 3].map(page), [], 4).status, 'unknown');
});
test('download checkpoints resume only missing pages and reject damaged or unrelated cached data', async (t) => {
  const directory = await temporary(t);
  const bytes = await fixture('fixture-1.png');
  const info = { count: 3, title: 'Document', filename: 'Document.zip' };
  const make = () =>
    job(directory, { url: 'https://www.doc88.com/p-123.html', fromPage: 1, toPage: 3, total: 3 });
  const first = make();
  await assert.rejects(
    capturePages(first, info, async (number) => {
      if (number === 3) throw Error('Network interrupted');
      return bytes;
    }),
    /interrupted/,
  );
  const seen = [];
  const resumed = make();
  await capturePages(resumed, info, async (number) => {
    seen.push(number);
    return bytes;
  });
  assert.deepEqual(seen, [3]);
  assert.equal(resumed.reusedDownloadPages, 2);
  assert.equal(
    Object.values(
      (await JSZip.loadAsync(await fs.readFile(path.join(directory, 'archive.zip')))).files,
    ).filter((f) => !f.dir).length,
    3,
  );
  assert.equal(await cachedArchive(make()), true);
  await fs.writeFile(path.join(directory, 'archive.zip'), 'damaged');
  assert.equal(await cachedArchive(make()), false);
  const folder = (await fs.readdir(path.join(directory, 'download-pages')))[0];
  await fs.writeFile(path.join(directory, 'download-pages', folder, 'page2.png'), 'damaged');
  const repaired = [];
  await capturePages(make(), info, async (number) => {
    repaired.push(number);
    return bytes;
  });
  assert.deepEqual(repaired, [2]);
  const other = make();
  other.url = 'https://www.doc88.com/p-456.html';
  const fresh = [];
  await capturePages(other, info, async (number) => {
    fresh.push(number);
    return bytes;
  });
  assert.deepEqual(fresh, [1, 2, 3]);
});
test('interrupted OCR reuses completed pages and repairs corrupted cached text', async (t) => {
  const directory = await temporary(t);
  const zip = new JSZip();
  zip.file('page1.png', await fixture('fixture-1.png'));
  zip.file('page2.png', await fixture('fixture-2.png'));
  await fs.writeFile(
    path.join(directory, 'archive.zip'),
    await zip.generateAsync({ type: 'nodebuffer' }),
  );
  const interrupted = job(directory);
  interrupted.update = function (value) {
    Object.assign(this, value);
    if (value.current === 1) this.controller.abort();
  };
  await assert.rejects(convertArchive(interrupted));
  const resumed = job(directory);
  await convertArchive(resumed);
  assert.equal(resumed.reusedOCRPages, 1);
  assert.equal(
    (await PDFDocument.load(await fs.readFile(path.join(directory, 'result.pdf')))).getPageCount(),
    2,
  );
  const second = await fs.readFile(path.join(directory, 'ocr/page00002.pdf'));
  await fs.writeFile(path.join(directory, 'ocr/page00001.txt'), 'corrupted');
  const repaired = job(directory);
  await convertArchive(repaired);
  assert.equal(repaired.reusedOCRPages, 1);
  assert.match(await fs.readFile(path.join(directory, 'ocr/page00001.txt'), 'utf8'), /24680/);
  assert.equal(
    digest(await fs.readFile(path.join(directory, 'ocr/page00002.pdf'))),
    digest(second),
  );
});
