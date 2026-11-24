'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { PDFDocument, PDFName, PDFNumber } = require('pdf-lib');
const {
  configuration,
  decode,
  encode,
  rectBytes,
  assemblePage,
  validateSWF,
  normalizeBlankGlyphs,
  mapLimit,
  deduplicateStreams,
} = require('../experimental/direct-extractor.cjs');
const { textRuns, nativeLayoutText } = require('../experimental/quality.cjs');
function metadata(value) {
  const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',
    b = 'PJLKMNOI3xyz021wvrpqstouHCFBDEGAnhikjlmgfZbacedYRXTSUVQW!56789+4';
  return [...Buffer.from(value).toString('base64')]
    .map((c) => (a.includes(c) ? b[a.indexOf(c)] : c))
    .join('');
}
function html(overrides = {}) {
  return (
    'm_main.init("' +
    metadata(
      JSON.stringify({
        p_code: '123',
        p_name: 'Example',
        ebt_host: 'https://ebt245.doc88.com',
        headerInfo: '"55"',
        p_swf: 'abc-123',
        pageInfo: metadata('1-595-842-55-123'),
        p_pagecount: '1',
        pageCount: 1,
        ...overrides,
      }),
    ) +
    '");'
  );
}
test('direct extraction validates viewer identity, extent and resource hosts before downloading', () => {
  const c = configuration(html(), 'https://www.doc88.com/p-123.html');
  assert.equal(c.total, 1);
  assert.equal(
    decode(encode('1-55-123'), 'PJKLMNOI3xyz012wvprqstuoHBCDEFGAnhijklmgfZabcdeYXRSTUVWQ!56789+4'),
    '1-55-123',
  );
  assert.throws(() => configuration(html({ p_code: '124' }), c.sourceURL), /identity/);
  assert.throws(() => configuration(html({ p_pagecount: '2' }), c.sourceURL), /не все/);
  assert.throws(() => configuration(html({ ebt_host: 'https://127.0.0.1' }), c.sourceURL), /адрес/);
  assert.throws(
    () => configuration(html({ pageInfo: metadata('2-595-842-55-123') }), c.sourceURL),
    /range/,
  );
  assert.throws(
    () => configuration('<p>Access required</p>', c.sourceURL),
    (e) => e.code === 'ACCESS_REQUIRED',
  );
});
test('resource assembler preserves tags, writes correct dimensions and rejects truncated drawing streams', () => {
  const size = rectBytes(400, 500);
  const dict = Buffer.concat([
    Buffer.from('FWS\x09\0\0\0\0', 'binary'),
    size,
    Buffer.from([0, 12, 0, 0]),
  ]);
  const header = Buffer.concat([Buffer.alloc(40), zlib.deflateSync(dict)]);
  const drawing = Buffer.from([0x43, 0x02, 255, 255, 255]); // SetBackgroundColor.
  const resource = Buffer.concat([Buffer.alloc(32), zlib.deflateSync(drawing)]);
  const out = assemblePage(header, resource, { width: 595, height: 842 });
  assert.deepEqual(validateSWF(out), { frames: 1 });
  assert.equal(out.readUInt32LE(4), out.length);
  assert.ok(out.includes(rectBytes(595, 842)));
  const bad = Buffer.concat([Buffer.alloc(32), zlib.deflateSync(Buffer.from([0x43, 0x02, 255]))]);
  assert.throws(() => assemblePage(header, bad, { width: 595, height: 842 }), /SWF/);
  assert.throws(
    () => assemblePage(header.subarray(0, 20), resource, { width: 595, height: 842 }),
    /Truncated/,
  );
});
test('bounded pool keeps page order and waits for in-flight work after a failure', async () => {
  let active = 0,
    peak = 0;
  const values = await mapLimit([0, 1, 2, 3, 4], 2, async (value) => {
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, value % 2 ? 2 : 5));
    active--;
    return value * 10;
  });
  assert.deepEqual(values, [0, 10, 20, 30, 40]);
  assert.equal(peak, 2);
  let finished = false;
  await assert.rejects(
    mapLimit([0, 1, 2], 2, async (value) => {
      if (value === 0) throw Error('Broken page');
      await new Promise((resolve) => setTimeout(resolve, 10));
      finished = true;
    }),
    /Broken page/,
  );
  assert.equal(finished, true);
});
test('native glyphs retain words and real spaces for search and copy', () => {
  assert.equal(
    textRuns([
      { str: 'D' },
      { str: 'I' },
      { str: 'N' },
      { str: ' ' },
      { str: 'EN' },
      { str: ' ' },
      { str: 'ISO', hasEOL: true },
      { str: '129-1' },
    ]),
    'DIN EN ISO\n129-1',
  );
  const items = [
    { str: 'D', x: 0, width: 5 },
    { str: 'I', x: 5.1, width: 2 },
    { str: 'N', x: 7.2, width: 5 },
    { str: ' ', x: 12.2, width: 3 },
    { str: 'E', x: 15.2, width: 5 },
    { str: 'N', x: 20.3, width: 5 },
  ].map((item) => ({ ...item, height: 10, transform: [10, 0, 0, 10, item.x, 100] }));
  assert.equal(nativeLayoutText(items, 600), 'DIN EN');
});
function fontTag(id, code, shape) {
  const body = Buffer.alloc(13 + shape.length);
  body.writeUInt16LE(id);
  body[2] = 4; // Wide codes, 16-bit offsets.
  body.writeUInt16LE(1, 5);
  body.writeUInt16LE(4, 7);
  body.writeUInt16LE(4 + shape.length, 9);
  shape.copy(body, 11);
  body.writeUInt16LE(code, 11 + shape.length);
  const tag = Buffer.alloc(2);
  tag.writeUInt16LE((48 << 6) | body.length);
  return Buffer.concat([tag, body]);
}
function fontSWF(tags) {
  const value = Buffer.concat([
    Buffer.from('FWS\x09\0\0\0\0', 'binary'),
    rectBytes(595, 842),
    Buffer.from([0, 12, 1, 0]),
    ...tags,
    Buffer.from([0x40, 0, 0, 0]),
  ]);
  value.writeUInt32LE(value.length, 4);
  return value;
}
test('blank-glyph compatibility fix requires matching outlines and preserves geometry', () => {
  const blank = Buffer.from('100a08930400', 'hex');
  const source = fontSWF([fontTag(1, 32, blank), fontTag(2, 9, blank)]);
  const original = Buffer.from(source);
  assert.equal(normalizeBlankGlyphs(source), 1);
  assert.deepEqual(validateSWF(source), { frames: 1 });
  const differences = [...source].flatMap((byte, index) =>
    byte !== original[index] ? [index] : [],
  );
  assert.equal(differences.length, 1);
  assert.equal(source[differences[0]], 32);
  assert.equal(original[differences[0]], 9);
  assert.equal(normalizeBlankGlyphs(source), 0);
  assert.equal(normalizeBlankGlyphs(fontSWF([fontTag(2, 9, blank)])), 0);
  assert.equal(
    normalizeBlankGlyphs(fontSWF([fontTag(1, 32, blank), fontTag(2, 9, Buffer.from([0, 1]))])),
    0,
  );
});
test('PDF resource deduplication rewrites references but preserves streams with different decoding dictionaries', async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage();
  const a = pdf.context.register(
    pdf.context.flateStream(Buffer.from('shared font bytes'), { Length1: PDFNumber.of(100) }),
  );
  const b = pdf.context.register(
    pdf.context.flateStream(Buffer.from('shared font bytes'), { Length1: PDFNumber.of(100) }),
  );
  const different = pdf.context.register(
    pdf.context.flateStream(Buffer.from('shared font bytes'), { Length1: PDFNumber.of(200) }),
  );
  const resources = pdf.context.obj({ A: a, B: b, Different: different, Nested: [b] });
  pdf.catalog.set(PDFName.of('ResourceFixture'), resources);
  assert.equal(deduplicateStreams(pdf), 1);
  assert.equal(resources.get(PDFName.of('A')), resources.get(PDFName.of('B')));
  assert.notEqual(resources.get(PDFName.of('A')), resources.get(PDFName.of('Different')));
  assert.equal(resources.lookup(PDFName.of('Nested')).get(0), a);
  assert.equal((await PDFDocument.load(await pdf.save())).getPageCount(), 1);
});
