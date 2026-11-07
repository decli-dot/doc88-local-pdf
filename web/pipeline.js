'use strict';
const fs = require('./store.js');
const path = require('./browser-path.js');
const { command, installed, events } = require('./transport.js');
const { prepare } = require('./image-quality.js');
const { digest, inspectPages } = require('../page-check.cjs');
const {
  buildStructure,
  normativeReferences,
  addPDFStructure,
} = require('../document-analysis.cjs');
const { Buffer } = require('buffer');
const validateURL = (value) => globalThis.Doc88OCR.validateURL(value);
function validateRange(from, to) {
  const fromPage = Number(from || 1),
    toPage = to == null || to === '' ? null : Number(to);
  if (
    !Number.isSafeInteger(fromPage) ||
    fromPage < 1 ||
    (toPage != null && (!Number.isSafeInteger(toPage) || toPage < fromPage))
  )
    throw Error('Проверь диапазон страниц.');
  return { fromPage, toPage };
}
const readJSON = async (name) => {
  try {
    return JSON.parse(await fs.readFile(name, 'utf8'));
  } catch {
    return null;
  }
};
let capture = null;
events(async (message) => {
  const task = capture;
  if (!task || task.id !== message.id) {
    if (message.type === 'PAGE' || message.type === 'CACHED')
      throw Error('Задача загрузки уже закрыта. Сохрани обработку и продолжи её из истории.');
    return;
  }
  const { job, manifest } = task;
  try {
    job.controller.signal.throwIfAborted();
    if (message.type === 'PROGRESS')
      job.update({
        message: message.message,
        stage: message.challenge ? 'waiting' : 'downloading',
        challengeAvailable: Boolean(message.challenge),
      });
    else if (message.type === 'META') {
      if (!Number.isSafeInteger(message.total) || message.total < 1 || message.total > 500)
        throw Error('Некорректное число страниц Doc88.');
      if (job.officialPages && message.documentTotal < job.officialPages)
        throw Error(
          `На Doc88 ${message.documentTotal} стр., по ISO требуется не менее ${job.officialPages}.`,
        );
      if (manifest.total && manifest.total !== message.total)
        throw Error('Число страниц документа изменилось. Нужен новый поиск.');
      Object.assign(manifest, {
        total: message.total,
        documentTotal: message.documentTotal,
        title: String(message.title || 'Документ'),
      });
      await fs.writeFile(path.join(job.directory, 'download.json'), JSON.stringify(manifest));
      job.update({ total: message.total, current: 0, title: manifest.title, stage: 'downloading' });
    } else if (message.type === 'PAGE' || message.type === 'CACHED') {
      if (message.index !== task.received || message.index >= manifest.total)
        throw Error('Нарушен порядок страниц Doc88.');
      const name = path.join(job.directory, 'images', String(message.index));
      if (message.type === 'PAGE') {
        if (typeof message.image !== 'string' || !/^data:image\/jpeg;base64,/.test(message.image))
          throw Error('Некорректное изображение Doc88.');
        const bytes = Buffer.from(message.image.split(',')[1], 'base64');
        task.bytes += bytes.length;
        if (task.bytes > 250 * 1024 * 1024 || bytes.length > 20 * 1024 * 1024)
          throw Error('Изображения превышают лимит 250 МБ или 20 МБ на страницу.');
        await fs.writeFile(name, bytes);
        manifest.hashes[message.index] = digest(bytes);
        await fs.writeFile(path.join(job.directory, 'download.json'), JSON.stringify(manifest));
      } else {
        const bytes = await fs.readFile(name);
        if (digest(bytes) !== manifest.hashes[message.index])
          throw Error('Сохранённая страница повреждена. Повтори загрузку.');
        task.bytes += bytes.length;
        task.reused++;
      }
      task.received++;
      job.update({
        current: task.received,
        reusedDownloadPages: task.reused,
        challengeAvailable: false,
        stage: 'downloading',
        message: `Сохранено ${task.received} из ${manifest.total} страниц`,
      });
    } else if (message.type === 'DONE') {
      if (task.received !== manifest.total) throw Error('Сохранены не все страницы Doc88.');
      capture = null;
      task.resolve();
    } else if (message.type === 'ERROR' || message.type === 'CANCELLED')
      throw Error(message.message || 'Загрузка остановлена.');
  } catch (error) {
    capture = null;
    task.reject(error);
    throw error;
  }
});
async function downloadArchive(job) {
  job.controller.signal.throwIfAborted();
  const identity = {
    url: validateURL(job.url),
    fromPage: job.fromPage || 1,
    toPage: job.toPage || null,
  };
  const saved = await readJSON(path.join(job.directory, 'download.json'));
  const manifest =
    saved && JSON.stringify(saved.identity) === JSON.stringify(identity)
      ? saved
      : { identity, hashes: {} };
  const skip = [];
  for (const index of Object.keys(manifest.hashes)) {
    try {
      if (
        digest(await fs.readFile(path.join(job.directory, 'images', index))) ===
        manifest.hashes[index]
      )
        skip.push(Number(index));
    } catch {
      /* Missing pages are captured again. */
    }
  }
  if (manifest.total && skip.length === manifest.total)
    job.update({ reusedDownloadPages: skip.length });
  else {
    await installed();
    job.update({ stage: 'opening', message: 'Открываем документ в фоновой вкладке Doc88…' });
    const started = job.externalCaptureId
      ? { id: job.externalCaptureId }
      : await command('START_URL', {
          url: identity.url,
          protocol: 2,
          fromPage: identity.fromPage,
          toPage: identity.toPage,
          skip,
        });
    job.externalCaptureId = null;
    const stop = () => {
      if (capture?.id === started.id) {
        capture.reject(Error('Обработка остановлена.'));
        capture = null;
      }
      void command('CANCEL', { id: started.id }).catch(() => {});
    };
    try {
      const completed = new Promise((resolve, reject) => {
        capture = {
          id: started.id,
          job,
          manifest,
          resolve,
          reject,
          received: 0,
          reused: 0,
          bytes: 0,
        };
      });
      completed.catch(() => {});
      job.controller.signal.addEventListener('abort', stop, { once: true });
      job.controller.signal.throwIfAborted();
      await command('READY', { id: started.id });
      await completed;
      await command('FINISH', { id: started.id });
    } catch (error) {
      await command('CANCEL', { id: started.id }).catch(() => {});
      throw error;
    } finally {
      job.controller.signal.removeEventListener('abort', stop);
      if (capture?.id === started.id) capture = null;
    }
  }
  const zip = new globalThis.JSZip();
  for (let i = 0; i < manifest.total; i++) {
    job.controller.signal.throwIfAborted();
    const bytes = await fs.readFile(path.join(job.directory, 'images', String(i)));
    if (digest(bytes) !== manifest.hashes[i]) throw Error('Повреждена сохранённая страница.');
    zip.file(`page${String(i + 1).padStart(5, '0')}.jpg`, bytes);
  }
  await fs.writeFile(
    path.join(job.directory, 'archive.zip'),
    await zip.generateAsync({ type: 'uint8array' }),
  );
  job.update({
    total: manifest.total,
    archiveReady: true,
    archiveFilename: globalThis.Doc88OCR.cleanName(manifest.title) + '.zip',
    title: manifest.title,
  });
}
async function challengeFrame() {
  if (!capture) throw Error('Сейчас нет активной проверки Doc88.');
  return command('CHALLENGE_FRAME', { id: capture.id });
}
async function challengeInput(input) {
  if (!capture) throw Error('Проверка уже закрыта.');
  return command('CHALLENGE_INPUT', { id: capture.id, input });
}
async function convertArchive(job) {
  const signal = job.controller.signal,
    { abortable } = globalThis.Doc88OCR;
  signal.throwIfAborted();
  job.update({
    stage: 'unpacking',
    message: 'Проверяем ZIP и сохранённые страницы…',
    pdfReady: false,
  });
  const images = await globalThis.Doc88OCR.unpackZip(
    new Blob([await fs.readFile(path.join(job.directory, 'archive.zip'))]),
    signal,
  );
  const { PDFDocument } = globalThis.PDFLib,
    pdf = await PDFDocument.create();
  pdf.setTitle(job.officialTitle || job.title || 'Документ');
  pdf.setCreator('Doc88 Browser PDF');
  const texts = [],
    hashes = [],
    enhanced = [];
  let worker,
    reused = 0,
    blankPages = 0,
    pageIndex = 0;
  const stop = () => {
    if (worker) void worker.terminate().catch(() => {});
  };
  signal.addEventListener('abort', stop, { once: true });
  try {
    for (pageIndex = 0; pageIndex < images.length; pageIndex++) {
      signal.throwIfAborted();
      job.update({
        stage: 'ocr',
        total: images.length,
        current: pageIndex,
        message: `Распознаём английский текст: страница ${pageIndex + 1} из ${images.length}`,
      });
      const original = new Uint8Array(await images[pageIndex].arrayBuffer()),
        hash = digest(original);
      hashes.push(hash);
      const name = path.join(job.directory, 'ocr', `page${String(pageIndex + 1).padStart(5, '0')}`),
        signature = `browser-ocr-v1:${hash}:${job.enhanceImages !== false}`;
      const cache = await readJSON(name + '.json');
      let bytes, text, preparation;
      if (cache?.signature === signature) {
        try {
          bytes = await fs.readFile(name + '.pdf');
          text = await fs.readFile(name + '.txt', 'utf8');
          if (digest(bytes) !== cache.pdfHash || digest(text) !== cache.textHash)
            throw Error('Cache invalid');
          preparation = cache.preparation;
          reused++;
        } catch {
          bytes = null;
        }
      }
      if (!bytes) {
        if (!worker) {
          job.update({
            message:
              'Загружаем английскую модель OCR. При первом запуске потребуется больше времени…',
          });
          const assets = new URL('assets/', location.href);
          const initializing = globalThis.Tesseract.createWorker('eng', 1, {
            workerPath: new URL('worker.min.js', assets).href,
            corePath: new URL('core/', assets).href,
            langPath: new URL('lang/', assets).href,
            workerBlobURL: false,
            errorHandler: () => {},
            logger(event) {
              if (event.status === 'recognizing text')
                job.update({
                  message: `Распознаём страницу ${pageIndex + 1} из ${images.length} · ${Math.round(event.progress * 100)}%`,
                });
            },
          }).then(async (ready) => {
            if (signal.aborted) {
              await ready.terminate();
              throw Error('Обработка остановлена.');
            }
            return ready;
          });
          worker = await abortable(initializing, signal);
          await abortable(
            worker.setParameters({ tessedit_pageseg_mode: '3', user_defined_dpi: '150' }),
            signal,
          );
        }
        preparation = await prepare(images[pageIndex], job.enhanceImages !== false);
        signal.throwIfAborted();
        const { data } = await abortable(
          worker.recognize(preparation.image, { pdfTextOnly: false }, { text: true, pdf: true }),
          signal,
        );
        signal.throwIfAborted();
        const single = await PDFDocument.load(data.pdf);
        if (single.getPageCount() !== 1) throw Error('OCR вернул неверное число страниц.');
        single.getPage(0).scale(1 / preparation.scaleX, 1 / preparation.scaleY);
        bytes = await single.save();
        text = data.text || '';
        const { image, ...metadata } = preparation;
        preparation = metadata;
        await fs.writeFile(name + '.pdf', bytes);
        await fs.writeFile(name + '.txt', text);
        await fs.writeFile(
          name + '.json',
          JSON.stringify({
            signature,
            pdfHash: digest(bytes),
            textHash: digest(text),
            preparation,
          }),
        );
      }
      const source = await PDFDocument.load(bytes);
      if (source.getPageCount() !== 1) throw Error('Повреждена сохранённая страница OCR.');
      const [page] = await pdf.copyPages(source, [0]);
      pdf.addPage(page);
      texts.push(text);
      if (!text.trim()) blankPages++;
      if (preparation?.enhanced)
        enhanced.push({
          page: pageIndex + 1,
          scaleX: preparation.scaleX,
          scaleY: preparation.scaleY,
        });
      job.update({ current: pageIndex + 1, reusedOCRPages: reused });
    }
    signal.throwIfAborted();
    job.update({ stage: 'merging', message: 'Собираем PDF, структуру и нормативные ссылки…' });
    const structure = buildStructure(texts),
      references = normativeReferences(texts),
      integrity = inspectPages(texts, hashes, job.officialPages);
    addPDFStructure(pdf, structure);
    const result = await pdf.save();
    signal.throwIfAborted();
    await fs.writeFile(path.join(job.directory, 'result.pdf'), result);
    signal.throwIfAborted();
    job.update({
      stage: 'done',
      pdfReady: true,
      total: images.length,
      current: images.length,
      pdfFilename: job.officialFilename || globalThis.Doc88OCR.cleanName(job.title) + '.pdf',
      bytes: result.length,
      textChars: texts.join('').trim().length,
      blankPages,
      pageIntegrity: integrity,
      documentStructure: structure,
      normativeReferences: references,
      imageEnhancement: { pages: enhanced },
      message: 'PDF готов. Можно искать и копировать текст.',
      finishedAt: new Date().toISOString(),
    });
  } finally {
    signal.removeEventListener('abort', stop);
    if (worker) await worker.terminate().catch(() => {});
  }
}
module.exports = {
  validateURL,
  validateRange,
  downloadArchive,
  convertArchive,
  challengeFrame,
  challengeInput,
};
