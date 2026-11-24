'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { PDFDocument, PDFName, StandardFonts } = require('pdf-lib');
const { buildStructure, headingFor } = require('../structure.cjs');
const { layoutLines } = require('../structure-layout.cjs');
const { structureFromPDF } = require('../pdf-structure.cjs');
const { addPDFStructure } = require('../document-analysis.cjs');
const { tsvItems } = require('../heading-ocr.cjs');
const flatten = (nodes) => nodes.flatMap((node) => [node, ...flatten(node.children)]);
test('continued contents and symbol-table references cannot precede their actual parent sections', () => {
  const result = buildStructure([
      'Contents\n1 Scope ........ 1\n5 Symbols ........ 2\n8 Geometrical specifications ........ 3\n17 Profile tolerancing ........ 4',
      '17.17.01 Gemeral\n17.17.1 General',
      '1 Scope\nThis document describes tolerances.',
      '5 Symbols\n8.2.2.1.3 Constraint specification elements\n8.4.2 Major diameter',
      '8 Geometrical specifications\n8.1 General',
      '17 Profile tolerancing\n17.17.1 General',
    ]),
    nodes = flatten(result.nodes);
  assert.equal(
    nodes.some((node) => node.label === '17.17.01'),
    false,
  );
  assert.equal(
    nodes.some((node) => node.label === '8.2.2.1.3'),
    false,
  );
  assert.equal(
    nodes.some((node) => node.label === '8.4.2'),
    false,
  );
  assert.equal(
    nodes.find((node) => node.label === '17.17.1').page,
    6,
    'use the actual later heading instead of a contents duplicate',
  );
  assert.equal(nodes.find((node) => node.label === '8.1').page, 5);
  assert.equal(result.count, nodes.length);
});
test('page numbers, licence footers, prose, table entries and figure contents do not become sections', () => {
  const contents =
    'CONTENTS\n1 General ........ 1\n1.1 Scope ........ 1\n2 Thread Types ........ 2\n3 Requirements ........ 2\nTables\n1 Thread Series Designations ........ 3\nFigures\n60 Example figure ........ 4';
  const pages = [
    contents,
    '1 GENERAL\n1.1 Scope\nThis standard describes threads.\n2\nCopyright ASME International\nProvided by IHS under license with ASME',
    '2 THREAD TYPES\n3 REQUIREMENTS\n3.1 Representation\n3.1.1 Simplified Representation. The drawing method applies here.\n3.1.1.1 The thread should be indicated here.\n3.2.2 60 Deg Inch Screw Thread Designations.\n3\nCopyright ASME International',
    '6 BUTT Buttress threads: pull 61.9 II4\n10 (.190)-32 UNF-2A\n60 deg form, Acme, Stub Acme\n15 through 17 illustrate the elements\n3.3.9 Except for a rolled thread, the external thread\n4\nCopyright ASME International',
  ];
  const result = buildStructure(pages),
    nodes = flatten(result.nodes);
  assert.deepEqual(
    result.nodes.map((node) => node.label),
    ['1', '2', '3'],
  );
  assert.equal(nodes.find((node) => node.label === '1').title, 'General');
  assert.equal(nodes.find((node) => node.label === '3.1.1').title, 'Simplified Representation');
  assert.ok(nodes.some((node) => node.label === '3.2.2'));
  assert.ok(nodes.every((node) => node.page !== 1));
  assert.doesNotMatch(JSON.stringify(nodes), /Copyright|IHS|BUTT|UNF|Except|figure/i);
});
test('German and French contents retain real annex and bibliography destinations', () => {
  for (const [contents, scope, annex, title, bibliography] of [
    ['Inhaltsverzeichnis', 'Anwendungsbereich', 'Anhang A', 'Verfahren', 'Literaturhinweise'],
    ['Sommaire', 'Domaine d’application', 'Annexe A', 'Méthode', 'Bibliographie'],
  ]) {
    const result = buildStructure([
      `${contents}\n1 ${scope} ........ 1\n${annex} (normative) ${title} ........ 2\n${bibliography} ........ 3`,
      `1 ${scope}\nDescription.`,
      `${annex}\n(normative)\n${title}\nA.1 General\nA.1.1 Details`,
      bibliography,
    ]);
    const node = result.nodes.find((node) => node.kind === 'annex');
    assert.equal(node.page, 3);
    assert.equal(node.title, title);
    assert.equal(node.children[0].children[0].label, 'A.1.1');
    assert.equal(result.nodes.find((node) => node.kind === 'bibliography').page, 4);
  }
});
test('two-column glyph layout preserves separate headings instead of appending opposite-column prose', () => {
  const item = (str, x, y, width, height = 12) => ({
    str,
    width,
    height,
    fontName: 'body',
    transform: [height, 0, 0, height, x, y],
  });
  const items = [];
  for (let n = 0; n < 6; n++) {
    items.push(item('Left column prose with sufficient letters', 40, 650 - n * 20, 220));
    items.push(item('Right column prose with sufficient letters', 330, 650 - n * 20, 220));
  }
  items.push(
    item('1 GENERAL', 40, 700, 120, 14),
    item('ASME reference text in the other column', 330, 700, 220),
  );
  const layout = layoutLines(items, 600, 800);
  assert.equal(layout.columns, 2);
  assert.equal(layout.lines.find((line) => line.text === '1 GENERAL').column, 0);
  assert.ok(!layout.lines.some((line) => /GENERAL.*ASME/.test(line.text)));
  assert.ok(
    layout.lines.findIndex((line) => line.text.includes('Right column')) >
      layout.lines.findIndex((line) => line.text === '1 GENERAL'),
  );
  const result = buildStructure([''], { layouts: [layout] });
  assert.equal(result.nodes[0].title, 'GENERAL');
});
test('PDF layout finds actual body targets and replaces old outlines with precise destinations', async () => {
  const pdf = await PDFDocument.create(),
    normal = await pdf.embedFont(StandardFonts.Helvetica),
    bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let page = pdf.addPage([600, 800]);
  page.drawText('Contents\n1 General .... 1\n1.1 Scope .... 1\n2 Requirements .... 1', {
    x: 40,
    y: 750,
    size: 12,
    font: normal,
    lineHeight: 20,
  });
  page = pdf.addPage([600, 800]);
  page.drawText('1 GENERAL', { x: 40, y: 700, size: 16, font: bold });
  page.drawText('1.1 Scope', { x: 40, y: 660, size: 14, font: bold });
  page.drawText('2 REQUIREMENTS', { x: 330, y: 700, size: 16, font: bold });
  for (let i = 0; i < 6; i++) {
    page.drawText('Left column describes the document.', {
      x: 40,
      y: 620 - i * 22,
      size: 10,
      font: normal,
    });
    page.drawText('Right column contains requirements.', {
      x: 330,
      y: 620 - i * 22,
      size: 10,
      font: normal,
    });
  }
  page.drawText('8\nCopyright ASME International', {
    x: 40,
    y: 40,
    size: 9,
    font: normal,
    lineHeight: 12,
  });
  addPDFStructure(pdf, {
    nodes: [{ label: '99', title: 'Old incorrect outline', page: 1, children: [] }],
  });
  const structure = await structureFromPDF(await pdf.save());
  assert.equal(structure.count, 3);
  assert.deepEqual(
    structure.nodes.map((node) => node.label),
    ['1', '2'],
  );
  assert.ok(flatten(structure.nodes).every((node) => node.page === 2));
  assert.equal(structure.nodes[0].children[0].title, 'Scope');
  addPDFStructure(pdf, structure);
  let reopened = await PDFDocument.load(await pdf.save()),
    root = reopened.catalog.lookup(PDFName.of('Outlines')),
    first = root.lookup(PDFName.of('First'));
  assert.equal(first.lookup(PDFName.of('Title')).decodeText(), '1 General');
  const dest = first.lookup(PDFName.of('Dest'));
  assert.ok(dest.lookup(3).asNumber() > 690 && dest.lookup(3).asNumber() < 740);
  addPDFStructure(pdf, { nodes: [] });
  reopened = await PDFDocument.load(await pdf.save());
  assert.equal(reopened.catalog.has(PDFName.of('Outlines')), false);
  assert.equal(reopened.catalog.has(PDFName.of('PageMode')), false);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(structureFromPDF(await pdf.save(), [], { signal: controller.signal }));
});
test('unnamed numbered prose is omitted while named run-in subsections and wrapped titles remain', () => {
  assert.equal(
    headingFor('3.1.1 Simplified Representation. The simplified method applies.').title,
    'Simplified Representation',
  );
  assert.equal(headingFor('3.3.11 The full diameter depth shall be specified.'), null);
  assert.equal(headingFor('4 Copyright ASME International'), null);
  assert.equal(
    headingFor('3.2.2 60 Deg Inch Screw Thread Designations.').title,
    '60 Deg Inch Screw Thread Designations',
  );
});

test('OCR word boxes with descenders share their actual TSV line baseline', () => {
  const tsv =
    'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t1\t1\t1\t1\t75\t500\t11\t17\t90\t2\n5\t1\t1\t1\t1\t2\t115\t500\t120\t17\t90\tNormative\n5\t1\t1\t1\t1\t3\t242\t500\t163\t23\t90\tVerweisungen';
  const items = tsvItems(tsv, 2, 800);
  assert.ok(items.every((item) => item.transform[5] === items[0].transform[5]));
  const layout = layoutLines(items, 600, 800);
  assert.ok(layout.lines.some((line) => line.text.includes('Normative Verweisungen')));
});
