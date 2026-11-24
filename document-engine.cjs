'use strict';
const modes = ['auto', 'direct', 'ocr'];
const rejectionCodes = new Set([
  'FOREIGN_SCRIPT',
  'FOREIGN_LANGUAGE',
  'DOCUMENT_MISMATCH',
  'INCOMPLETE_DOCUMENT',
]);
function validateMode(value = 'auto') {
  if (!modes.includes(value))
    throw Object.assign(Error('Неизвестный способ обработки.'), { status: 400 });
  return value;
}
function requestedMode(value, isDev) {
  const mode = validateMode(value);
  if (mode !== 'auto' && !isDev)
    throw Object.assign(Error('Ручной выбор способа обработки доступен в dev-режиме.'), {
      status: 403,
    });
  return mode;
}
async function processDocument(job, dataDirectory, options = {}) {
  const mode = validateMode(job.processingMode);
  const started = performance.now();
  const legacyHooks = !options.direct && Boolean(options.download || options.convert);
  job.update({
    processingMode: mode,
    processingEngine: null,
    engineFallback: null,
    pdfReady: false,
  });
  if (mode !== 'ocr' && !legacyHooks && (job.fromPage ?? 1) === 1 && job.toPage == null) {
    try {
      await (options.direct || require('./direct-pdf.cjs').convertDirect)(
        job,
        dataDirectory,
        options,
      );
      job.controller.signal.throwIfAborted();
      job.update({ processingEngine: 'direct', processingMs: performance.now() - started });
      return;
    } catch (error) {
      job.controller.signal.throwIfAborted();
      if (mode === 'direct' || rejectionCodes.has(error.code)) throw error;
      job.log?.('Direct extraction fallback: ' + error.message);
      job.update({
        engineFallback: { code: error.code || 'DIRECT_UNAVAILABLE', message: error.message },
        pdfReady: false,
        copyTextReady: false,
        archiveReady: false,
        total: 0,
        current: 0,
        scriptVerification: null,
        identityVerification: null,
        pageIntegrity: null,
        stage: 'opening',
        message: 'Готовим страницы для распознавания…',
      });
      // A complete, verified download can already be a scan. Rasterize that
      // local PDF instead of opening the source again and downloading it twice.
      if (error.code === 'DIRECT_TEXT_UNUSABLE' && error.localPDF && !options.download) {
        const fs = require('node:fs/promises'),
          path = require('node:path');
        const source = path.join(job.directory, 'direct/source.pdf');
        const bytes = await fs.readFile(source);
        if (require('./page-check.cjs').digest(bytes) !== error.localPDF.sha256)
          throw Error('Повреждён локальный PDF для OCR.');
        await fs.writeFile(path.join(job.directory, 'source.pdf'), bytes);
        await require('./pdf-input.cjs').importPDF(job, { forceOCR: true });
        job.controller.signal.throwIfAborted();
        job.update({
          processingEngine: 'ocr',
          reusedDownloadPages: error.localPDF.total,
          processingMs: performance.now() - started,
        });
        return;
      }
    }
  } else if (mode === 'direct' && !legacyHooks) {
    throw Error(
      'Прямое извлечение обрабатывает весь документ. Выберите автоматический режим для диапазона страниц.',
    );
  }
  const { downloadArchive, convertArchive } = require('./pipeline.cjs');
  await (options.download || downloadArchive)(job, dataDirectory, options.downloadOptions || {});
  await (options.convert || convertArchive)(job);
  job.controller.signal.throwIfAborted();
  job.update({ processingEngine: 'ocr', processingMs: performance.now() - started });
}
module.exports = { modes, validateMode, requestedMode, processDocument };
