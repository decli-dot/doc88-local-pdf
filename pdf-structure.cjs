'use strict';
const { layoutLines } = require('./structure-layout.cjs');
const { buildStructure } = require('./document-analysis.cjs');
async function finishStructure(pdf, layouts, texts = [], options = {}) {
  let structure = buildStructure(texts, { layouts });
  const dense = layouts.filter(
    (layout) => layout.lines.filter((line) => line.letters > 20).length > 8,
  ).length;
  if (structure.count < Math.max(3, dense / 8) && dense >= 4) {
    let recovery;
    try {
      recovery = await require('./heading-ocr.cjs').recoverHeadings(pdf, layouts, options);
    } catch (error) {
      options.signal?.throwIfAborted();
      options.onWarning?.('Восстановление заголовков недоступно: ' + error.message);
      recovery = { available: false, pages: 0 };
    }
    if (recovery.pages) structure = buildStructure(texts, { layouts });
    if (!recovery.available && structure.count < 3)
      structure = {
        ...structure,
        nodes: [],
        count: 0,
        message: 'Заголовки не удалось уверенно выделить.',
      };
    structure.headingRecovery = recovery;
  }
  return structure;
}
async function structureFromPDF(bytes, texts = [], options = {}) {
  const { signal } = options;
  signal?.throwIfAborted();
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loading = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    maxImageSize: 25000000,
  });
  const stop = () => {
    void loading.destroy().catch(() => {});
  };
  signal?.addEventListener('abort', stop, { once: true });
  try {
    const pdf = await loading.promise,
      layouts = [];
    for (let number = 1; number <= pdf.numPages; number++) {
      signal?.throwIfAborted();
      const page = await pdf.getPage(number),
        view = page.getViewport({ scale: 1 }),
        content = await page.getTextContent();
      layouts.push(layoutLines(content.items, view.width, view.height, content.styles));
      page.cleanup();
    }
    return await finishStructure(pdf, layouts, texts, options);
  } finally {
    signal?.removeEventListener('abort', stop);
    await loading.destroy();
  }
}
module.exports = { structureFromPDF, finishStructure };
