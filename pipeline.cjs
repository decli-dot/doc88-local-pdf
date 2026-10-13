'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { dependency, nativeOCR, browserChannel } = require('./runtime.cjs');
const JSZip = dependency('jszip');
const { PDFDocument } = dependency('pdf-lib');
const native = nativeOCR();
const MAX_PAGES = 2000;
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const MAX_RAW_BYTES = 800 * 1024 * 1024;

function checkAbort(job) {
  if (job.controller.signal.aborted) throw new Error('Обработка остановлена.');
}

function abortable(promise, signal) {
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

function validateURL(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Вставь ссылку на документ doc88.com.');
  }
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    !['www.doc88.com', 'doc88.com'].includes(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    !/^\/p-\d+\.html$/.test(url.pathname)
  ) {
    throw new Error('Нужна ссылка вида https://www.doc88.com/p-123456789.html');
  }
  url.protocol = 'https:';
  url.search = '';
  url.hash = '';
  return url.href;
}

function validateRange(from, to) {
  const first = from === '' || from == null ? 1 : Number(from);
  const last = to === '' || to == null ? null : Number(to);
  if (
    !Number.isSafeInteger(first) ||
    first < 1 ||
    (last !== null && (!Number.isSafeInteger(last) || last < first))
  ) {
    throw new Error('Проверь диапазон страниц: нужны целые числа, начало не больше конца.');
  }
  return { fromPage: first, toPage: last };
}

function cleanName(value) {
  return (
    String(value || 'document')
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
      .replace(/[. ]+$/g, '')
      .slice(0, 100) || 'document'
  );
}

async function downloadArchive(job, dataDir, options = {}) {
  checkAbort(job);
  const { chromium } = dependency('playwright');
  job.update({
    stage: 'opening',
    message: options.headless
      ? 'Открываем документ в облачном браузере…'
      : 'Открываем документ в отдельном окне браузера…',
  });
  const context = await chromium.launchPersistentContext(path.join(dataDir, 'browser-profile'), {
    channel: options.channel || browserChannel(),
    headless: Boolean(options.headless),
    acceptDownloads: true,
    viewport: options.viewport || null,
    ...(options.deviceScaleFactor ? { deviceScaleFactor: options.deviceScaleFactor } : {}),
  });
  job.browser = context;
  const closeOnAbort = () => context.close().catch(() => {});
  job.controller.signal.addEventListener('abort', closeOnAbort, { once: true });
  let challengeError = null;
  try {
    checkAbort(job);
    const page = context.pages()[0] || (await context.newPage());
    page.setDefaultTimeout(15 * 60 * 1000);
    page.on('dialog', async (dialog) => {
      if (options.rejectChallenges) {
        challengeError = new Error(
          'Doc88 запросил капчу или ручное подтверждение чтения. Автоматическая облачная загрузка остановлена.',
        );
        job.update({ stage: 'challenge', message: challengeError.message });
        await dialog.dismiss().catch(() => {});
        await context.close().catch(() => {});
        return;
      }
      job.update({
        stage: 'waiting',
        message: 'Doc88 просит подтверждение. Реши капчу или подтверди чтение в открытом окне.',
      });
      await dialog.dismiss().catch(() => {});
    });
    page.on('console', (message) => {
      const text = message.text();
      const capture = text.match(/Added page #(\d+) to ZIP/);
      const preload = text.match(/Preloading page #(\d+)/);
      if (capture) {
        job.update({
          stage: 'downloading',
          current: Number(capture[1]) - job.fromPage + 1,
          message: `Сохраняем страницы: ${Number(capture[1]) - job.fromPage + 1} из ${job.total || '…'}`,
        });
      } else if (preload) {
        job.update({ stage: 'downloading', message: `Загружаем страницу ${preload[1]}…` });
      }
    });
    const response = await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    if (options.rejectChallenges && response && response.status() >= 400)
      throw new Error(`Doc88 вернул HTTP ${response.status()}.`);
    if (!['doc88.com', 'www.doc88.com'].includes(new URL(page.url()).hostname))
      throw new Error('Doc88 перенаправил на другую страницу.');
    await page.waitForSelector('#pageNumInput', { state: 'attached', timeout: 90000 });
    const upstream = await fs.readFile(path.join(__dirname, 'vendor/downloadPages.js'), 'utf8');
    // Doc88 replaces window.Map with a legacy class, breaking Playwright's
    // main-world argument serializer. CDP evaluates the console code directly,
    // without changing the page's globals or disabling its security policy.
    const cdp = await context.newCDPSession(page);
    const evaluateConsole = async (expression, awaitPromise = false) => {
      const result = await cdp.send('Runtime.evaluate', {
        expression,
        awaitPromise,
        returnByValue: true,
      });
      if (result.exceptionDetails)
        throw new Error(
          (result.exceptionDetails.exception?.description || result.exceptionDetails.text).split(
            '\n',
          )[0],
        );
      return result.result.value;
    };
    const info = await evaluateConsole(
      `(() => {\n${upstream}\nwindow.__doc88OriginalDownloader = downloadPages; return { count: getPageCount(), title: getDocumentTitle() || document.title };\n})()`,
    );
    if (!Number.isSafeInteger(info.count) || info.count < 1)
      throw new Error('Doc88 не сообщил число страниц.');
    const end = job.toPage ?? info.count;
    if (job.fromPage > end || end > info.count)
      throw new Error(`В документе ${info.count} страниц. Проверь диапазон.`);
    const total = end - job.fromPage + 1;
    const limit = options.maxPages || MAX_PAGES;
    if (total > limit)
      throw new Error(`За один раз можно обработать до ${limit} страниц. Укажи диапазон.`);
    job.update({
      title: info.title,
      total,
      current: 0,
      stage: 'downloading',
      message: `Сохраняем ${total} страниц в архив…`,
    });
    // The page counter arrives before the asynchronous document renderer.
    // Wait for the first canvas before calling the unchanged upstream script.
    const rendererDeadline = Date.now() + 90000;
    while (!(await evaluateConsole("Boolean(document.getElementById('page_1'))"))) {
      checkAbort(job);
      if (Date.now() >= rendererDeadline)
        throw new Error(
          'Doc88 не загрузил страницы документа. Проверь открытое окно и повтори попытку.',
        );
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    // Upstream code creates the original ZIP. OCR libraries never run on Doc88.
    const pendingDownload = page.waitForEvent('download', { timeout: 15 * 60 * 1000 });
    pendingDownload.catch(() => {});
    let running = true;
    const watchdog = setTimeout(
      () => {
        if (running) context.close().catch(() => {});
      },
      15 * 60 * 1000,
    );
    try {
      const [download] = await Promise.all([
        pendingDownload,
        evaluateConsole(
          `window.__doc88OriginalDownloader(${JSON.stringify({ fromPage: job.fromPage, toPage: end })})`,
          true,
        ),
      ]);
      checkAbort(job);
      const failure = await download.failure();
      if (failure) throw new Error(`Не удалось скачать архив: ${failure}`);
      await download.saveAs(path.join(job.directory, 'archive.zip'));
      job.update({ archiveReady: true, archiveFilename: cleanName(info.title) + '.zip' });
    } finally {
      running = false;
      clearTimeout(watchdog);
    }
  } catch (error) {
    throw challengeError || error;
  } finally {
    job.controller.signal.removeEventListener('abort', closeOnAbort);
    await context.close().catch(() => {});
    job.browser = null;
  }
}

async function unpackArchive(job) {
  checkAbort(job);
  job.update({ stage: 'unpacking', current: 0, message: 'Проверяем и распаковываем изображения…' });
  const archivePath = path.join(job.directory, 'archive.zip');
  if ((await fs.stat(archivePath)).size > 250 * 1024 * 1024)
    throw new Error('Архив больше 250 МБ. Обработай документ частями.');
  const zip = await JSZip.loadAsync(await fs.readFile(archivePath));
  const entries = Object.values(zip.files).filter(
    (entry) =>
      !entry.dir && /\.(?:jpe?g|png)$/i.test(entry.name) && !entry.name.startsWith('__MACOSX/'),
  );
  if (!entries.length) throw new Error('В архиве нет изображений JPG или PNG.');
  if (entries.length > MAX_PAGES) throw new Error(`В архиве больше ${MAX_PAGES} страниц.`);
  const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  entries.sort((a, b) => collator.compare(a.name, b.name));
  let totalBytes = 0;
  for (const entry of entries) {
    const size = entry._data?.uncompressedSize;
    if (typeof size !== 'number' || size > MAX_IMAGE_BYTES)
      throw new Error('Изображение в архиве слишком большое.');
    totalBytes += size;
  }
  if (totalBytes > MAX_RAW_BYTES)
    throw new Error('Распакованный архив слишком большой. Обработай документ частями.');
  const imageDir = path.join(job.directory, 'images');
  await fs.mkdir(imageDir, { recursive: true });
  const images = [];
  for (let i = 0; i < entries.length; i++) {
    checkAbort(job);
    const entry = entries[i];
    const image = await entry.async('nodebuffer');
    if (!image.length || image.length > MAX_IMAGE_BYTES)
      throw new Error(`Не удалось прочитать изображение ${i + 1}.`);
    const png = image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpg = image[0] === 255 && image[1] === 216 && image[2] === 255;
    if (!png && !jpg) throw new Error(`Файл ${entry.name} не является изображением JPG или PNG.`);
    // Never use archive paths as filesystem paths.
    const output = path.join(
      imageDir,
      `page${String(i + 1).padStart(5, '0')}.${png ? 'png' : 'jpg'}`,
    );
    await fs.writeFile(output, image);
    images.push(output);
  }
  if (job.url && images.length !== job.total)
    throw new Error(`В архиве ${images.length} страниц, ожидалось ${job.total}. PDF не создан.`);
  job.update({ total: images.length, current: 0 });
  return images;
}

async function runNative(job, image, outputBase) {
  checkAbort(job);
  await new Promise((resolve, reject) => {
    const child = spawn(
      native,
      [image, outputBase, '-l', 'eng', '--dpi', '150', '--psm', '3', 'pdf', 'txt'],
      {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        signal: job.controller.signal,
      },
    );
    let errorText = '';
    child.stderr.on('data', (bytes) => {
      errorText = (errorText + bytes.toString('utf8')).slice(-4000);
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`OCR страницы не завершился: ${errorText.trim() || `код ${code}`}`)),
    );
  });
}

async function convertArchive(job) {
  const images = await unpackArchive(job);
  const pdf = await PDFDocument.create();
  pdf.setTitle(job.title);
  pdf.setCreator('Doc88 Local PDF');
  const pagesDir = path.join(job.directory, 'ocr');
  await fs.mkdir(pagesDir, { recursive: true });
  let worker = null;
  let textChars = 0;
  let blankPages = 0;
  const stopWorker = () => {
    if (worker) worker.terminate().catch(() => {});
  };
  try {
    if (!native) {
      job.update({ stage: 'ocr', message: 'Загружаем английскую модель OCR для первого запуска…' });
      const Tesseract = dependency('tesseract.js');
      const cachePath =
        process.env.DOC88_OCR_CACHE || job.cacheDirectory || path.join(job.directory, 'models');
      await fs.mkdir(cachePath, { recursive: true });
      const pendingWorker = Tesseract.createWorker('eng', 1, {
        cachePath,
        errorHandler: (error) => {
          job.log(`OCR: ${String(error).slice(0, 200)}`);
        },
      }).then(async (ready) => {
        if (job.controller.signal.aborted) {
          await ready.terminate();
          throw new Error('Обработка остановлена.');
        }
        return ready;
      });
      worker = await abortable(pendingWorker, job.controller.signal);
      job.controller.signal.addEventListener('abort', stopWorker, { once: true });
      checkAbort(job);
      await abortable(
        worker.setParameters({ tessedit_pageseg_mode: '3', user_defined_dpi: '150' }),
        job.controller.signal,
      );
    }
    for (let i = 0; i < images.length; i++) {
      checkAbort(job);
      job.update({
        stage: 'ocr',
        current: i,
        message: `Распознаём английский текст: страница ${i + 1} из ${images.length}`,
      });
      let pagePDF, text;
      if (native) {
        const base = path.join(pagesDir, `page${String(i + 1).padStart(5, '0')}`);
        await runNative(job, images[i], base);
        [pagePDF, text] = await Promise.all([
          fs.readFile(base + '.pdf'),
          fs.readFile(base + '.txt', 'utf8'),
        ]);
      } else {
        const { data } = await abortable(
          worker.recognize(images[i], { pdfTextOnly: false }, { text: true, pdf: true }),
          job.controller.signal,
        );
        pagePDF = data.pdf;
        text = data.text || '';
      }
      checkAbort(job);
      const source = await PDFDocument.load(pagePDF);
      if (source.getPageCount() !== 1)
        throw new Error(`Неожиданное число страниц в результате OCR страницы ${i + 1}.`);
      const pages = await pdf.copyPages(source, [0]);
      pdf.addPage(pages[0]);
      textChars += text.trim().length;
      if (!text.trim()) blankPages++;
      job.update({ current: i + 1 });
    }
    job.update({ stage: 'merging', message: 'Собираем итоговый PDF…' });
    checkAbort(job);
    const bytes = await pdf.save();
    const verified = await PDFDocument.load(bytes);
    if (verified.getPageCount() !== images.length)
      throw new Error('В итоговом PDF не хватает страниц.');
    checkAbort(job);
    const temporary = path.join(job.directory, 'result.tmp');
    await fs.writeFile(temporary, bytes);
    checkAbort(job);
    await fs.rename(temporary, path.join(job.directory, 'result.pdf'));
    job.update({
      stage: 'done',
      message: 'PDF готов. Можно скачать и искать текст.',
      current: images.length,
      pdfReady: true,
      pdfFilename: cleanName(job.title) + '_OCR.pdf',
      bytes: bytes.length,
      textChars,
      blankPages,
      finishedAt: new Date().toISOString(),
    });
  } finally {
    job.controller.signal.removeEventListener('abort', stopWorker);
    if (worker) await worker.terminate().catch(() => {});
  }
}

module.exports = {
  validateURL,
  validateRange,
  cleanName,
  downloadArchive,
  unpackArchive,
  convertArchive,
  nativeAvailable: Boolean(native),
};
