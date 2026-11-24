'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const JSZip = require('jszip');
const { PDFDocument } = require('pdf-lib');
const { createCanvas } = require('@napi-rs/canvas');
const { atomicWrite } = require('./checkpoints.cjs');
async function repairDirectPages(job, sourceFile, directory, pageNumbers) {
  const signal = job.controller.signal;
  signal.throwIfAborted();
  const input = await fs.readFile(sourceFile);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loading = pdfjs.getDocument({
    data: new Uint8Array(input),
    isEvalSupported: false,
    maxImageSize: 25000000,
  });
  const stop = () => {
    void loading.destroy().catch(() => {});
  };
  signal.addEventListener('abort', stop, { once: true });
  await fs.mkdir(directory, { recursive: true });
  try {
    const source = await loading.promise;
    const zip = new JSZip();
    for (const [index, number] of pageNumbers.entries()) {
      signal.throwIfAborted();
      if (!Number.isSafeInteger(number) || number < 1 || number > source.numPages)
        throw Error('Invalid repair page.');
      const page = await source.getPage(number),
        original = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({
        scale: Math.min(2.9, 3500 / Math.max(original.width, original.height)),
      });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const render = page.render({ canvasContext: canvas.getContext('2d'), viewport });
      const cancel = () => render.cancel();
      signal.addEventListener('abort', cancel, { once: true });
      try {
        await render.promise;
      } finally {
        signal.removeEventListener('abort', cancel);
      }
      zip.file(`page${String(index + 1).padStart(5, '0')}.png`, canvas.toBuffer('image/png'));
      page.cleanup();
    }
    await atomicWrite(
      path.join(directory, 'archive.zip'),
      await zip.generateAsync({ type: 'nodebuffer' }),
    );
    const child = {
      ...job,
      directory,
      url: null,
      total: pageNumbers.length,
      current: 0,
      officialPages: null,
      enforceScript: false,
      enhanceImages: false,
      update(value) {
        Object.assign(this, value);
        job.update({
          stage: value.stage === 'done' ? 'checking' : value.stage || this.stage,
          message: `Распознаём отдельные страницы: ${this.current || 0} из ${pageNumbers.length}`,
          ocrDiagnostics: this.ocrDiagnostics,
        });
      },
    };
    await require('./pipeline.cjs').convertArchive(child);
    job.update({
      pdfOptimization: child.pdfOptimization,
      ocrQuality: require('./ocr-quality.cjs').mergeOCRQuality(
        job.ocrQuality,
        (child.ocrQuality?.pages || []).map((item) => ({
          ...item,
          page: pageNumbers[item.page - 1],
        })),
      ),
    });
    signal.throwIfAborted();
    const result = await PDFDocument.load(input, { parseSpeed: 1500 });
    const recognized = await PDFDocument.load(
      await fs.readFile(path.join(directory, 'result.pdf')),
      { parseSpeed: 1500 },
    );
    if (recognized.getPageCount() !== pageNumbers.length) throw Error('Incomplete page repair.');
    for (const [index, number] of pageNumbers.entries()) {
      const original = result.getPage(number - 1);
      const [page] = await result.copyPages(recognized, [index]);
      page.scale(original.getWidth() / page.getWidth(), original.getHeight() / page.getHeight());
      result.removePage(number - 1);
      result.insertPage(number - 1, page);
    }
    const output = path.join(directory, 'repaired.pdf');
    await atomicWrite(output, await result.save({ objectsPerTick: 1500 }));
    return output;
  } finally {
    signal.removeEventListener('abort', stop);
    await loading.destroy();
  }
}
module.exports = { repairDirectPages };
