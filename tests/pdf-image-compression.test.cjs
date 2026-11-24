const test = require('node:test'),
  assert = require('node:assert/strict');
const zlib = require('node:zlib');
const lib = require('pdf-lib');
const { createCanvas } = require('@napi-rs/canvas');
const { compressPDFImages } = require('../pdf-image-compression.cjs');
async function pixels(bytes) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false });
  try {
    const pdf = await task.promise,
      page = await pdf.getPage(1),
      viewport = page.getViewport({ scale: 1.5 });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height)),
      context = canvas.getContext('2d');
    await page.render({ canvasContext: context, viewport }).promise;
    const text = (await page.getTextContent()).items.map((x) => x.str || '').join('');
    return {
      pixels: Buffer.from(context.getImageData(0, 0, canvas.width, canvas.height).data),
      text,
    };
  } finally {
    await task.destroy();
  }
}
test('lossless image compression preserves rendered fine lines, colours, text and PDF dimensions', async () => {
  for (const colorful of [true, false]) {
    const width = 320,
      height = 260,
      raw = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 3,
          v = (x * 3 + y * 7) % 256;
        raw[i] = v;
        raw[i + 1] = v;
        raw[i + 2] = v;
        if (colorful && x > 120 && x < 130) {
          raw[i] = 255;
          raw[i + 1] = 30;
          raw[i + 2] = 10;
        }
      }
    const pdf = await lib.PDFDocument.create(),
      page = pdf.addPage([width, height]);
    const image = lib.PDFRawStream.of(
      pdf.context.obj({
        Type: 'XObject',
        Subtype: 'Image',
        Width: width,
        Height: height,
        ColorSpace: 'DeviceRGB',
        BitsPerComponent: 8,
        Filter: 'FlateDecode',
        DecodeParms: { Predictor: 1, Colors: 3, Columns: width, BitsPerComponent: 8 },
      }),
      zlib.deflateSync(raw),
    );
    const ref = pdf.context.register(image),
      name = page.node.newXObject('Bitmap', ref);
    page.pushOperators(
      lib.pushGraphicsState(),
      lib.concatTransformationMatrix(width, 0, 0, height, 0, 0),
      lib.drawObject(name),
      lib.popGraphicsState(),
    );
    const font = await pdf.embedFont(lib.StandardFonts.Helvetica);
    page.drawText('ISO 1101 0.01', { font, size: 9, x: 10, y: 10 });
    const before = await pdf.save(),
      original = await pixels(before);
    const stats = await compressPDFImages(pdf);
    assert.equal(stats.compressedImages, 1);
    assert.ok(stats.imageBytesAfter < stats.imageBytesBefore);
    const after = await pdf.save(),
      rendered = await pixels(after);
    assert.deepEqual(rendered.pixels, original.pixels);
    assert.equal(rendered.text, original.text);
    assert.match(rendered.text, /0.01/);
    assert.deepEqual((await lib.PDFDocument.load(after)).getPage(0).getSize(), { width, height });
    assert.equal(
      pdf.context.lookup(ref).dict.get(lib.PDFName.of('ColorSpace')),
      lib.PDFName.of(colorful ? 'DeviceRGB' : 'DeviceGray'),
    );
    assert.equal(
      (await compressPDFImages(pdf)).compressedImages,
      0,
      'already compressed streams are not transformed again',
    );
  }
});
