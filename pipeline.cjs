'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { dependency, nativeOCR, browserChannel } = require('./runtime.cjs');
const { digest, inspectPages } = require('./page-check.cjs');
const { atomicWrite, readJSON, capturePages, cachedArchive } = require('./checkpoints.cjs');
const { prepareOCRImage } = require('./image-quality.cjs');
const { buildStructure, normativeReferences, addPDFStructure } = require('./document-analysis.cjs');
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
  if (await cachedArchive(job)) return;
  const { chromium } = dependency('playwright');
  job.update({
    stage: 'opening',
    message: options.inlineChallenge
      ? 'Открываем документ внутри приложения…'
      : options.headless
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
  let challengeView = null;
  let watchingChallenge = false;
  let challengeTimer = null;
  let challengeWatchStopped = false;
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
        message: options.inlineChallenge
          ? 'Doc88 просит подтверждение. Выполни его в панели справа.'
          : 'Doc88 просит подтверждение. Реши капчу или подтверди чтение в открытом окне.',
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
    if (options.inlineChallenge) {
      const { createChallengeView, visibleChallenge } = require('./challenge-view.cjs');
      challengeView = createChallengeView({ page, cdp, evaluate: evaluateConsole });
      options.onBrowserView?.(challengeView);
      const watch = async () => {
        if (
          challengeWatchStopped ||
          watchingChallenge ||
          job.controller.signal.aborted ||
          page.isClosed()
        )
          return;
        watchingChallenge = true;
        try {
          const visible = Boolean(await evaluateConsole(visibleChallenge));
          if (challengeWatchStopped) return;
          if (visible !== Boolean(job.challengeAvailable)) {
            job.update({
              challengeAvailable: visible,
              ...(visible
                ? {
                    stage: 'waiting',
                    message: 'Doc88 просит подтверждение. Передвинь ползунок в панели справа.',
                  }
                : {}),
            });
            if (!visible) await challengeView.reset();
          }
        } catch {
          /* The page can navigate or close while a check is pending. */
        } finally {
          watchingChallenge = false;
        }
      };
      await watch();
      challengeTimer = setInterval(() => {
        void watch();
      }, 400);
      challengeTimer.unref();
    }
    const info = await evaluateConsole(
      `(() => {\n${upstream}\nwindow.__doc88Reveal = revealAllPagePlaceholders;
      window.__doc88Capture = async (number) => {
        const canvas = getPageCanvas(number);
        if (!canvas) throw new Error('Missing page canvas ' + number);
        await preloadPage(number, canvas);
        const blob = await captureAsImageBlob(canvas, imageFormatFor({}));
        return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob); });
      };
      return { count: getPageCount(), title: getDocumentTitle() || document.title };\n})()`,
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
    let rendererDeadline = Date.now() + 90000;
    let waitingForCaptcha = false;
    const manualDeadline = Date.now() + 15 * 60 * 1000;
    while (!(await evaluateConsole("Boolean(document.getElementById('page_1'))"))) {
      checkAbort(job);
      const captcha = await evaluateConsole(
        "Boolean(document.getElementById('captcha_reading')?.getClientRects().length)",
      );
      if (captcha) {
        if (options.rejectChallenges)
          throw new Error(
            'Doc88 запросил капчу до первой страницы. Требуется ручное подтверждение в окне Doc88.',
          );
        if (!waitingForCaptcha) {
          waitingForCaptcha = true;
          job.update({
            stage: 'waiting',
            message: options.inlineChallenge
              ? 'Doc88 показывает проверку перед первой страницей. Пройди её в панели справа.'
              : 'Doc88 показывает ползунок проверки перед первой страницей. Пройди проверку в открытом окне документа.',
          });
        }
        if (Date.now() >= manualDeadline)
          throw new Error('Истекло время ожидания подтверждения Doc88. Попробуй снова.');
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      if (waitingForCaptcha) {
        waitingForCaptcha = false;
        rendererDeadline = Date.now() + 90000;
        job.update({ stage: 'opening', message: 'Ждём загрузку страниц после подтверждения…' });
      }
      if (Date.now() >= rendererDeadline)
        throw new Error(
          'Doc88 не загрузил страницы документа. Проверь открытое окно и повтори попытку.',
        );
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    // Reuse the upstream page renderer/capture functions, checkpoint each image
    // locally, then assemble the ZIP locally. Manual challenges are unchanged.
    let running = true;
    const watchdog = setTimeout(
      () => {
        if (running) context.close().catch(() => {});
      },
      15 * 60 * 1000,
    );
    try {
      await evaluateConsole('window.__doc88Reveal()', true);
      await capturePages(
        job,
        { ...info, filename: cleanName(info.title) + '.zip' },
        async (number) => {
          const data = await evaluateConsole(`window.__doc88Capture(${number})`, true);
          if (
            typeof data !== 'string' ||
            data.length > MAX_IMAGE_BYTES * 1.4 ||
            !data.startsWith('data:image/jpeg;base64,')
          )
            throw Error(`Не удалось прочитать изображение страницы ${number}.`);
          return Buffer.from(data.slice('data:image/jpeg;base64,'.length), 'base64');
        },
      );
    } finally {
      running = false;
      clearTimeout(watchdog);
    }
  } catch (error) {
    throw challengeError || error;
  } finally {
    challengeWatchStopped = true;
    clearInterval(challengeTimer);
    await challengeView?.close().catch(() => {});
    options.onBrowserView?.(null);
    if (job.challengeAvailable) job.update({ challengeAvailable: false });
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
  let reusedOCRPages = 0;
  const texts = [],
    hashes = [];
  const enhancements = [];
  const enhanceImages = job.enhanceImages !== false;
  const engine =
    (native ? 'native' : 'wasm') + '-eng-psm3-150-v2-' + (enhanceImages ? 'enhance1' : 'original');
  const stopWorker = () => {
    if (worker) worker.terminate().catch(() => {});
  };
  try {
    const ensureWorker = async () => {
      if (native || worker) return;
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
    };
    for (let i = 0; i < images.length; i++) {
      checkAbort(job);
      job.update({
        stage: 'ocr',
        current: i,
        message: `Распознаём английский текст: страница ${i + 1} из ${images.length}`,
      });
      let pagePDF,
        text,
        reused = false;
      let enhancement = { scaleX: 1, scaleY: 1, enhanced: false };
      const base = path.join(pagesDir, `page${String(i + 1).padStart(5, '0')}`);
      const imageHash = digest(await fs.readFile(images[i]));
      hashes.push(imageHash);
      const record = await readJSON(base + '.json');
      if (record?.imageHash === imageHash && record.engine === engine) {
        try {
          const [cachedPDF, cachedText] = await Promise.all([
            fs.readFile(base + '.pdf'),
            fs.readFile(base + '.txt', 'utf8'),
          ]);
          if (
            digest(cachedPDF) === record.pdfHash &&
            digest(cachedText) === record.textHash &&
            (await PDFDocument.load(cachedPDF)).getPageCount() === 1
          ) {
            pagePDF = cachedPDF;
            text = cachedText;
            reusedOCRPages++;
            reused = true;
            enhancement = record.enhancement || enhancement;
          }
        } catch {
          /* Damaged page caches are recognized again. */
        }
      }
      let ocrImage = images[i];
      if (!pagePDF) {
        const prepared = await prepareOCRImage(images[i], base + '.enhanced.png', enhanceImages);
        const { path: preparedPath, ...info } = prepared;
        ocrImage = preparedPath;
        enhancement = info;
        checkAbort(job);
      }
      if (!pagePDF && native) {
        await runNative(job, ocrImage, base + '.work');
        [pagePDF, text] = await Promise.all([
          fs.readFile(base + '.work.pdf'),
          fs.readFile(base + '.work.txt', 'utf8'),
        ]);
      } else if (!pagePDF) {
        await ensureWorker();
        job.update({
          stage: 'ocr',
          message: `Распознаём английский текст: страница ${i + 1} из ${images.length}`,
        });
        const { data } = await abortable(
          worker.recognize(ocrImage, { pdfTextOnly: false }, { text: true, pdf: true }),
          job.controller.signal,
        );
        pagePDF = data.pdf;
        text = data.text || '';
      }
      checkAbort(job);
      const source = await PDFDocument.load(pagePDF);
      if (source.getPageCount() !== 1)
        throw new Error(`Неожиданное число страниц в результате OCR страницы ${i + 1}.`);
      if (!reused) {
        await atomicWrite(base + '.pdf', pagePDF);
        await atomicWrite(base + '.txt', text);
        await atomicWrite(
          base + '.json',
          JSON.stringify({
            imageHash,
            engine,
            pdfHash: digest(pagePDF),
            textHash: digest(text),
            enhancement,
          }),
        );
        if (native)
          await Promise.all(
            ['.work.pdf', '.work.txt'].map((extension) => fs.rm(base + extension, { force: true })),
          );
      }
      const pages = await pdf.copyPages(source, [0]);
      if (enhancement.enhanced) {
        pages[0].scale(1 / enhancement.scaleX, 1 / enhancement.scaleY);
        enhancements.push({ page: i + 1, ...enhancement });
      }
      pdf.addPage(pages[0]);
      textChars += text.trim().length;
      if (!text.trim()) blankPages++;
      texts.push(text);
      job.update({ current: i + 1, reusedOCRPages });
    }
    const pageIntegrity = inspectPages(texts, hashes, job.officialPages);
    const documentStructure = buildStructure(texts);
    const references = normativeReferences(texts);
    addPDFStructure(pdf, documentStructure);
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
      pdfFilename: job.officialFilename || cleanName(job.title) + '_OCR.pdf',
      bytes: bytes.length,
      textChars,
      blankPages,
      pageIntegrity,
      documentStructure,
      normativeReferences: references,
      imageEnhancement: { enabled: enhanceImages, pages: enhancements, count: enhancements.length },
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
