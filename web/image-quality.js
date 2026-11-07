'use strict';
async function prepare(image, enabled = true) {
  const bitmap = await createImageBitmap(image);
  const width = bitmap.width,
    height = bitmap.height;
  try {
    if (!width || !height || width * height > 50000000)
      throw Error('Некорректный размер изображения страницы.');
    if (!enabled) return { image, width, height, scaleX: 1, scaleY: 1, enhanced: false };
    const sample = new OffscreenCanvas(
      Math.max(1, Math.round(width * Math.min(1, 512 / width))),
      Math.max(1, Math.round(height * Math.min(1, 512 / width))),
    );
    const ctx = sample.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, sample.width, sample.height);
    const pixels = ctx.getImageData(0, 0, sample.width, sample.height).data;
    let dark = 0,
      gradient = 0,
      edges = 0;
    for (let i = 4; i < pixels.length; i += 4) {
      const gray = (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
      if (gray < 235) dark++;
      const diff = Math.abs(gray - (pixels[i - 4] + pixels[i - 3] + pixels[i - 2]) / 3);
      gradient += diff;
      if (diff > 5) edges++;
    }
    const blank = dark < (pixels.length / 4) * 0.0005;
    const small = Math.min(width, height) < 1700;
    const soft = edges > 20 && gradient / edges < 18;
    let scale = blank ? 1 : small ? 2 : soft ? 1.5 : 1;
    scale = Math.min(scale, 4200 / Math.max(width, height), Math.sqrt(12000000 / (width * height)));
    if (scale <= 1.05) return { image, width, height, scaleX: 1, scaleY: 1, enhanced: false };
    const target = new OffscreenCanvas(Math.round(width * scale), Math.round(height * scale));
    const drawing = target.getContext('2d', { willReadFrequently: true });
    drawing.imageSmoothingEnabled = true;
    drawing.imageSmoothingQuality = 'high';
    drawing.drawImage(bitmap, 0, 0, target.width, target.height);
    const data = drawing.getImageData(0, 0, target.width, target.height),
      original = new Uint8ClampedArray(data.data);
    const stride = target.width * 4;
    for (let y = 1; y < target.height - 1; y++)
      for (let x = 1; x < target.width - 1; x++) {
        const i = y * stride + x * 4;
        for (let c = 0; c < 3; c++)
          data.data[i + c] =
            original[i + c] * 1.4 -
            0.1 *
              (original[i + c - 4] +
                original[i + c + 4] +
                original[i + c - stride] +
                original[i + c + stride]);
      }
    drawing.putImageData(data, 0, 0);
    return {
      image: await target.convertToBlob({ type: 'image/png' }),
      width,
      height,
      scaleX: target.width / width,
      scaleY: target.height / height,
      enhanced: true,
    };
  } finally {
    bitmap.close();
  }
}
module.exports = { prepare };
