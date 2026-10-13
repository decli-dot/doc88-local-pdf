'use strict';
((scope) => {
  const MAX_PAGES = 500;
  const MAX_IMAGE = 20 * 1024 * 1024;
  const MAX_BYTES = 250 * 1024 * 1024;
  function check(signal) {
    if (signal?.aborted) throw new Error('Обработка остановлена.');
  }
  function abortable(promise, signal) {
    if (!signal) return promise;
    return new Promise((resolve, reject) => {
      const cancel = () => reject(new Error('Обработка остановлена.'));
      signal.addEventListener('abort', cancel, { once: true });
      Promise.resolve(promise).then(
        (value) => {
          signal.removeEventListener('abort', cancel);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener('abort', cancel);
          reject(error);
        },
      );
      if (signal.aborted) cancel();
    });
  }
  function cleanName(value) {
    return (
      String(value || 'document')
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
        .replace(/[. ]+$/g, '')
        .slice(0, 100) || 'document'
    );
  }
  function validateURL(value) {
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new Error('Вставь ссылку на документ Doc88.');
    }
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      !['www.doc88.com', 'doc88.com'].includes(url.hostname) ||
      url.port ||
      url.username ||
      url.password ||
      !/^\/p-\d+\.html$/.test(url.pathname)
    )
      throw new Error('Нужна ссылка вида https://www.doc88.com/p-123456789.html');
    return 'https://' + url.hostname + url.pathname;
  }
  function imageKind(bytes) {
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
    if ([137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value))
      return 'png';
    throw new Error('В архиве найден файл, который не является изображением JPG или PNG.');
  }
  async function unpackZip(file, signal) {
    check(signal);
    if (file.size > MAX_BYTES)
      throw new Error('Архив больше 250 МБ. Обработай документ частями в локальной программе.');
    const zip = await abortable(scope.JSZip.loadAsync(await file.arrayBuffer()), signal);
    const entries = Object.values(zip.files).filter(
      (entry) =>
        !entry.dir && /\.(?:jpe?g|png)$/i.test(entry.name) && !entry.name.startsWith('__MACOSX/'),
    );
    if (!entries.length || entries.length > MAX_PAGES)
      throw new Error(`Нужен архив с 1–${MAX_PAGES} изображениями JPG или PNG.`);
    const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
    entries.sort((a, b) => collator.compare(a.name, b.name));
    let total = 0;
    for (const entry of entries) {
      const size = entry._data?.uncompressedSize;
      if (!Number.isSafeInteger(size) || size > MAX_IMAGE)
        throw new Error('Изображение в архиве больше 20 МБ.');
      total += size;
    }
    if (total > MAX_BYTES) throw new Error('Распакованный архив больше 250 МБ.');
    const images = [];
    for (const entry of entries) {
      check(signal);
      const bytes = await abortable(entry.async('uint8array'), signal);
      if (!bytes.length || bytes.length > MAX_IMAGE)
        throw new Error('Не удалось прочитать изображение.');
      const kind = imageKind(bytes);
      images.push(new Blob([bytes], { type: kind === 'png' ? 'image/png' : 'image/jpeg' }));
    }
    return images;
  }
  async function createPDF(images, { signal, title = 'document', onProgress = () => {} } = {}) {
    check(signal);
    if (!images.length || images.length > MAX_PAGES) throw new Error('Некорректное число страниц.');
    const { PDFDocument } = scope.PDFLib;
    const pdf = await PDFDocument.create();
    pdf.setTitle(title);
    pdf.setCreator('Doc88 Browser PDF');
    let worker = null;
    let pageIndex = -1;
    let textChars = 0;
    let blankPages = 0;
    const stopWorker = () => {
      if (worker) void worker.terminate().catch(() => {});
    };
    const progress = (message, percent) => onProgress({ message, percent });
    try {
      progress('Загружаем английскую модель OCR. При первом запуске это займёт чуть дольше…', 0);
      const assets = new URL('assets/', scope.location.href);
      const pending = scope.Tesseract.createWorker('eng', 1, {
        workerPath: new URL('worker.min.js', assets).href,
        corePath: new URL('core/', assets).href,
        langPath: new URL('lang/', assets).href,
        workerBlobURL: false,
        errorHandler: () => {},
        logger: (event) => {
          if (pageIndex >= 0 && event.status === 'recognizing text')
            progress(
              `Распознаём страницу ${pageIndex + 1} из ${images.length}…`,
              ((pageIndex + event.progress) / images.length) * 95,
            );
        },
      }).then(async (ready) => {
        if (signal?.aborted) {
          await ready.terminate();
          throw new Error('Обработка остановлена.');
        }
        return ready;
      });
      worker = await abortable(pending, signal);
      signal?.addEventListener('abort', stopWorker, { once: true });
      check(signal);
      await abortable(
        worker.setParameters({ tessedit_pageseg_mode: '3', user_defined_dpi: '150' }),
        signal,
      );
      for (pageIndex = 0; pageIndex < images.length; pageIndex++) {
        check(signal);
        progress(
          `Распознаём страницу ${pageIndex + 1} из ${images.length}…`,
          (pageIndex / images.length) * 95,
        );
        const image = images[pageIndex];
        // Bound decoded image dimensions before allocating OCR's pixel buffers.
        const bitmap = await abortable(createImageBitmap(image), signal);
        const pixels = bitmap.width * bitmap.height;
        bitmap.close();
        if (!pixels || pixels > 50000000)
          throw new Error(`Страница ${pageIndex + 1} слишком большая.`);
        const { data } = await abortable(
          worker.recognize(image, { pdfTextOnly: false }, { text: true, pdf: true }),
          signal,
        );
        check(signal);
        const source = await PDFDocument.load(data.pdf);
        if (source.getPageCount() !== 1) throw new Error('OCR вернул некорректный PDF страницы.');
        const [page] = await pdf.copyPages(source, [0]);
        pdf.addPage(page);
        textChars += (data.text || '').trim().length;
        if (!(data.text || '').trim()) blankPages++;
      }
      progress('Собираем итоговый PDF…', 97);
      const bytes = await pdf.save();
      check(signal);
      if ((await PDFDocument.load(bytes)).getPageCount() !== images.length)
        throw new Error('В PDF не хватает страниц.');
      progress('PDF готов', 100);
      return { bytes, pages: images.length, textChars, blankPages };
    } finally {
      signal?.removeEventListener('abort', stopWorker);
      if (worker) await worker.terminate().catch(() => {});
    }
  }
  scope.Doc88OCR = { createPDF, unpackZip, validateURL, cleanName, imageKind, abortable };
  if (typeof module !== 'undefined') module.exports = scope.Doc88OCR;
})(globalThis);
