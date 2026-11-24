'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { PDFDocument } = require('pdf-lib');
const JSZip = require('jszip');
const { createCanvas } = require('@napi-rs/canvas');
const { convertArchive, cleanName } = require('./pipeline.cjs');
const { inspectPages } = require('./page-check.cjs');
const { atomicWrite } = require('./checkpoints.cjs');
const { normativeReferences, addPDFStructure } = require('./document-analysis.cjs');
const { documentText, textFromItems } = require('./copy-text.cjs');
async function importPDF(job, { forceOCR = false } = {}) {
  job.controller.signal.throwIfAborted();
  const input = await fs.readFile(path.join(job.directory, 'source.pdf'));
  if (input.length > 250 * 1024 * 1024) throw Error('PDF превышает допустимый размер.');
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: new Uint8Array(input),
    isEvalSupported: false,
    useSystemFonts: true,
    maxImageSize: 25000000,
  });
  const stop = () => {
    void task.destroy().catch(() => {});
  };
  job.controller.signal.addEventListener('abort', stop, { once: true });
  let source;
  try {
    source = await task.promise;
    if (source.numPages < 1 || source.numPages > 2000)
      throw Error('Недопустимое число страниц PDF.');
    const original = await PDFDocument.load(input, { parseSpeed: 1500 });
    const texts = [],
      scans = [],
      dimensions = [];
    const zip = new JSZip();
    let scanBytes = 0;
    job.update({
      stage: 'checking',
      total: source.numPages,
      current: 0,
      message: 'Проверяем текст исходного PDF…',
    });
    for (let index = 0; index < source.numPages; index++) {
      job.controller.signal.throwIfAborted();
      const page = await source.getPage(index + 1),
        viewport = page.getViewport({ scale: 1 });
      dimensions.push({ width: viewport.width, height: viewport.height });
      const text = textFromItems((await page.getTextContent()).items, viewport.width);
      texts.push(text);
      let scanned = false;
      if (forceOCR || (text.match(/\p{L}/gu)?.length || 0) < 50) {
        const operators = await page.getOperatorList();
        const images = [
          pdfjs.OPS.paintImageXObject,
          pdfjs.OPS.paintInlineImageXObject,
          pdfjs.OPS.paintImageMaskXObject,
          pdfjs.OPS.paintImageXObjectRepeat,
        ];
        scanned = forceOCR || operators.fnArray.some((operator) => images.includes(operator));
      }
      if (scanned) {
        const scale = Math.min(3, 2400 / Math.max(viewport.width, viewport.height));
        const view = page.getViewport({ scale }),
          canvas = createCanvas(Math.ceil(view.width), Math.ceil(view.height));
        const rendering = page.render({ canvasContext: canvas.getContext('2d'), viewport: view });
        const cancel = () => rendering.cancel();
        job.controller.signal.addEventListener('abort', cancel, { once: true });
        try {
          await rendering.promise;
        } finally {
          job.controller.signal.removeEventListener('abort', cancel);
        }
        const image = canvas.toBuffer('image/png');
        scanBytes += image.length;
        if (scanBytes > 250 * 1024 * 1024)
          throw Error('Сканированные страницы PDF превышают допустимый объём.');
        zip.file(`page${String(scans.length + 1).padStart(5, '0')}.png`, image);
        scans.push(index);
      }
      page.cleanup();
      job.update({ current: index + 1 });
    }
    let recognized;
    if (scans.length) {
      const directory = path.join(job.directory, 'scanned-pages');
      await fs.mkdir(directory, { recursive: true });
      await atomicWrite(
        path.join(directory, 'archive.zip'),
        await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
      );
      const child = {
        ...job,
        directory,
        url: null,
        total: scans.length,
        current: 0,
        officialPages: null,
        controller: job.controller,
        update(value) {
          Object.assign(this, value);
          job.update({
            stage: value.stage === 'done' ? 'merging' : value.stage || this.stage,
            message: value.message || this.message,
            current: source.numPages - scans.length + (this.current || 0),
            total: source.numPages,
            reusedOCRPages: this.reusedOCRPages || 0,
            ocrDiagnostics: this.ocrDiagnostics,
          });
        },
      };
      await convertArchive(child);
      job.update({
        scriptVerification: child.scriptVerification,
        pdfOptimization: child.pdfOptimization,
        scannedPageIntegrity: child.pageIntegrity,
        ocrQuality: require('./ocr-quality.cjs').mergeOCRQuality(
          job.ocrQuality,
          (child.ocrQuality?.pages || []).map((item) => ({
            ...item,
            page: scans[item.page - 1] + 1,
          })),
        ),
      });
      recognized = await PDFDocument.load(await fs.readFile(path.join(directory, 'result.pdf')));
      for (let index = 0; index < scans.length; index++)
        texts[scans[index]] = await fs.readFile(
          path.join(directory, 'ocr', `page${String(index + 1).padStart(5, '0')}.txt`),
          'utf8',
        );
    }
    const result = await PDFDocument.create();
    result.setTitle(job.title);
    result.setCreator('DecliPDF');
    const ocrDirectory = path.join(job.directory, 'ocr');
    await fs.mkdir(ocrDirectory, { recursive: true });
    const scanSet = new Set(scans);
    const nativeIndices = Array.from({ length: source.numPages }, (_, i) => i).filter(
      (i) => !scanSet.has(i),
    );
    const nativePages = await result.copyPages(original, nativeIndices);
    const scannedPages = recognized
      ? await result.copyPages(
          recognized,
          scans.map((_, i) => i),
        )
      : [];
    let nativeIndex = 0;
    for (let index = 0; index < source.numPages; index++) {
      job.controller.signal.throwIfAborted();
      const scanIndex = scans.indexOf(index);
      const page = scanIndex < 0 ? nativePages[nativeIndex++] : scannedPages[scanIndex];
      if (scanIndex >= 0)
        page.scale(
          dimensions[index].width / page.getWidth(),
          dimensions[index].height / page.getHeight(),
        );
      result.addPage(page);
      await atomicWrite(
        path.join(ocrDirectory, `page${String(index + 1).padStart(5, '0')}.txt`),
        texts[index],
      );
    }
    const structure = await require('./pdf-structure.cjs').structureFromPDF(
      await result.save({ objectsPerTick: 1500 }),
      texts,
      {
        signal: job.controller.signal,
        language: job.documentLanguage || job.ocrLanguage || 'eng',
        cacheDirectory: path.join(job.directory, 'structure-cache'),
        modelsDirectory: job.cacheDirectory,
        onWarning: (message) => job.log?.(message),
      },
    );
    addPDFStructure(result, structure);
    const output = await result.save({ objectsPerTick: 1500 });
    job.controller.signal.throwIfAborted();
    await atomicWrite(path.join(job.directory, 'result.pdf'), output);
    await atomicWrite(path.join(job.directory, 'copy-text.txt'), documentText(texts));
    job.update({
      stage: 'done',
      total: source.numPages,
      current: source.numPages,
      pdfReady: true,
      archiveReady: false,
      pdfFilename: job.officialFilename || cleanName(job.title) + '.pdf',
      bytes: output.length,
      textChars: texts.join('').length,
      blankPages: texts.filter((text) => !text.trim()).length,
      textlessPages: texts.flatMap((text, i) => (text.trim() ? [] : [i + 1])),
      pageIntegrity:
        forceOCR && job.scannedPageIntegrity
          ? job.scannedPageIntegrity
          : inspectPages(texts, [], job.officialPages),
      documentStructure: structure,
      normativeReferences: normativeReferences(texts),
      copyTextReady: true,
      nativeTextPages: source.numPages - scans.length,
      scannedOCRPages: scans.length,
      finishedAt: new Date().toISOString(),
    });
  } finally {
    job.controller.signal.removeEventListener('abort', stop);
    if (source) await source.destroy();
    else await task.destroy();
  }
}
module.exports = { importPDF };
