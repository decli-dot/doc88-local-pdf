const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os');
const { prepareOCRImage } = require('../image-quality.cjs');
const {
  buildStructure,
  normativeReferences,
  addPDFStructure,
} = require('../document-analysis.cjs');
const { dependency } = require('../runtime.cjs');
const { digest } = require('../page-check.cjs');
const { convertArchive } = require('../pipeline.cjs');
const { PDFDocument, PDFName } = dependency('pdf-lib');
const sharp = dependency('sharp');
const pages = [
  'Contents Page\n1 Scope ........ 1\n2 Normative references ........ 1\n3 Terms and definitions ........ 2\n4 Specification ........ 3\n4.1 General ........ 3\nAnnex A (informative) Example ........ 4\nBibliography ........ 5',
  '1 Scope\nThis document describes testing. ISO 9998:2020 is mentioned in scope only.\n2 Normative references\nISO 1101:2017, Geometrical tolerancing\nISO 8015:2011, Fundamentals\nISO 14405 (all parts), Dimensional tolerancing\n3 Terms and definitions\nISO 9997:2020 is a prose citation only.',
  '4 Specification\n4.1 General\nThe workpiece shall be inspected.\n4.1.1 Reference system\nThe reference system shall be recorded.',
  'Annex A\n(informative)\nExample\nA.1 Procedure\nA.1.1 Measurements\nMeasurements are recorded here.',
  'Bibliography\n[1] ISO 9999:2020, A bibliography reference',
];
test('document structure preserves nested clauses, annexes and bibliography with body page targets', () => {
  const result = buildStructure(pages);
  const root = result.nodes.find((n) => n.label === '4');
  assert.equal(root.page, 3);
  assert.equal(root.children[0].label, '4.1');
  assert.equal(root.children[0].children[0].label, '4.1.1');
  const annex = result.nodes.find((n) => n.kind === 'annex');
  assert.equal(annex.label, 'Annex A');
  assert.equal(annex.title, 'Example');
  assert.equal(annex.children[0].label, 'A.1');
  assert.equal(annex.children[0].children[0].label, 'A.1.1');
  assert.equal(result.nodes.find((n) => n.kind === 'bibliography').page, 5);
  assert.ok(result.nodes.every((n) => n.page !== 1));
});
test('normative references exclude scope, terms and bibliography and mark all-parts series', () => {
  const result = normativeReferences(pages);
  assert.equal(result.status, 'found');
  assert.deepEqual(
    result.items.map((n) => n.query),
    ['ISO 1101:2017', 'ISO 8015:2011', 'ISO 14405'],
  );
  assert.equal(result.items.at(-1).searchable, false);
  assert.equal(result.items.at(-1).series, true);
  const split = normativeReferences([
    '2\nNormative references\nISO 1101:2017\n3\nTerms and definitions\nISO 9999:2020',
  ]);
  assert.deepEqual(
    split.items.map((n) => n.query),
    ['ISO 1101:2017'],
  );
  assert.equal(normativeReferences(['1 Scope\nISO 1101:2017']).status, 'unconfirmed');
});
test('PDF stores hierarchical outline objects and valid destinations', async () => {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < pages.length; i++) pdf.addPage([600, 800]);
  addPDFStructure(pdf, buildStructure(pages));
  const reopened = await PDFDocument.load(await pdf.save());
  const root = reopened.catalog.lookup(PDFName.of('Outlines'));
  assert.ok(root);
  let current = root.lookup(PDFName.of('First'));
  let nested = false;
  while (current) {
    if (current.has(PDFName.of('First'))) {
      nested = true;
      const child = current.lookup(PDFName.of('First'));
      assert.ok(child.has(PDFName.of('Parent')));
      assert.ok(child.has(PDFName.of('Dest')));
    }
    const next = current.get(PDFName.of('Next'));
    current = next ? reopened.context.lookup(next) : null;
  }
  assert.equal(nested, true);
  assert.equal(reopened.getPageCount(), 5);
});
test('OCR preparation upscales small scans, preserves originals, and skips blank or disabled pages', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'doc88-quality-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('doc88-quality-test-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const source = path.join(__dirname, 'fixtures/fixture-1.png'),
    blank = path.join(__dirname, 'fixtures/fixture-3.png');
  const before = digest(await fs.readFile(source));
  const result = await prepareOCRImage(source, path.join(directory, 'enhanced.png'));
  assert.equal(result.enhanced, true);
  assert.equal(result.scaleX, 2);
  assert.equal((await sharp(result.path).metadata()).width, 2200);
  assert.equal(digest(await fs.readFile(source)), before);
  assert.equal((await prepareOCRImage(blank, path.join(directory, 'blank.png'))).enhanced, false);
  assert.equal(
    (await prepareOCRImage(source, path.join(directory, 'off.png'), false)).path,
    source,
  );
});

test('upscaled OCR keeps the original physical PDF page size', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'doc88-page-size-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('doc88-page-size-test-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const JSZip = dependency('jszip'),
    zip = new JSZip();
  zip.file('page1.png', await fs.readFile(path.join(__dirname, 'fixtures/fixture-1.png')));
  const archive = await zip.generateAsync({ type: 'nodebuffer' });
  const dimensions = [];
  for (const enabled of [false, true]) {
    const folder = path.join(directory, enabled ? 'enhanced' : 'original');
    await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, 'archive.zip'), archive);
    const job = {
      directory: folder,
      title: 'Physical page test',
      enhanceImages: enabled,
      controller: new AbortController(),
      log() {},
      update(values) {
        Object.assign(this, values);
      },
    };
    await convertArchive(job);
    const pdf = await PDFDocument.load(await fs.readFile(path.join(folder, 'result.pdf')));
    dimensions.push(pdf.getPage(0).getSize());
    assert.equal(job.imageEnhancement.count, enabled ? 1 : 0);
  }
  assert.ok(Math.abs(dimensions[0].width - dimensions[1].width) < 0.1);
  assert.ok(Math.abs(dimensions[0].height - dimensions[1].height) < 0.1);
});
