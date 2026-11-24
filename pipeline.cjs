'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { dependency, nativeOCR, browserChannel } = require('./runtime.cjs');
const { name: productName, displayText } = require('./dist/product.js');
const { digest, inspectPages } = require('./page-check.cjs');
const { atomicWrite, readJSON, capturePages, cachedArchive } = require('./checkpoints.cjs');
const { summarizeOCR, qualityPage } = require('./ocr-quality.cjs');
const { documentText } = require('./copy-text.cjs');
const { normativeReferences, addPDFStructure } = require('./document-analysis.cjs');
const JSZip = dependency('jszip');
const { PDFDocument } = dependency('pdf-lib');
const native = nativeOCR();
const MAX_PAGES = 2000;
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const MAX_RAW_BYTES = 800 * 1024 * 1024;

function checkAbort(job) {
  if (job.controller.signal.aborted) throw new Error('Обработка остановлена.');
}

function validateURL(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Вставь ссылку на документ или найди его по обозначению.');
  }
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    !['www.doc88.com', 'doc88.com'].includes(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    !/^\/p-\d+\.html$/.test(url.pathname)
  ) {
    throw new Error('Не удалось распознать ссылку. Попробуй найти документ по его обозначению.');
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
    displayText(value || 'document')
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
  let challengeWatchTask = null;
  const challengeController = new AbortController();
  let challengeTimer = null;
  let challengeWatchStopped = false;
  try {
    checkAbort(job);
    const page = context.pages()[0] || (await context.newPage());
    page.setDefaultTimeout(15 * 60 * 1000);
    page.on('dialog', async (dialog) => {
      if (options.rejectChallenges) {
        challengeError = new Error(
          'Требуется ручное подтверждение доступа. Автоматическая облачная загрузка остановлена.',
        );
        job.update({ stage: 'challenge', message: challengeError.message });
        await dialog.dismiss().catch(() => {});
        await context.close().catch(() => {});
        return;
      }
      job.update({
        stage: 'waiting',
        message: options.inlineChallenge
          ? 'Требуется подтверждение доступа. Выполни проверку в панели рядом.'
          : 'Требуется подтверждение доступа. Выполни проверку в открытом окне.',
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
      throw new Error(`Не удалось открыть документ: HTTP ${response.status()}.`);
    if (!['doc88.com', 'www.doc88.com'].includes(new URL(page.url()).hostname))
      throw new Error('Документ перенаправляет на неподдерживаемую страницу.');
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
      const {
        createChallengeView,
        visibleChallenge,
        allowedDocument,
      } = require('./challenge-view.cjs');
      challengeView = createChallengeView({ page, cdp, evaluate: evaluateConsole });
      options.onBrowserView?.(challengeView);
      const watch = async () => {
        if (
          challengeWatchStopped ||
          challengeWatchTask ||
          job.controller.signal.aborted ||
          page.isClosed()
        )
          return;
        challengeWatchTask = (async () => {
          const visible = Boolean(await evaluateConsole(visibleChallenge));
          if (challengeWatchStopped) return;
          if (visible && options.tryCaptcha && !job.challengeAvailable) {
            const handled = await options.tryCaptcha({
              page,
              cdp,
              evaluate: evaluateConsole,
              allowed: (value) =>
                allowedDocument(value) && new URL(value).pathname === new URL(job.url).pathname,
              signal: challengeController.signal,
            });
            if (challengeWatchStopped || handled) return;
          }
          if (visible !== Boolean(job.challengeAvailable)) {
            job.update({
              challengeAvailable: visible,
              ...(visible
                ? {
                    stage: 'waiting',
                    message: 'Подтверди доступ: передвинь ползунок в панели рядом.',
                  }
                : {}),
            });
            if (!visible) await challengeView.reset();
          }
        })().catch(() => {
          /* The page can navigate or close while a check is pending. */
        });
        try {
          await challengeWatchTask;
        } finally {
          challengeWatchTask = null;
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
      throw new Error('Не удалось определить число страниц документа.');
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
          throw new Error('Перед загрузкой страниц требуется ручное подтверждение доступа.');
        if (!waitingForCaptcha) {
          waitingForCaptcha = true;
          job.update({
            stage: 'waiting',
            message: options.inlineChallenge
              ? 'Подтверди доступ к страницам в панели рядом.'
              : 'Подтверди доступ в открытом окне документа.',
          });
        }
        if (Date.now() >= manualDeadline)
          throw new Error('Истекло время ожидания подтверждения доступа. Попробуй снова.');
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
          'Не удалось загрузить страницы документа. Проверь подтверждение доступа и повтори попытку.',
        );
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    // Reuse the upstream page renderer/capture functions, checkpoint each image
    // locally, then assemble the ZIP locally. Unsupported challenges retain the manual relay.
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
    challengeController.abort();
    await challengeWatchTask?.catch(() => {});
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

async function convertArchive(job) {
  const language = require('./dist/ocr-language.js').resolve(
    job.query,
    job.ocrLanguage,
    job.documentLanguage,
  );
  const native = nativeOCR(language);
  const images = await unpackArchive(job);
  if (job.enforceScript) {
    job.update({ stage: 'checking', message: 'Проверяем письменность исходных страниц…' });
    const proof = await require('./script-check.cjs').inspectScripts(job, images);
    job.update({ scriptVerification: proof });
    if (proof.status === 'failed')
      throw Object.assign(Error(proof.message), { code: 'FOREIGN_SCRIPT', verification: proof });
  }
  const records = await require('./ocr-pages.cjs').recognizePages(job, images, language, native);
  checkAbort(job);
  const pdf = await PDFDocument.create();
  pdf.setTitle(displayText(job.title));
  pdf.setCreator(productName);
  const texts = [],
    hashes = [],
    enhancements = [],
    qualityPages = [];
  let textChars = 0,
    blankPages = 0;
  const enhanceImages = job.enhanceImages !== false;
  const pdfOptimization = {
    version: 1,
    lossless: true,
    images: 0,
    compressedImages: 0,
    imageBytesBefore: 0,
    imageBytesAfter: 0,
  };
  job.update({ stage: 'merging', message: 'Собираем итоговый PDF…' });
  for (const [index, record] of records.entries()) {
    checkAbort(job);
    const source = await PDFDocument.load(await fs.readFile(record.base + '.pdf'), {
      parseSpeed: 1500,
      updateMetadata: false,
    });
    const [page] = await pdf.copyPages(source, [0]);
    if (record.enhancement.enhanced) {
      page.scale(1 / record.enhancement.scaleX, 1 / record.enhancement.scaleY);
      enhancements.push({ page: index + 1, ...record.enhancement });
    }
    pdf.addPage(page);
    texts.push(record.text);
    hashes.push(record.imageHash);
    textChars += record.text.trim().length;
    if (!record.text.trim()) blankPages++;
    qualityPages.push(qualityPage(index + 1, record.text, record.confidence));
    for (const field of ['images', 'compressedImages', 'imageBytesBefore', 'imageBytesAfter'])
      pdfOptimization[field] += record.optimization?.[field] || 0;
  }
  const pageIntegrity = inspectPages(texts, hashes, job.officialPages);
  const documentStructure = await require('./pdf-structure.cjs').structureFromPDF(
    await pdf.save({ objectsPerTick: 1500 }),
    texts,
    {
      signal: job.controller.signal,
      language,
      cacheDirectory: path.join(job.directory, 'structure-cache'),
      modelsDirectory: job.cacheDirectory,
      onWarning: (message) => job.log?.(message),
    },
  );
  const references = normativeReferences(texts);
  addPDFStructure(pdf, documentStructure);
  job.update({ stage: 'merging', message: 'Собираем итоговый PDF…' });
  checkAbort(job);
  const bytes = await pdf.save({ objectsPerTick: 1500 });
  const verified = await PDFDocument.load(bytes, { parseSpeed: 1500 });
  if (verified.getPageCount() !== images.length)
    throw new Error('В итоговом PDF не хватает страниц.');
  checkAbort(job);
  const temporary = path.join(job.directory, 'result.tmp');
  await fs.writeFile(temporary, bytes);
  checkAbort(job);
  await fs.rename(temporary, path.join(job.directory, 'result.pdf'));
  await atomicWrite(path.join(job.directory, 'copy-text.txt'), documentText(texts));
  job.update({
    stage: 'done',
    message: 'PDF готов. Можно скачать и искать текст.',
    current: images.length,
    pdfReady: true,
    pdfFilename: job.officialFilename || cleanName(job.title) + '_OCR.pdf',
    bytes: bytes.length,
    textChars,
    copyTextReady: true,
    blankPages,
    textlessPages: texts.flatMap((text, i) => (text.trim() ? [] : [i + 1])),
    ocrQuality: summarizeOCR(qualityPages),
    pageIntegrity,
    documentStructure,
    normativeReferences: references,
    pdfOptimization,
    imageEnhancement: { enabled: enhanceImages, pages: enhancements, count: enhancements.length },
    finishedAt: new Date().toISOString(),
  });
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
