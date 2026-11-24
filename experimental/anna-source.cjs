'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path');
const { createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { PDFDocument } = require('pdf-lib');
const { requestPublic, webURL } = require('../public-http.cjs');
const { readJSON, atomicWrite } = require('../checkpoints.cjs');
const { digest } = require('../page-check.cjs');
const { createChallengeView } = require('../challenge-view.cjs');
const MAX_PDF = 250 * 1024 * 1024;
function references(cardURL, slowURL) {
  const card = webURL(cardURL, ['annas-archive.pk']);
  if (card.hostname !== 'annas-archive.pk') throw Error('Выберите карточку на annas-archive.pk.');
  const match = card.pathname.match(/^\/md5\/([a-f\d]{32})\/?$/i);
  if (!match) throw Error('Нужна ссылка на карточку /md5/…');
  const md5 = match[1].toLowerCase();
  let slow = null;
  if (slowURL) {
    const value = webURL(slowURL, ['annas-archive.pk']);
    if (
      value.hostname !== 'annas-archive.pk' ||
      !new RegExp('^/slow_download/' + md5 + '/\\d{1,3}/\\d{1,3}/?$', 'i').test(value.pathname)
    )
      throw Error('Ссылка скачивания должна относиться к той же карточке.');
    slow = 'https://annas-archive.pk' + value.pathname.replace(/\/$/, '');
  }
  return { md5, card: 'https://annas-archive.pk/md5/' + md5, slow };
}
function allowedPage(url, ref) {
  try {
    const parsed = webURL(url, ['annas-archive.pk']);
    return (
      parsed.hostname === 'annas-archive.pk' &&
      (parsed.pathname.replace(/\/$/, '') === '/md5/' + ref.md5 ||
        new RegExp('^/slow_download/' + ref.md5 + '/\\d{1,3}/\\d{1,3}/?$', 'i').test(
          parsed.pathname,
        ))
    );
  } catch {
    return false;
  }
}
function inspectPage() {
  const title = document.title || '',
    text = document.body?.innerText || '';
  const blocked =
    /DDOS-GUARD|Just a moment|Checking your browser/i.test(title) ||
    /Не удалось проверить ваш браузер|проверка браузера перед переходом|verify you are human|Performing security verification/i.test(
      text.slice(0, 2500),
    );
  return {
    blocked,
    links: blocked
      ? []
      : [...document.querySelectorAll('a[href]')].map((link) => ({
          url: link.href,
          text: (link.textContent || '').trim().slice(0, 200),
        })),
  };
}
const locateChallenge = `(()=>{const state=(${inspectPage.toString()})();return state.blocked?{id:null,x:0,y:0,width:innerWidth,height:innerHeight,viewportWidth:innerWidth,viewportHeight:innerHeight,scrollX,scrollY}:null;})()`;
function downloadLinks(state, ref) {
  return state.links
    .flatMap((link) => {
      try {
        const url = webURL(link.url);
        if (
          url.hostname === 'annas-archive.pk' ||
          (!/\.pdf(?:$|[?#])/i.test(url.href) &&
            !(url.href.toLowerCase().includes(ref.md5) && /download|скачать|get/i.test(link.text)))
        )
          return [];
        return [
          {
            url: url.href,
            score:
              (url.href.toLowerCase().includes(ref.md5) ? 10 : 0) +
              (/\.pdf(?:$|[?#])/i.test(url.href) ? 20 : 0) +
              (/download|скачать|get/i.test(link.text) ? 1 : 0),
          },
        ];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.score - a.score);
}
async function validatePDF(bytes, ref) {
  if (bytes.length > MAX_PDF || !bytes.subarray(0, 1024).includes(Buffer.from('%PDF-')))
    throw Error('Источник вернул не PDF или слишком большой файл.');
  if (createHash('md5').update(bytes).digest('hex') !== ref.md5)
    throw Object.assign(Error('Полученный файл не совпал с выбранной карточкой.'), {
      code: 'DOCUMENT_MISMATCH',
    });
  const pdf = await PDFDocument.load(bytes, { parseSpeed: 1500, updateMetadata: false });
  if (pdf.getPageCount() < 1 || pdf.getPageCount() > 2000)
    throw Error('Недопустимое число страниц PDF.');
  return pdf.getPageCount();
}
async function cachedSource(file, checkpoint, ref, signal) {
  signal.throwIfAborted();
  const record = await readJSON(checkpoint);
  if (record?.version !== 1 || record.card !== ref.card || record.md5 !== ref.md5) return null;
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_PDF) return null;
    const bytes = await fs.readFile(file);
    if (digest(bytes) !== record.sha256) return null;
    const pages = await validatePDF(bytes, ref);
    if (pages !== record.pages || bytes.length !== record.bytes) return null;
    signal.throwIfAborted();
    return { bytes, record, pages };
  } catch {
    signal.throwIfAborted();
    return null;
  }
}
async function previousSource(dataDirectory, ref, signal) {
  const jobs = path.join(dataDirectory, 'jobs');
  const entries = await fs.readdir(jobs, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries
    .filter(
      (entry) =>
        entry.isDirectory() && !entry.isSymbolicLink() && /^[a-f\d-]{36}$/i.test(entry.name),
    )
    .slice(-500)) {
    signal.throwIfAborted();
    const directory = path.join(jobs, entry.name, 'candidates', digest(ref.card).slice(0, 24));
    const cached = await cachedSource(
      path.join(directory, 'source.pdf'),
      path.join(directory, 'anna-download.json'),
      ref,
      signal,
    );
    if (cached) return cached;
  }
  return null;
}
async function downloadAnnaPDF(
  job,
  dataDirectory,
  {
    slowURL,
    request = requestPublic,
    launchContext,
    onBrowserView = () => {},
    tryCaptcha,
    timeoutMs = 10 * 60 * 1000,
    pollMs = 700,
  } = {},
) {
  const ref = references(job.url, slowURL),
    signal = job.controller.signal;
  await fs.mkdir(job.directory, { recursive: true });
  const file = path.join(job.directory, 'source.pdf'),
    checkpoint = path.join(job.directory, 'anna-download.json');
  const local = await cachedSource(file, checkpoint, ref, signal);
  const cached = local || (await previousSource(dataDirectory, ref, signal));
  if (cached) {
    if (!local) {
      await atomicWrite(file, cached.bytes);
      await atomicWrite(checkpoint, JSON.stringify(cached.record));
    }
    job.update({
      stage: 'checking',
      message: 'Проверяем сохранённый исходный PDF…',
      total: cached.pages,
      sourcePDFReused: true,
      reusedDownloadPages: cached.pages,
    });
    return file;
  }
  const context = launchContext
    ? await launchContext()
    : await require('playwright').chromium.launchPersistentContext(
        path.join(dataDirectory, 'anna-experiment-profile'),
        {
          channel: require('../runtime.cjs').browserChannel(),
          headless: true,
          acceptDownloads: true,
          viewport: { width: 960, height: 720 },
        },
      );
  let view,
    showing = false,
    pendingDownload = null,
    closing;
  const close = () => (closing ||= context.close().catch(() => {}));
  const stop = () => {
    void close();
  };
  signal.addEventListener('abort', stop, { once: true });
  async function challenge(show) {
    if (show === showing) return;
    showing = show;
    if (show) {
      onBrowserView(view);
      job.update({
        stage: 'waiting',
        challengeAvailable: true,
        message: 'Подтвердите доступ в окне проверки.',
      });
    } else {
      onBrowserView(null);
      await view.reset();
      job.update({
        stage: 'downloading',
        challengeAvailable: false,
        message: 'Ожидаем исходный PDF…',
      });
    }
  }
  try {
    signal.throwIfAborted();
    const page = await context.newPage(),
      cdp = await context.newCDPSession(page);
    view = createChallengeView({
      page,
      cdp,
      evaluate: (expression) => page.evaluate(expression),
      allowed: (url) => allowedPage(url, ref),
      locate: locateChallenge,
      maxWidth: 960,
      maxHeight: 720,
      allowKeyboard: true,
    });
    page.on('download', (download) => {
      pendingDownload = download.url();
      void download.cancel().catch(() => {});
    });
    job.update({ stage: 'opening', message: 'Открываем карточку PDF…' });
    await require('../browser-navigation.cjs').gotoSourcePage(page, ref.slow || ref.card, {
      signal,
      allowed: (value) => allowedPage(value, ref),
      onRetry: (info) => job.log?.(`Anna: повтор открытия документа ${info.attempt}; ${info.code}`),
    });
    const started = Date.now();
    let slowVisited = Boolean(ref.slow);
    while (Date.now() - started < timeoutMs) {
      signal.throwIfAborted();
      if (!allowedPage(page.url(), ref))
        throw Object.assign(
          Error('Источник открыл другую страницу подтверждения. Повторите попытку.'),
          { code: 'SOURCE_ACCESS_PENDING' },
        );
      let state;
      try {
        state = await page.evaluate(inspectPage);
      } catch (error) {
        signal.throwIfAborted();
        if (
          /Execution context was destroyed|Cannot find context with specified id/i.test(
            error.message,
          ) &&
          allowedPage(page.url(), ref)
        ) {
          await delay(pollMs, undefined, { signal });
          continue;
        }
        throw error;
      }
      if (
        state.blocked &&
        !showing &&
        tryCaptcha &&
        (await tryCaptcha({ page, allowed: (value) => allowedPage(value, ref) }))
      ) {
        await delay(pollMs, undefined, { signal });
        continue;
      }
      await challenge(state.blocked);
      if (!state.blocked) {
        // Card metadata can link to other catalogues with the same MD5. Follow
        // its free download page before considering external file links.
        if (!slowVisited) {
          const slow = state.links.find((link) => {
            try {
              return references(ref.card, link.url).slow;
            } catch {
              return false;
            }
          });
          if (!slow) throw Error('В карточке не найдена ссылка бесплатного скачивания.');
          slowVisited = true;
          await view.reset();
          await require('../browser-navigation.cjs').gotoSourcePage(
            page,
            references(ref.card, slow.url).slow,
            {
              signal,
              allowed: (value) => allowedPage(value, ref),
              onRetry: (info) =>
                job.log?.(`Anna: повтор страницы скачивания ${info.attempt}; ${info.code}`),
            },
          );
          continue;
        }
        const direct = pendingDownload || downloadLinks(state, ref)[0]?.url;
        if (direct) {
          job.update({ stage: 'downloading', message: 'Получаем исходный PDF…' });
          const response = await request(webURL(direct).href, {
            signal,
            maxBytes: MAX_PDF,
            timeoutMs: 120000,
          });
          signal.throwIfAborted();
          const pages = await validatePDF(response.bytes, ref);
          await atomicWrite(file, response.bytes);
          await atomicWrite(
            checkpoint,
            JSON.stringify({
              version: 1,
              card: ref.card,
              md5: ref.md5,
              sha256: digest(response.bytes),
              pages,
              bytes: response.bytes.length,
            }),
          );
          job.update({ total: pages, sourcePDFReused: false });
          return file;
        }
      }
      await delay(pollMs, undefined, { signal });
    }
    throw Object.assign(
      Error('Ожидание подтверждения доступа не завершено. Можно повторить попытку.'),
      { code: 'SOURCE_ACCESS_PENDING' },
    );
  } finally {
    signal.removeEventListener('abort', stop);
    onBrowserView(null);
    job.update({ challengeAvailable: false });
    await view?.close();
    await close();
  }
}
async function verifyScripts(job) {
  const { createCanvas } = require('@napi-rs/canvas');
  const { sampleIndices, inspectScripts } = require('../script-check.cjs');
  const bytes = await fs.readFile(path.join(job.directory, 'source.pdf'));
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    maxImageSize: 25000000,
    verbosity: 0,
  });
  const signal = job.controller.signal,
    stop = () => {
      void task.destroy().catch(() => {});
    };
  signal.addEventListener('abort', stop, { once: true });
  try {
    const pdf = await task.promise,
      numbers = sampleIndices(pdf.numPages).map((n) => n + 1),
      images = [];
    const directory = path.join(job.directory, 'source-samples');
    await fs.mkdir(directory, { recursive: true });
    for (const number of numbers) {
      signal.throwIfAborted();
      const page = await pdf.getPage(number),
        view = page.getViewport({ scale: 1 }),
        viewport = page.getViewport({
          scale: Math.min(2, 1600 / Math.max(view.width, view.height)),
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
      const file = path.join(directory, `page${String(number).padStart(5, '0')}.png`);
      await atomicWrite(file, canvas.toBuffer('image/png'));
      images.push(file);
      page.cleanup();
    }
    const proof = await inspectScripts({ ...job, directory }, images, { sampleAll: true });
    proof.evidence = proof.evidence.map((item) => ({ ...item, page: numbers[item.page - 1] }));
    job.update({ scriptVerification: proof });
    if (proof.status === 'failed')
      throw Object.assign(Error(proof.message), { code: 'FOREIGN_SCRIPT' });
  } finally {
    signal.removeEventListener('abort', stop);
    await task.destroy();
  }
}
module.exports = {
  references,
  allowedPage,
  inspectPage,
  downloadLinks,
  validatePDF,
  downloadAnnaPDF,
  verifyScripts,
};
