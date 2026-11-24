'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { PDFDocument } = require('pdf-lib');
const { createCanvas } = require('@napi-rs/canvas');
const { analyseTextPages, identityCheck, isoExtentCheck } = require('../search.cjs');
const { normativeReferences, addPDFStructure } = require('../document-analysis.cjs');
const { documentText, textFromItems } = require('../copy-text.cjs');
const { inspectPages } = require('../page-check.cjs');
const { atomicWrite } = require('../checkpoints.cjs');
const { layoutLines } = require('../structure-layout.cjs');
function textRuns(items) {
  // PDF.js already adds real inter-word spaces; an item may be just one glyph.
  // Inserting a space between all items would destroy searchable native words.
  return items
    .map((item) => (typeof item.str === 'string' ? item.str : '') + (item.hasEOL ? '\n' : ''))
    .join('');
}
function nativeLayoutText(items, width) {
  const merged = [];
  for (const item of items) {
    if (typeof item.str !== 'string') continue;
    const previous = merged.at(-1);
    const height = Math.abs(item.height || item.transform?.[3]) || 10;
    const gap = previous ? item.transform[4] - previous.transform[4] - previous.width : Infinity;
    if (
      previous &&
      !previous.hasEOL &&
      previous.str.trim() &&
      item.str.trim() &&
      Math.abs(item.transform[5] - previous.transform[5]) < height * 0.1 &&
      Math.abs(item.transform[1]) < 0.01 &&
      Math.abs(item.transform[2]) < 0.01 &&
      gap >= -height * 0.15 &&
      gap < height * 0.18
    ) {
      previous.str += item.str;
      previous.width = item.transform[4] + item.width - previous.transform[4];
      previous.hasEOL = item.hasEOL;
    } else merged.push({ ...item });
  }
  return textFromItems(merged, width);
}
async function inspectPDF(
  filename,
  outputDirectory,
  edition,
  {
    signal,
    samples = [1, 2, 20, 50, 83],
    language: targetLanguage = 'eng+deu',
    pageTextDirectory,
    recognizedPages = [],
    modelsDirectory,
    onProgress = () => {},
    preflight = false,
  } = {},
) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const input = await fs.readFile(filename);
  const loading = pdfjs.getDocument({
    data: new Uint8Array(input),
    isEvalSupported: false,
    maxImageSize: 25000000,
  });
  const texts = [],
    headers = [],
    pages = [],
    layouts = [];
  const stop = () => {
    void loading.destroy().catch(() => {});
  };
  signal?.addEventListener('abort', stop, { once: true });
  try {
    const pdf = await loading.promise;
    await fs.mkdir(path.join(outputDirectory, 'samples'), { recursive: true });
    if (pageTextDirectory) await fs.mkdir(pageTextDirectory, { recursive: true });
    for (let number = 1; number <= pdf.numPages; number++) {
      signal?.throwIfAborted();
      const page = await pdf.getPage(number);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent(),
        items = content.items;
      layouts.push(layoutLines(items, viewport.width, viewport.height, content.styles));
      const text = nativeLayoutText(items, viewport.width);
      let requiresOCR = false;
      if ((text.match(/\p{L}/gu)?.length || 0) < 30) {
        const operators = await page.getOperatorList();
        const largeImage = operators.fnArray.some(
          (code, i) =>
            code === pdfjs.OPS.paintImageXObject &&
            (operators.argsArray[i]?.[1] || 0) * (operators.argsArray[i]?.[2] || 0) > 100000,
        );
        const vectorOnlyText =
          !text.trim() &&
          operators.fnArray.filter((code) => code === pdfjs.OPS.constructPath).length > 20;
        requiresOCR = !recognizedPages.includes(number) && (largeImage || vectorOnlyText);
      }
      texts.push(text);
      if (pageTextDirectory)
        await atomicWrite(
          path.join(pageTextDirectory, `page${String(number).padStart(5, '0')}.txt`),
          text,
        );
      headers.push(textRuns(items.filter((item) => item.transform?.[5] > viewport.height - 70)));
      pages.push({
        page: number,
        width: viewport.width,
        height: viewport.height,
        characters: text.length,
        requiresOCR,
      });
      if (samples.includes(number)) {
        const view = page.getViewport({ scale: 1.7 });
        const canvas = createCanvas(Math.ceil(view.width), Math.ceil(view.height));
        await page.render({ canvasContext: canvas.getContext('2d'), viewport: view }).promise;
        await atomicWrite(
          path.join(outputDirectory, 'samples', `page${String(number).padStart(5, '0')}.png`),
          canvas.toBuffer('image/png'),
        );
      }
      page.cleanup();
      onProgress(number, pdf.numPages);
    }
    const language = await analyseTextPages(texts, targetLanguage);
    let identity = identityCheck(
      edition.reference,
      /\(R\d{4}\)/.test(edition.reference) ? texts : headers,
    );
    if (identity.status === 'unknown') identity = identityCheck(edition.reference, texts);
    const extent = isoExtentCheck(pdf.numPages, edition);
    const pageIntegrity = inspectPages(texts, [], edition.pageCount);
    const sparsePages = pages.filter((page) => page.characters < 50).map((page) => page.page);
    const needsOCR = pages.filter((page) => page.requiresOCR).map((page) => page.page);
    const report = {
      version: 1,
      pages: pdf.numPages,
      bytes: input.length,
      language,
      identity,
      extent,
      pageIntegrity,
      nativeTextPages: pages.filter((page) => page.characters >= 50).length,
      sparsePages,
      needsOCR,
      checksPassed:
        language.status === 'passed' &&
        identity.status === 'passed' &&
        (extent.status === 'passed' || edition.extentPolicy === 'source') &&
        pageIntegrity.status !== 'failed',
      pageDetails: pages,
    };
    report.ready = report.checksPassed && !needsOCR.length;
    await atomicWrite(path.join(outputDirectory, 'quality.json'), JSON.stringify(report, null, 2));
    await atomicWrite(path.join(outputDirectory, 'text.txt'), documentText(texts));
    // Keep output provisional if an essential check fails. Source.pdf remains
    // available for diagnosis and is never registered as a completed app job.
    if (report.ready && !preflight) {
      const result = await PDFDocument.load(input, { parseSpeed: 1500 });
      const structure = await require('../pdf-structure.cjs').finishStructure(pdf, layouts, texts, {
        signal,
        language: targetLanguage,
        modelsDirectory,
        cacheDirectory: path.join(outputDirectory, 'structure-cache'),
      });
      addPDFStructure(result, structure);
      result.setTitle(edition.reference + ' — ' + edition.title);
      result.setCreator('DecliPDF experimental direct extractor');
      await atomicWrite(
        path.join(outputDirectory, 'result.pdf'),
        await result.save({ objectsPerTick: 1500 }),
      );
      report.structure = structure;
      report.normativeReferences = normativeReferences(texts);
      await atomicWrite(
        path.join(outputDirectory, 'quality.json'),
        JSON.stringify(report, null, 2),
      );
    }
    return report;
  } finally {
    signal?.removeEventListener('abort', stop);
    await loading.destroy();
  }
}
module.exports = { textRuns, nativeLayoutText, inspectPDF };
