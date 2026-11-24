const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PDFDocument, StandardFonts, PDFName } = require('pdf-lib');
const { importPDF } = require('../pdf-input.cjs');
const { cleanText, documentText, textFromItems } = require('../copy-text.cjs');
const { runSearchJob } = require('../search.cjs');

test('PDF import passes the search verification pipeline with official naming, extent checks and ready copy text', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'declipdf-pdf-source-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('declipdf-pdf-source-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([600, 800]);
  page.drawText(
    'DIN 9999:2020-03\n1 Scope\nThis document specifies the measurement requirements for manufactured parts.\nThe method shall be used with the specified reference system.\nEach feature is measured independently and the results are recorded in the report.\nA surface can be evaluated by more than one method.\nThe selected method shall be stated in the report.\nThe operator should check that the equipment is suitable for the measurement.',
    { x: 30, y: 740, font, size: 11, lineHeight: 18 },
  );
  const bytes = await pdf.save();
  const job = {
    query: 'DIN 9999',
    documentLanguage: 'eng',
    directory,
    ocrLanguage: 'eng',
    controller: new AbortController(),
    log() {},
    update(value) {
      Object.assign(this, value);
    },
  };
  await runSearchJob(job, directory, {
    convert: importPDF,
    lookupPublisher: async () => ({
      publisher: 'DIN',
      reference: 'DIN 9999:2020-03',
      title: 'Synthetic official title',
      pageCount: 1,
      status: 'Published',
    }),
    search: async () => [
      {
        provider: 'doc88',
        url: 'https://www.doc88.com/p-123.html',
        title: 'DIN 9999:2020-03',
        format: 'PDF',
        pageCount: null,
      },
    ],
    download: async (child) => fs.writeFile(path.join(child.directory, 'source.pdf'), bytes),
  });
  assert.equal(job.stage, 'done', JSON.stringify(job.searchResults));
  assert.equal(job.archiveReady, false);
  assert.equal(job.copyTextReady, true);
  assert.match(job.pdfFilename, /DIN 9999 2020-03 Synthetic official title/);
  assert.equal(job.verification.extent.status, 'passed');
  assert.match(
    await fs.readFile(path.join(directory, 'copy-text.txt'), 'utf8'),
    /manufactured parts/,
  );
});

test('unusable native text can be OCRed from the verified local PDF without another download', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'declipdf-local-scan-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), os.tmpdir());
    await fs.rm(directory, { recursive: true, force: true });
  });
  const source = await PDFDocument.create(),
    font = await source.embedFont(StandardFonts.Helvetica),
    page = source.addPage([400, 500]);
  page.drawText(
    'DIN 9999:2020-03\nThis document defines the requirements for measurement.\nThe method shall be used for the specified surface.\nEach feature is measured and the result is recorded.',
    { x: 20, y: 460, font, size: 10, lineHeight: 18 },
  );
  await fs.mkdir(path.join(directory, 'direct'));
  const bytes = await source.save();
  await fs.writeFile(path.join(directory, 'direct/source.pdf'), bytes);
  const progress = [];
  const job = {
    directory,
    query: 'DIN 9999:2020-03',
    documentLanguage: 'eng',
    ocrLanguage: 'eng',
    title: 'DIN 9999:2020-03',
    controller: new AbortController(),
    update(x) {
      Object.assign(this, x);
      if (this.stage === 'ocr') progress.push({ current: this.current, total: this.total });
    },
    log() {},
  };
  await require('../document-engine.cjs').processDocument(job, directory, {
    direct: async () => {
      throw Object.assign(Error('Scan requires OCR'), {
        code: 'DIRECT_TEXT_UNUSABLE',
        localPDF: { sha256: require('../page-check.cjs').digest(bytes), total: 1 },
      });
    },
  });
  assert.equal(job.processingEngine, 'ocr');
  assert.equal(job.scannedOCRPages, 1);
  assert.equal(job.reusedDownloadPages, 1);
  assert.equal(job.pdfReady, true);
  assert.equal(job.total, 1);
  assert.ok(
    progress.some((x) => x.current === 0 && x.total === 1),
    'full OCR starts at zero instead of the last downloaded page',
  );
  assert.ok(
    progress.some((x) => x.current === 1 && x.total === 1),
    'full OCR reports actual completed pages',
  );
  assert.match(
    await fs.readFile(path.join(directory, 'ocr/page00001.txt'), 'utf8'),
    /measurement/i,
  );
});
test('copy text joins prose and supported word wraps, preserves compounds, numbered clauses, numbers and table cells', () => {
  assert.equal(
    cleanText('These specifi-\ncations describe the\nmeasurement method.'),
    'These specifications describe the measurement method.',
  );
  assert.equal(cleanText('datum-\nfeature'), 'datum-feature');
  assert.match(
    documentText(['1 Scope\nSome text.\n\n2 Requirements\nA\tB\n1\t2']),
    /1 Scope\nSome text\.\n\n2 Requirements\nA\tB\n1\t2/,
  );
  const item = (str, x, y, width = 190) => ({
    str,
    transform: [10, 0, 0, 10, x, y],
    height: 10,
    width,
  });
  const columns = Array.from({ length: 6 }, (_, i) => [
    item('Left column prose with enough characters ' + i, 20, 700 - i * 15),
    item('Right column prose with enough characters ' + i, 330, 700 - i * 15),
  ]).flat();
  const text = textFromItems(columns, 600);
  assert.ok(
    text.indexOf('Left column prose with enough characters 5') < text.indexOf('Right column prose'),
  );
  assert.equal(textFromItems([item('A', 20, 100, 10), item('B', 200, 100, 10)], 600), 'A\tB');
});
test('PDF import preserves vector text, OCRs scanned pages and keeps page size and cleaned copy text', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'declipdf-pdf-input-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('declipdf-pdf-input-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica);
  let page = pdf.addPage([600, 800]);
  page.drawText('ISO 99999:2026', { x: 40, y: 750, font, size: 18 });
  page.drawText(
    '1 Scope\nThis document specifies the measurement requirements for the manufactured parts.\nEach feature shall be inspected and the results shall be recorded in the report.',
    { x: 40, y: 700, font, size: 11, lineHeight: 16 },
  );
  const image = await pdf.embedPng(
    await fs.readFile(path.join(__dirname, 'fixtures/fixture-1.png')),
  );
  page = pdf.addPage([600, 800]);
  page.drawImage(image, { x: 0, y: 0, width: 600, height: 800 });
  await fs.writeFile(path.join(directory, 'source.pdf'), await pdf.save());
  const progress = [];
  const job = {
    directory,
    title: 'Synthetic PDF test',
    ocrLanguage: 'eng',
    cacheDirectory: process.env.DOC88_OCR_CACHE,
    controller: new AbortController(),
    enhanceImages: false,
    update(value) {
      Object.assign(this, value);
      if (this.stage === 'ocr') progress.push({ current: this.current, total: this.total });
    },
    log() {},
  };
  await importPDF(job);
  assert.equal(job.stage, 'done');
  assert.equal(job.nativeTextPages, 1);
  assert.equal(job.scannedOCRPages, 1);
  assert.equal(job.total, 2);
  assert.ok(
    progress.some((x) => x.current === 1 && x.total === 2),
    'native pages are counted while the scanned page is pending',
  );
  assert.ok(
    progress.some((x) => x.current === 2 && x.total === 2),
    'OCR completion maps back to the full document',
  );
  assert.equal(job.copyTextReady, true);
  const result = await PDFDocument.load(await fs.readFile(path.join(directory, 'result.pdf')));
  assert.equal(result.getPageCount(), 2);
  assert.equal(result.getPages()[0].getWidth(), 600);
  assert.ok(Math.abs(result.getPages()[1].getHeight() - 800) < 0.1);
  assert.match(
    await fs.readFile(path.join(directory, 'ocr/page00001.txt'), 'utf8'),
    /ISO 99999:2026/,
  );
  assert.match(
    await fs.readFile(path.join(directory, 'copy-text.txt'), 'utf8'),
    /manufactured parts/,
  );
  assert.ok((await fs.stat(path.join(directory, 'ocr/page00002.txt'))).size > 100);
});

test('native PDF import retains shared images and fonts without multiplying them per page', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'declipdf-shared-pdf-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('declipdf-shared-pdf-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica);
  const image = await pdf.embedPng(
    await fs.readFile(path.join(__dirname, 'fixtures/fixture-1.png')),
  );
  for (let n = 0; n < 8; n++) {
    const page = pdf.addPage([600, 800]);
    page.drawText(
      'ISO 129-1:2018\nThis document specifies the measurement requirements for manufactured parts and the selected method shall be recorded.',
      { font, x: 30, y: 750, size: 10 },
    );
    page.drawImage(image, { x: 40, y: 80, width: 250, height: 350 });
  }
  const input = await pdf.save();
  await fs.writeFile(path.join(directory, 'source.pdf'), input);
  const job = {
    directory,
    title: 'Native import',
    ocrLanguage: 'eng',
    controller: new AbortController(),
    log() {},
    update(value) {
      Object.assign(this, value);
    },
  };
  await importPDF(job);
  const output = await fs.readFile(path.join(directory, 'result.pdf')),
    result = await PDFDocument.load(output);
  assert.equal(result.getPageCount(), 8);
  assert.equal(job.nativeTextPages, 8);
  const refs = result.getPages().map((page) => {
    const images = page.node.Resources().lookup(PDFName.of('XObject'));
    return images.get(images.keys()[0]).toString();
  });
  assert.equal(new Set(refs).size, 1);
  assert.ok(
    output.length < input.length * 2,
    'native resources must not grow with every copied page',
  );
});
