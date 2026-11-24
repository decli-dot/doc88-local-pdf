'use strict';
const { promisify } = require('node:util');
const inflate = promisify(require('node:zlib').inflate);
const { PDFName, PDFNumber, PDFRawStream, PDFDict } = require('pdf-lib');
const sharp = require('sharp');
const key = PDFName.of;
function pngData(png, width, height, channels) {
  if (
    !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    png.readUInt32BE(16) !== width ||
    png.readUInt32BE(20) !== height ||
    png[24] !== 8 ||
    png[25] !== (channels === 1 ? 0 : 2) ||
    png[28] !== 0
  )
    throw Error('Unexpected lossless PNG layout.');
  const chunks = [];
  for (let offset = 8; offset + 12 <= png.length;) {
    const size = png.readUInt32BE(offset),
      end = offset + 12 + size;
    if (end > png.length) throw Error('Truncated PNG.');
    if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT')
      chunks.push(png.subarray(offset + 8, offset + 8 + size));
    offset = end;
  }
  if (!chunks.length) throw Error('PNG has no image data.');
  return Buffer.concat(chunks);
}
async function compressPDFImages(pdf, { signal } = {}) {
  const result = {
    version: 1,
    lossless: true,
    images: 0,
    compressedImages: 0,
    imageBytesBefore: 0,
    imageBytesAfter: 0,
  };
  for (const [ref, stream] of pdf.context.enumerateIndirectObjects()) {
    signal?.throwIfAborted();
    if (!(stream instanceof PDFRawStream) || stream.dict.get(key('Subtype')) !== key('Image'))
      continue;
    const dict = stream.dict;
    const width = dict.lookupMaybe(key('Width'), PDFNumber)?.asNumber(),
      height = dict.lookupMaybe(key('Height'), PDFNumber)?.asNumber();
    const color = dict.get(key('ColorSpace')),
      channels = color === key('DeviceRGB') ? 3 : color === key('DeviceGray') ? 1 : 0;
    if (
      !channels ||
      dict.lookupMaybe(key('BitsPerComponent'), PDFNumber)?.asNumber() !== 8 ||
      dict.get(key('Filter')) !== key('FlateDecode') ||
      dict.has(key('Decode')) ||
      dict.has(key('SMask')) ||
      dict.has(key('Mask')) ||
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width < 1 ||
      height < 1 ||
      width * height > 50000000
    )
      continue;
    const params = dict.lookupMaybe(key('DecodeParms'), PDFDict);
    if (params && (params.lookupMaybe(key('Predictor'), PDFNumber)?.asNumber() ?? 1) !== 1)
      continue;
    const raw = await inflate(stream.contents, { maxOutputLength: width * height * channels + 1 });
    if (raw.length !== width * height * channels) continue;
    result.images++;
    result.imageBytesBefore += stream.contents.length;
    let pixels = raw,
      outputChannels = channels;
    if (channels === 3) {
      let gray = true;
      for (let i = 0; i < raw.length; i += 3)
        if (raw[i] !== raw[i + 1] || raw[i] !== raw[i + 2]) {
          gray = false;
          break;
        }
      if (gray) {
        pixels = Buffer.allocUnsafe(width * height);
        for (let i = 0; i < pixels.length; i++) pixels[i] = raw[i * 3];
        outputChannels = 1;
      }
    }
    let encoder = sharp(pixels, { raw: { width, height, channels: outputChannels } });
    if (outputChannels === 1) encoder = encoder.toColourspace('b-w');
    const png = await encoder
      .png({ compressionLevel: 9, adaptiveFiltering: true, palette: false })
      .toBuffer();
    const compressed = pngData(png, width, height, outputChannels);
    let after = stream.contents.length;
    if (compressed.length + 128 < stream.contents.length) {
      let decoder = sharp(png);
      if (outputChannels === 1) decoder = decoder.toColourspace('b-w');
      const decoded = await decoder.raw().toBuffer({ resolveWithObject: true });
      if (decoded.info.channels !== outputChannels || !decoded.data.equals(pixels))
        throw Error('Lossless image verification failed.');
      signal?.throwIfAborted();
      const replacement = dict.clone(pdf.context);
      replacement.set(key('ColorSpace'), key(outputChannels === 1 ? 'DeviceGray' : 'DeviceRGB'));
      replacement.set(
        key('DecodeParms'),
        pdf.context.obj({
          Predictor: 15,
          Colors: outputChannels,
          Columns: width,
          BitsPerComponent: 8,
        }),
      );
      replacement.set(key('Length'), PDFNumber.of(compressed.length));
      pdf.context.assign(ref, PDFRawStream.of(replacement, compressed));
      after = compressed.length;
      result.compressedImages++;
    }
    result.imageBytesAfter += after;
  }
  return result;
}
module.exports = { compressPDFImages };
