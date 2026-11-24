'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { repairDirectPages } = require('../direct-repair.cjs');
test('selective OCR replaces only requested pages and keeps other text and physical dimensions', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'declipdf-repair-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.ok(path.basename(directory).startsWith('declipdf-repair-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf
    .addPage([595, 842])
    .drawText('Document identity requires recognition.', { x: 45, y: 700, size: 18, font });
  pdf
    .addPage([842, 595])
    .drawText('Native vector text remains unchanged.', { x: 45, y: 450, size: 18, font });
  const source = path.join(directory, 'source.pdf');
  await fs.writeFile(source, await pdf.save());
  const job = {
    controller: new AbortController(),
    total: 56,
    url: 'https://www.doc88.com/p-1.html',
    ocrLanguage: 'eng',
    query: 'ASME Y14.3-2012',
    cacheDirectory: path.resolve(__dirname, '../.data/models'),
    update() {},
    log() {},
  };
  const result = await repairDirectPages(job, source, path.join(directory, 'repair'), [1]);
  const data = await fs.readFile(result),
    loaded = await PDFDocument.load(data);
  assert.equal(loaded.getPageCount(), 2);
  assert.deepEqual(loaded.getPage(0).getSize(), { width: 595, height: 842 });
  assert.deepEqual(loaded.getPage(1).getSize(), { width: 842, height: 595 });
  const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = lib.getDocument({ data: new Uint8Array(data), isEvalSupported: false });
  try {
    const parsed = await task.promise;
    const text = (await (await parsed.getPage(2)).getTextContent()).items
      .map((i) => i.str || '')
      .join('');
    assert.match(text, /Native vector text remains unchanged/);
    const first = (await (await parsed.getPage(1)).getTextContent()).items
      .map((i) => i.str || '')
      .join(' ');
    assert.match(first, /recognition/i);
  } finally {
    await task.destroy();
  }
});
