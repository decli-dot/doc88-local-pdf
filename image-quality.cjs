'use strict';
const { dependency } = require('./runtime.cjs');
const { atomicWrite } = require('./checkpoints.cjs');
async function prepareOCRImage(input, output, enabled = true) {
  if (!enabled) return { path: input, scaleX: 1, scaleY: 1, enhanced: false };
  const sharp = dependency('sharp');
  const options = { limitInputPixels: 50000000 };
  const meta = await sharp(input, options).metadata();
  const stats = await sharp(input, options).stats();
  const width = meta.width,
    height = meta.height;
  if (!width || !height) throw Error('Не удалось определить размер изображения страницы.');
  const blank = stats.channels.every((channel) => channel.stdev < 2);
  const small = Math.min(width, height) < 1700;
  const soft = stats.sharpness < 1;
  let scale = blank || (!small && !soft) ? 1 : small ? 2 : 1.5;
  scale = Math.max(
    1,
    Math.min(scale, 4200 / Math.max(width, height), Math.sqrt(12000000 / (width * height))),
  );
  const info = {
    scaleX: 1,
    scaleY: 1,
    enhanced: false,
    width,
    height,
    inputSharpness: Number(stats.sharpness.toFixed(2)),
  };
  if (scale < 1.15) return { path: input, ...info };
  const outputWidth = Math.round(width * scale),
    outputHeight = Math.round(height * scale);
  const bytes = await sharp(input, options)
    .resize(outputWidth, outputHeight, { fit: 'fill', kernel: 'lanczos3' })
    .sharpen({ sigma: 0.6, m1: 0.5, m2: 1.2 })
    .png()
    .toBuffer();
  await atomicWrite(output, bytes);
  return {
    path: output,
    ...info,
    enhanced: true,
    scaleX: outputWidth / width,
    scaleY: outputHeight / height,
    outputWidth,
    outputHeight,
    reason: small ? 'small' : 'soft',
  };
}
module.exports = { prepareOCRImage };
