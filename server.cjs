'use strict';
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const { randomUUID } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const {
  validateURL,
  validateRange,
  cleanName,
  downloadArchive,
  convertArchive,
  nativeAvailable,
} = require('./pipeline.cjs');
const { validateQuery, runSearchJob } = require('./search.cjs');
const { requestedPolicy, providersFor } = require('./source-policy.cjs');
const { createSourceSearch } = require('./source-search.cjs');
const { createCaptchaService } = require('./captcha-service.cjs');
const { createBrowserCaptchaSolver } = require('./captcha-browser.cjs');
const { validateBatch, summarizeBatch, batchZip, pdfFilename } = require('./batch.cjs');
const { atomicWrite } = require('./checkpoints.cjs');
const { displayText, present } = require('./dist/product.js');

const { resolve: ocrLanguage } = require('./dist/ocr-language.js');
const { choices: languageOptions, seriesChoices } = require('./dist/ocr-language.js');
const { createDevAccess, publicJob } = require('./dev-access.cjs');
const reviews = require('./document-review.cjs');
const sharedCache = require('./shared-cache.cjs');
const { feedback, failureKind } = require('./dist/job-feedback.js');
const { processDocument, requestedMode, validateMode } = require('./document-engine.cjs');
let devAccess, captchaService;
const PORT = Number(process.env.DOC88_PORT || 8968);
if (!Number.isSafeInteger(PORT) || PORT < 1 || PORT > 65535)
  throw new Error('DOC88_PORT должен быть целым числом от 1 до 65535.');
const DATA = path.resolve(process.env.DOC88_DATA_DIR || path.join(__dirname, '.data'));
const jobs = new Map();
const batches = new Map();
const pending = [];
let creatingBatch = false;
const browserViews = new Map();
let active = null;
const terminal = new Set(['done', 'error', 'cancelled', 'interrupted']);
const origins = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);

function snapshot(job) {
  const { controller, directory, browser, update, log, writing, cacheDirectory, ...publicData } =
    job;
  return {
    ...publicData,
    canResume:
      ['error', 'cancelled', 'interrupted'].includes(job.stage) &&
      Boolean(job.kind === 'search' || job.url || job.archiveReady),
  };
}

function enhanceSetting(value, isDev = false) {
  if (value === undefined) return true;
  if (typeof value !== 'boolean')
    throw Error('Настройка улучшения страниц должна быть включена или выключена.');
  return isDev ? value : true;
}
function persist(job) {
  const text = JSON.stringify(snapshot(job), null, 2);
  job.writing = (job.writing || Promise.resolve())
    .then(async () => {
      const temporary = path.join(job.directory, 'job.tmp');
      await fs.writeFile(temporary, text);
      await fs.rename(temporary, path.join(job.directory, 'job.json'));
    })
    .catch((error) => console.error('Could not save job metadata:', error.message));
}

function attachMethods(job) {
  job.challengeAvailable = false;
  job.captchaSolving = false;
  job.controller = new AbortController();
  job.directory = path.join(DATA, 'jobs', job.id);
  job.cacheDirectory = path.join(DATA, 'models');
  job.update = (changes) => {
    Object.assign(job, changes);
    persist(job);
  };
  job.log = (message) => {
    job.logs = [...(job.logs || []), { at: new Date().toISOString(), message }].slice(-12);
    persist(job);
  };
  return job;
}

async function newJob(input, queued = false) {
  if (!queued && (active || pending.length || creatingBatch))
    throw Object.assign(new Error('Сначала дождись текущей обработки или останови её.'), {
      status: 409,
    });
  const job = attachMethods({
    id: randomUUID(),
    stage: 'queued',
    message: 'Подготовка…',
    title: input.title || 'Документ',
    createdAt: new Date().toISOString(),
    current: 0,
    total: 0,
    archiveReady: false,
    pdfReady: false,
    logs: [],
    enhanceImages: true,
    ...input,
    ocrLanguage: ocrLanguage(input.query || input.title, input.ocrLanguage, input.documentLanguage),
    processingMode: validateMode(input.processingMode),
  });
  // Claim the slot before the first await so simultaneous requests cannot both run.
  if (!queued) active = job;
  try {
    await fs.mkdir(job.directory, { recursive: true });
    jobs.set(job.id, job);
    persist(job);
    return job;
  } catch (error) {
    if (active === job) active = null;
    throw error;
  }
}

async function runJob(job, needsDownload) {
  const resume = Boolean(job.resumeRequested);
  job.update({ resumeRequested: false, errorCode: null, failureKind: null });
  const downloadOptions = {
    tryCaptcha: createBrowserCaptchaSolver(captchaService, job),
    headless: true,
    inlineChallenge: true,
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 1,
    onBrowserView(view) {
      if (view) browserViews.set(job.id, view);
      else browserViews.delete(job.id);
      job.update({ challengeAvailable: false });
    },
  };
  try {
    if (job.kind === 'search' || job.kind === 'anna') {
      const sources = createSourceSearch(job, DATA, {
        chooseEdition: true,
        downloadOptions,
        resume,
        candidates: job.searchCandidates,
      });
      try {
        await runSearchJob(job, DATA, sources.options);
      } finally {
        await sources.close();
      }
    } else {
      if (needsDownload) await processDocument(job, DATA, { downloadOptions });
      else await convertArchive(job);
    }
  } catch (error) {
    const cancelled = job.controller.signal.aborted;
    job.update({
      stage: cancelled ? 'cancelled' : 'error',
      errorCode: cancelled ? null : error.code || null,
      failureKind: cancelled
        ? null
        : failureKind(error) === 'processing' && job.workflowPhase === 'edition'
          ? 'catalogue'
          : failureKind(error),
      message: cancelled ? 'Обработка остановлена.' : error.message,
      finishedAt: new Date().toISOString(),
    });
    console.error('Job', job.id, cancelled ? 'cancelled' : error.message);
  } finally {
    browserViews.delete(job.id);
    if (job.stage === 'done')
      job.update({ review: reviews.publicReview(await reviews.reviewFor(job, DATA)) });
    if (job.captchaSolving) job.update({ captchaSolving: false });
    if (job.challengeAvailable) job.update({ challengeAvailable: false });
    if (active === job) active = null;
    pump();
  }
}
async function enqueueDocuments(job, references, preferred) {
  const single = references === null;
  const codes = Array.isArray(preferred) ? preferred : [preferred];
  const editions = single
    ? [job.catalogueEdition || job.isoEdition]
    : references.map((reference) =>
        job.seriesOptions?.find((item) => item.reference === reference),
      );
  if (!editions.length || editions.some((item) => !item))
    throw Error('Выберите документы из предложенной серии.');
  if (
    !codes.length ||
    !codes.every((code) => seriesChoices(editions).some((choice) => choice.code === code))
  )
    throw Error('Выберите язык из списка.');
  const multilingual = codes.length > 1;
  const entries = editions.flatMap((edition) => {
    const available = languageOptions(edition.reference, edition).filter((choice) =>
      codes.includes(choice.code),
    );
    return multilingual && available.length
      ? available.map((choice) => ({ edition, language: choice.code }))
      : [{ edition, language: null }];
  });
  if (creatingBatch || pending.length + entries.length > 500)
    throw Object.assign(Error('Дождитесь добавления текущего списка.'), { status: 409 });
  creatingBatch = true;
  const previous = Object.fromEntries(
    [
      'stage',
      'query',
      'title',
      'resolvedQuery',
      'seriesOptions',
      'seriesReference',
      'languageScope',
      'languageChoices',
      'languageDocumentCount',
      'pendingSeriesReferences',
      'documentLanguage',
      'batchLanguagePreference',
      'languageException',
      'isoEdition',
      'catalogueEdition',
      'batchId',
      'selectedSeriesReferences',
      'originalSeriesQuery',
      'ocrLanguage',
      'multilingual',
      'searchCandidates',
      'searchResults',
      'message',
    ].map((key) => [key, job[key]]),
  );
  const existing = batches.get(job.batchId);
  const batch = existing
      ? {
          ...existing,
          jobIds: [...existing.jobIds],
          languages: [...new Set([...(existing.languages || []), ...codes])],
        }
      : {
          id: randomUUID(),
          createdAt: new Date().toISOString(),
          jobIds: [job.id],
          languages: codes,
        },
    created = [];
  const first = entries[0],
    firstEdition = first.edition;
  job.controller = new AbortController();
  job.update({
    stage: 'queued',
    query: single ? job.query : firstEdition.reference,
    title: firstEdition.reference,
    originalSeriesQuery: single ? job.originalSeriesQuery : job.query,
    resolvedQuery: firstEdition.reference,
    isoEdition: firstEdition.publisher && firstEdition.publisher !== 'ISO' ? null : firstEdition,
    catalogueEdition:
      firstEdition.publisher && firstEdition.publisher !== 'ISO' ? firstEdition : null,
    batchId: batch.id,
    seriesOptions: null,
    selectedSeriesReferences: single ? job.selectedSeriesReferences : references,
    batchLanguagePreference: codes[0],
    documentLanguage: first.language,
    ocrLanguage: first.language || job.ocrLanguage,
    multilingual,
    searchCandidates: null,
    searchResults: [],
    languageScope: null,
    languageChoices: null,
    languageException: null,
    languageDocumentCount: null,
    pendingSeriesReferences: null,
    message: 'В очереди.',
  });
  try {
    for (const { edition, language } of entries.slice(1)) {
      const member = await newJob(
        {
          kind: 'search',
          sourcePolicy: job.sourcePolicy,
          ...(job.searchProvider === 'anna' ? { searchProvider: 'anna' } : {}),
          query: edition.reference,
          title: edition.reference,
          ...(edition.publisher && edition.publisher !== 'ISO'
            ? { catalogueEdition: edition }
            : { isoEdition: edition }),
          batchId: batch.id,
          enhanceImages: job.enhanceImages,
          ocrLanguage: language || job.ocrLanguage,
          documentLanguage: language,
          batchLanguagePreference: codes[0],
          multilingual,
          processingMode: job.processingMode || 'auto',
        },
        true,
      );
      created.push(member);
    }
    batch.jobIds.splice(batch.jobIds.indexOf(job.id) + 1, 0, ...created.map((member) => member.id));
    await fs.mkdir(path.join(DATA, 'batches'), { recursive: true });
    await Promise.all([job.writing, ...created.map((member) => member.writing)]);
    await atomicWrite(path.join(DATA, 'batches', batch.id + '.json'), JSON.stringify(batch));
    batches.set(batch.id, batch);
    pending.push(job, ...created);
    return batch;
  } catch (error) {
    job.update(previous);
    for (const member of created)
      member.update({ stage: 'error', message: 'Не удалось добавить список.' });
    throw error;
  } finally {
    creatingBatch = false;
    pump();
  }
}
function pump() {
  if (active || creatingBatch) return;
  while (pending.length) {
    const job = pending.shift();
    if (job.stage !== 'queued') continue;
    active = job;
    void runJob(job, Boolean(job.url));
    return;
  }
}
function resumeJob(job) {
  if (!snapshot(job).canResume) throw Error('Этот документ сейчас нельзя продолжить.');
  job.controller = new AbortController();
  if (
    job.languageScope === 'series' &&
    job.pendingSeriesReferences?.length &&
    job.languageChoices?.length
  ) {
    job.update({
      stage: 'language',
      finishedAt: null,
      message: 'Выберите язык для выбранных документов.',
    });
    return;
  }
  if (job.kind === 'search' && job.isoChoices?.length && !job.resolvedQuery) {
    job.update({
      stage: 'choosing',
      finishedAt: null,
      message: 'Выбери издание из истории ISO, чтобы продолжить поиск.',
    });
    return;
  }
  job.update({
    stage: 'queued',
    resumeRequested: true,
    pdfReady: false,
    finishedAt: null,
    message: 'В очереди на продолжение. Сохранённые страницы будут использованы повторно.',
  });
  pending.push(job);
}
function cancelJob(job) {
  if (terminal.has(job.stage)) return;
  job.controller.abort();
  if (active !== job)
    job.update({
      stage: 'cancelled',
      message: 'Обработка остановлена. Сохранённые страницы можно продолжить.',
      finishedAt: new Date().toISOString(),
    });
}

function json(response, status, value) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(value));
}

async function readBody(request, limit) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit)
      throw Object.assign(new Error('Файл или запрос слишком большой.'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const staticFiles = new Map([
  ...['asme.svg', 'bs.svg', 'din.png', 'en.svg', 'iso.svg', 'nf.webp'].map((name) => [
    '/logo-' + name,
    [
      'logo-' + name,
      name.endsWith('.svg') ? 'image/svg+xml' : name.endsWith('.png') ? 'image/png' : 'image/webp',
    ],
  ]),
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/query.js', ['query.js', 'text/javascript; charset=utf-8']],
  ['/i18n.js', ['i18n.js', 'text/javascript; charset=utf-8']],
  ['/standard-reference.js', ['standard-reference.js', 'text/javascript; charset=utf-8']],
  ['/ocr-language.js', ['ocr-language.js', 'text/javascript; charset=utf-8']],
  ['/job-feedback.js', ['job-feedback.js', 'text/javascript; charset=utf-8']],
  ['/product.js', ['product.js', 'text/javascript; charset=utf-8']],
  ['/challenge.js', ['challenge.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/icon.svg', ['icon.svg', 'image/svg+xml']],
]);

const server = http.createServer(async (request, response) => {
  try {
    if (![`127.0.0.1:${PORT}`, `localhost:${PORT}`].includes(request.headers.host))
      return json(response, 403, { error: 'Недопустимый адрес приложения.' });
    const url = new URL(request.url, `http://127.0.0.1:${PORT}`);
    if (
      request.method === 'POST' &&
      (!origins.has(request.headers.origin) || request.headers['x-doc88-request'] !== '1')
    ) {
      return json(response, 403, { error: 'Открой приложение через его локальную страницу.' });
    }
    const isDev = devAccess.authenticated(request);
    const view = (job) => {
      const value = isDev ? { ...snapshot(job), ...feedback(job) } : publicJob(snapshot(job));
      if (job.pdfFilename) value.pdfFilename = pdfFilename(job);
      return value;
    };
    const batchView = (batch) => {
      const value = summarizeBatch(batch, jobs, view);
      if (!isDev)
        value.items = value.items.map((item) => {
          const projected = view(jobs.get(item.id));
          return {
            ...item,
            message: projected.message,
            progress: projected.progress,
            problem: projected.problem,
            hasQualityNotes: Boolean(projected.qualityNotes?.length),
            pageCheckStatus: undefined,
          };
        });
      return isDev ? value : present(value);
    };
    if (url.pathname === '/api/dev/cache' && request.method === 'GET') {
      if (!isDev) return json(response, 403, { error: 'Требуется вход в dev-режим.' });
      const log = await reviews.readReviews(DATA);
      const items = require('./cache-list.cjs').cacheList(jobs.values(), log.records);
      return json(response, 200, { items, events: log.events });
    }
    const cacheReuse = url.pathname.match(/^\/api\/dev\/cache\/([a-f\d-]{36})\/reuse$/);
    if (request.method === 'POST' && cacheReuse) {
      if (!isDev) return json(response, 403, { error: 'Требуется вход в dev-режим.' });
      const old = jobs.get(cacheReuse[1]);
      if (
        !old ||
        !sharedCache.verified(old) ||
        (await reviews.reviewFor(old, DATA))?.rating === 'bad'
      )
        return json(response, 409, {
          error: 'Этот документ требует повторной проверки. Запустите новый поиск.',
        });
      const job = await newJob({
        kind: 'search',
        query: old.resolvedQuery || old.query,
        resolvedQuery: old.resolvedQuery,
        title: old.title,
        isoEdition: old.isoEdition,
        catalogueEdition: old.catalogueEdition,
        documentLanguage: old.documentLanguage,
        ocrLanguage: old.ocrLanguage,
        enhanceImages: old.enhanceImages,
        processingMode: old.processingMode,
      });
      try {
        const cached = await sharedCache.loadSharedCache(job, DATA);
        if (!cached?.ready) throw Error('Кеш повреждён или неполон. Запустите новый поиск.');
        job.update({ review: reviews.publicReview(await reviews.reviewFor(job, DATA)) });
        return json(response, 200, view(job));
      } catch (error) {
        job.update({ stage: 'error', message: error.message });
        throw error;
      } finally {
        if (active === job) active = null;
        pump();
      }
    }
    const reviewMatch = url.pathname.match(/^\/api\/jobs\/([a-f\d-]{36})\/review$/);
    if (request.method === 'POST' && reviewMatch) {
      const job = jobs.get(reviewMatch[1]);
      if (!job || job.stage !== 'done' || !job.pdfReady)
        return json(response, 409, { error: 'Оценка доступна после подготовки PDF.' });
      const input = JSON.parse((await readBody(request, 20000)).toString('utf8'));
      const saved = await reviews.saveReview(job, input, DATA);
      for (const item of jobs.values())
        if (reviews.reviewKey(item) === saved.key)
          item.update({ review: reviews.publicReview(saved) });
      return json(response, 200, { review: reviews.publicReview(saved) });
    }
    if (request.method === 'POST' && url.pathname === '/api/dev/login') {
      const input = JSON.parse((await readBody(request, 2000)).toString('utf8'));
      devAccess.login(request, response, input.password);
      return json(response, 200, { devMode: true });
    }
    if (request.method === 'POST' && url.pathname === '/api/dev/logout') {
      devAccess.logout(request, response);
      return json(response, 200, { devMode: false });
    }
    if (url.pathname === '/api/dev/captcha' || url.pathname === '/api/dev/captcha/balance') {
      if (!isDev) return json(response, 403, { error: 'Требуется вход в dev-режим.' });
      if (request.method === 'GET' && url.pathname === '/api/dev/captcha')
        return json(response, 200, captchaService.summary());
      if (request.method === 'POST' && url.pathname === '/api/dev/captcha') {
        const input = JSON.parse((await readBody(request, 2000)).toString('utf8'));
        return json(response, 200, await captchaService.update(input));
      }
      if (request.method === 'POST' && url.pathname === '/api/dev/captcha/balance')
        return json(response, 200, await captchaService.balance());
      return json(response, 405, { error: 'Метод не поддерживается.' });
    }
    if (request.method === 'POST' && url.pathname === '/api/experiments/anna') {
      if (!isDev) return json(response, 403, { error: 'Требуется вход в dev-режим.' });
      const input = JSON.parse((await readBody(request, 10000)).toString('utf8'));
      const query = validateQuery(input.query);
      if (!require('./iso-catalog.cjs').reference(query))
        throw Error('Этот эксперимент поддерживает обозначения ISO.');
      const ref = input.cardURL
        ? require('./experimental/anna-source.cjs').references(input.cardURL, input.slowURL)
        : null;
      if (!ref && input.slowURL) throw Error('Для страницы скачивания укажите карточку документа.');
      const job = await newJob({
        kind: 'search',
        sourcePolicy: 'anna-only',
        searchProvider: 'anna',
        provider: 'anna',
        query,
        title: query,
        ...(ref ? { url: ref.card, annaCardURL: ref.card, annaSlowURL: ref.slow } : {}),
        ocrLanguage: 'eng',
        documentLanguage: 'eng',
        enhanceImages: true,
        processingMode: 'auto',
      });
      json(response, 202, view(job));
      void runJob(job, true);
      return;
    }
    if (request.method === 'GET' && staticFiles.has(url.pathname)) {
      const [file, type] = staticFiles.get(url.pathname);
      const bytes = await fs.readFile(path.join(__dirname, 'dist', file));
      response.writeHead(200, {
        'Content-Type': type,
        'Cache-Control': 'no-cache',
        'Content-Security-Policy':
          "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'",
      });
      return response.end(bytes);
    }
    if (request.method === 'GET' && url.pathname === '/api/status')
      return json(response, 200, {
        app: 'doc88-local-pdf',
        devMode: isDev,
        devConfigured: devAccess.configured,
        ocr: nativeAvailable ? 'ready' : 'download-on-first-use',
        activeId: active?.id || null,
        jobs: [...jobs.values()].slice(-10).reverse().map(view),
        batches: [...batches.values()].slice(-5).reverse().map(batchView),
      });
    if (request.method === 'POST' && url.pathname === '/api/batches') {
      const input = JSON.parse((await readBody(request, 20000)).toString('utf8'));
      const queries = validateBatch(input.queries);
      const sourcePolicy = requestedPolicy(input.sourcePolicy, isDev);
      if (creatingBatch || pending.length + queries.length > 100)
        return json(response, 409, {
          error: 'Дождись добавления текущего списка или освобождения очереди.',
        });
      creatingBatch = true;
      const created = [];
      try {
        const batch = { id: randomUUID(), createdAt: new Date().toISOString(), jobIds: [] };
        for (const query of queries) {
          const job = await newJob(
            {
              kind: 'search',
              sourcePolicy,
              query,
              title: query,
              batchId: batch.id,
              enhanceImages: enhanceSetting(input.enhanceImages, isDev),
              ocrLanguage: input.ocrLanguage,
              processingMode: requestedMode(input.processingMode, isDev),
            },
            true,
          );
          created.push(job);
          batch.jobIds.push(job.id);
        }
        await Promise.all(created.map((job) => job.writing));
        await fs.mkdir(path.join(DATA, 'batches'), { recursive: true });
        await atomicWrite(path.join(DATA, 'batches', batch.id + '.json'), JSON.stringify(batch));
        batches.set(batch.id, batch);
        pending.push(...created);
        json(response, 202, batchView(batch));
      } catch (error) {
        for (const job of created)
          job.update({
            stage: 'error',
            message: 'Не удалось добавить список. Можно продолжить документ отдельно.',
          });
        throw error;
      } finally {
        creatingBatch = false;
        pump();
      }
      return;
    }
    const batchMatch = url.pathname.match(
      /^\/api\/batches\/([a-f\d-]{36})(?:\/(zip|cancel|resume))?$/,
    );
    if (batchMatch) {
      const batch = batches.get(batchMatch[1]);
      if (!batch) return json(response, 404, { error: 'Список документов не найден.' });
      if (request.method === 'GET' && !batchMatch[2]) return json(response, 200, batchView(batch));
      if (request.method === 'GET' && batchMatch[2] === 'zip') {
        if (!summarizeBatch(batch, jobs, snapshot).ready)
          return json(response, 409, { error: 'Готовых PDF пока нет.' });
        response.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': 'attachment; filename="DecliPDF_documents.zip"',
          'Cache-Control': 'no-store',
        });
        await pipeline(batchZip(batch, jobs, isDev), response);
        return;
      }
      if (request.method === 'POST' && ['cancel', 'resume'].includes(batchMatch[2])) {
        for (const id of batch.jobIds) {
          const job = jobs.get(id);
          if (!job) continue;
          if (batchMatch[2] === 'cancel') cancelJob(job);
          else if (snapshot(job).canResume) resumeJob(job);
        }
        pump();
        return json(response, 200, batchView(batch));
      }
    }
    if (request.method === 'POST' && url.pathname === '/api/jobs') {
      const input = JSON.parse((await readBody(request, 10000)).toString('utf8'));
      const docURL = validateURL(input.url);
      const range = validateRange(input.fromPage, input.toPage);
      const job = await newJob({
        url: docURL,
        ...range,
        enhanceImages: enhanceSetting(input.enhanceImages, isDev),
        ocrLanguage: input.ocrLanguage,
        processingMode: requestedMode(input.processingMode, isDev),
      });
      json(response, 202, view(job));
      void runJob(job, true);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/search') {
      const input = JSON.parse((await readBody(request, 10000)).toString('utf8'));
      const query = validateQuery(input?.query);
      const sourcePolicy = requestedPolicy(input.sourcePolicy, isDev);
      let searchCandidates;
      let isoMetadata;
      if (input.candidateURL) {
        if (!isDev) return json(response, 403, { error: 'Требуется вход в dev-режим.' });
        const previous = jobs.get(input.sourceJobId);
        const candidateURL = String(input.candidateURL);
        const candidate =
          previous?.kind === 'search' && validateQuery(previous.query) === query
            ? previous.searchResults?.find((item) => item.url === candidateURL)
            : null;
        if (!candidate)
          throw new Error('Вариант не найден в результатах поиска. Запусти поиск снова.');
        if (!providersFor(sourcePolicy).includes(candidate.provider || 'doc88'))
          throw Error('Источник выбранного варианта отключён. Измените выбор источников.');
        searchCandidates = [{ ...candidate, status: 'unverified', checks: null, error: undefined }];
        isoMetadata = {
          resolvedQuery: previous.resolvedQuery,
          isoEdition: previous.isoEdition,
          isoLookupURL: previous.isoLookupURL,
          catalogueEdition: previous.catalogueEdition,
        };
      }
      const job = await newJob({
        kind: 'search',
        sourcePolicy,
        query,
        title: query,
        enhanceImages: enhanceSetting(input.enhanceImages, isDev),
        ocrLanguage: input.ocrLanguage,
        ...(searchCandidates ? { searchCandidates } : {}),
        processingMode: requestedMode(input.processingMode, isDev),
        ...isoMetadata,
      });
      json(response, 202, view(job));
      void runJob(job, false);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/upload') {
      if (active || pending.length || creatingBatch)
        return json(response, 409, { error: 'Сначала дождись текущей обработки или останови её.' });
      const archive = await readBody(request, 250 * 1024 * 1024);
      if (archive.length < 4 || archive[0] !== 0x50 || archive[1] !== 0x4b)
        return json(response, 400, { error: 'Выбери ZIP-архив с изображениями страниц.' });
      const uploadedName = cleanName(
        decodeURIComponent(request.headers['x-filename'] || 'document.zip'),
      );
      const enhanceHeader = request.headers['x-doc88-enhance'];
      if (enhanceHeader !== undefined && !['0', '1'].includes(enhanceHeader))
        throw Error('Неверная настройка улучшения страниц.');
      const job = await newJob({
        title: uploadedName.replace(/\.zip$/i, ''),
        url: null,
        enhanceImages: !isDev || enhanceHeader !== '0',
        ocrLanguage: request.headers['x-ocr-language'],
      });
      try {
        await fs.writeFile(path.join(job.directory, 'archive.zip'), archive);
        job.update({
          archiveReady: true,
          archiveFilename: uploadedName.endsWith('.zip') ? uploadedName : uploadedName + '.zip',
        });
      } catch (error) {
        job.update({ stage: 'error', message: error.message });
        active = null;
        throw error;
      }
      json(response, 202, view(job));
      void runJob(job, false);
      return;
    }
    const seriesChoice = url.pathname.match(/^\/api\/jobs\/([a-f\d-]{36})\/series$/);
    if (request.method === 'POST' && seriesChoice) {
      const job = jobs.get(seriesChoice[1]);
      if (!job || job.stage !== 'selecting')
        return json(response, 409, { error: 'Выбор серии уже завершён.' });
      const input = JSON.parse((await readBody(request, 30000)).toString('utf8'));
      if (
        !Array.isArray(input.references) ||
        !input.references.length ||
        input.references.length > 200 ||
        !input.references.every((reference) => typeof reference === 'string')
      )
        return json(response, 400, { error: 'Выберите от 1 до 200 документов серии.' });
      const references = [...new Set(input.references)];
      const editions = references.map((reference) =>
        job.seriesOptions?.find((item) => item.reference === reference),
      );
      if (editions.some((edition) => !edition))
        return json(response, 400, { error: 'Выберите документы из предложенной серии.' });
      if (job.stage !== 'selecting' || creatingBatch || pending.length + editions.length > 500)
        return json(response, 409, { error: 'Дождитесь добавления текущего списка.' });
      const choices = seriesChoices(editions);
      if (choices.length > 1) {
        job.update({
          stage: 'language',
          languageScope: 'series',
          languageChoices: choices,
          pendingSeriesReferences: references,
          languageDocumentCount: references.length,
          pdfReady: false,
          message: 'Выберите язык для выбранных документов.',
        });
        return json(response, 200, view(job));
      }
      const batch = await enqueueDocuments(job, references, choices[0]?.code);
      return json(response, 202, batchView(batch));
    }
    const reselectLanguage = url.pathname.match(/^\/api\/jobs\/([a-f\d-]{36})\/reselect-language$/);
    if (request.method === 'POST' && reselectLanguage) {
      const job = jobs.get(reselectLanguage[1]);
      if (
        !job ||
        job.kind !== 'search' ||
        job.stage !== 'error' ||
        feedback(job).problem?.type !== 'language'
      )
        return json(response, 409, { error: 'Для этого документа выбор языка сейчас недоступен.' });
      const choices = languageOptions(
        job.resolvedQuery || job.query,
        job.catalogueEdition || job.isoEdition,
      );
      if (choices.length < 2)
        return json(response, 409, { error: 'Для этого обозначения доступен один язык.' });
      job.update({
        stage: 'language',
        languageChoices: choices,
        finishedAt: null,
        pdfReady: false,
        message: 'Выберите язык документа.',
      });
      return json(response, 200, view(job));
    }
    const languageChoice = url.pathname.match(/^\/api\/jobs\/([a-f\d-]{36})\/language$/);
    if (request.method === 'POST' && languageChoice) {
      const job = jobs.get(languageChoice[1]);
      if (!job || job.stage !== 'language')
        return json(response, 409, { error: 'Выбор языка уже завершён.' });
      const input = JSON.parse((await readBody(request, 2000)).toString('utf8'));
      const codes = input.codes === undefined ? [input.code] : input.codes;
      if (
        !Array.isArray(codes) ||
        !codes.length ||
        codes.length > 4 ||
        !codes.every(
          (code) =>
            typeof code === 'string' && job.languageChoices?.some((item) => item.code === code),
        )
      )
        return json(response, 400, { error: 'Выберите язык из списка.' });
      const selected = [...new Set(codes)];
      if (job.stage !== 'language') return json(response, 409, { error: 'Поиск уже запущен.' });
      if (job.languageScope === 'series') {
        const batch = await enqueueDocuments(job, job.pendingSeriesReferences || [], selected);
        return json(response, 202, batchView(batch));
      }
      if (selected.length > 1) {
        const batch = await enqueueDocuments(job, null, selected);
        return json(response, 202, batchView(batch));
      }
      job.controller = new AbortController();
      job.update({
        stage: 'queued',
        documentLanguage: selected[0],
        ocrLanguage: selected[0],
        languageChoices: null,
        languageException: null,
        finishedAt: null,
        message: 'Готовим поиск выбранного языка…',
      });
      pending.push(job);
      json(response, 202, view(job));
      pump();
      return;
    }
    const editionChoice = url.pathname.match(/^\/api\/jobs\/([a-f\d-]{36})\/edition$/);
    if (request.method === 'POST' && editionChoice) {
      const job = jobs.get(editionChoice[1]);
      if (!job || job.kind !== 'search' || job.stage !== 'choosing')
        return json(response, 409, { error: 'Выбор издания уже завершён. Запусти поиск снова.' });
      const input = JSON.parse((await readBody(request, 2000)).toString('utf8'));
      // The client submits only a reference from our saved ISO catalogue result.
      // It cannot supply a source URL, edition metadata or an arbitrary year.
      const edition = job.isoChoices?.find(
        (item) =>
          item.reference === input?.reference &&
          /^(Published|Withdrawn|Historical)$/.test(item.status),
      );
      if (!edition) return json(response, 400, { error: 'Выбери издание из списка ISO.' });
      // Reserve the worker after reading the body; a competing request may have
      // claimed it while the request stream was being read.
      if (job.stage !== 'choosing')
        return json(response, 409, { error: 'Поиск уже запущен. Дождись результата.' });
      job.controller = new AbortController();
      job.update({
        stage: 'queued',
        resolvedQuery: edition.reference,
        ...(edition.publisher && edition.publisher !== 'ISO'
          ? { catalogueEdition: edition, isoEdition: null }
          : { isoEdition: edition }),
        title: edition.reference,
        searchResults: [],
        searchCandidates: null,
        namingWarning: null,
        message: `Выбрано ${edition.reference}. Готовим поиск…`,
      });
      json(response, 202, view(job));
      pending.push(job);
      pump();
      return;
    }
    const challenge = url.pathname.match(/^\/api\/jobs\/([a-f\d-]{36})\/challenge\/(frame|input)$/);
    if (challenge) {
      if (request.headers['x-doc88-request'] !== '1')
        return json(response, 403, { error: 'Открой проверку в приложении.' });
      const job = jobs.get(challenge[1]);
      const view = browserViews.get(challenge[1]);
      if (!job || active !== job || !view)
        return json(response, 404, { error: 'Проверка уже завершена.' });
      if (request.method === 'GET' && challenge[2] === 'frame') {
        if (!job.challengeAvailable)
          return json(response, 409, { error: 'Подтверждение сейчас не требуется.' });
        response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        return json(response, 200, await view.frame());
      }
      if (request.method === 'POST' && challenge[2] === 'input') {
        const input = JSON.parse((await readBody(request, 2000)).toString('utf8'));
        if (!job.challengeAvailable && input?.type !== 'up')
          return json(response, 409, { error: 'Подтверждение сейчас не требуется.' });
        await view.input(input);
        return json(response, 200, { ok: true });
      }
      return json(response, 405, { error: 'Недопустимое действие.' });
    }
    const match = url.pathname.match(
      /^\/api\/jobs\/([a-f\d-]{36})(?:\/(cancel|resume|pdf|zip|text))?$/,
    );
    if (match) {
      const job = jobs.get(match[1]);
      if (!job) return json(response, 404, { error: 'Документ не найден.' });
      if (request.method === 'GET' && !match[2]) return json(response, 200, view(job));
      if (request.method === 'POST' && match[2] === 'cancel') {
        cancelJob(job);
        return json(response, 200, { ok: true });
      }
      if (request.method === 'POST' && match[2] === 'resume') {
        resumeJob(job);
        json(response, 202, view(job));
        pump();
        return;
      }
      if (request.method === 'GET' && match[2] === 'text') {
        if (!job.pdfReady || !job.copyTextReady)
          return json(response, 409, { error: 'Текст документа ещё не готов.' });
        const filename = path.join(job.directory, 'copy-text.txt');
        if ((await fs.stat(filename)).size > 20 * 1024 * 1024)
          return json(response, 413, { error: 'Текст документа слишком большой.' });
        return json(response, 200, { text: await fs.readFile(filename, 'utf8') });
      }
      if (request.method === 'GET' && ['pdf', 'zip'].includes(match[2])) {
        const isPDF = match[2] === 'pdf';
        if (!isPDF && !isDev) return json(response, 403, { error: 'Требуется вход в dev-режим.' });
        if (!(isPDF ? job.pdfReady : job.archiveReady))
          return json(response, 409, { error: 'Файл ещё не готов.' });
        const file = path.join(job.directory, isPDF ? 'result.pdf' : 'archive.zip');
        const stat = await fs.stat(file);
        const filename = displayText(
          (isPDF ? pdfFilename(job) : job.archiveFilename) ||
            (isPDF ? 'document.pdf' : 'document.zip'),
        );
        const encodedFilename = encodeURIComponent(filename).replace(
          /['()*]/g,
          (character) => '%' + character.charCodeAt(0).toString(16).toUpperCase(),
        );
        const preview = isPDF && url.searchParams.has('preview');
        response.writeHead(200, {
          'Content-Type': isPDF ? 'application/pdf' : 'application/zip',
          'Content-Length': stat.size,
          'Content-Disposition': `${preview ? 'inline' : 'attachment'}; filename="document.${isPDF ? 'pdf' : 'zip'}"; filename*=UTF-8''${encodedFilename}`,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        await pipeline(createReadStream(file), response);
        return;
      }
    }
    if (request.method === 'POST' && url.pathname === '/api/shutdown') {
      if (active) active.controller.abort();
      json(response, 200, { ok: true });
      setTimeout(() => server.close(() => process.exit(0)), 200).unref();
      setTimeout(() => process.exit(0), 3000).unref();
      return;
    }
    if (url.pathname === '/favicon.ico') {
      response.writeHead(204);
      return response.end();
    }
    json(response, 404, { error: 'Страница не найдена.' });
  } catch (error) {
    if (!response.headersSent) json(response, error.status || 400, { error: error.message });
    else response.destroy();
  }
});

async function main() {
  devAccess = await createDevAccess(DATA);
  captchaService = await createCaptchaService(DATA);
  await fs.mkdir(path.join(DATA, 'jobs'), { recursive: true });
  const ids = await fs.readdir(path.join(DATA, 'jobs'));
  for (const id of ids) {
    if (!/^[a-f\d-]{36}$/.test(id)) continue;
    try {
      const saved = JSON.parse(await fs.readFile(path.join(DATA, 'jobs', id, 'job.json'), 'utf8'));
      if (saved.id !== id) continue;
      const job = attachMethods(saved);
      if (
        job.stage === 'done' &&
        job.pdfReady &&
        (job.verification?.language?.status === 'failed' ||
          job.scriptVerification?.status === 'failed')
      ) {
        job.update({
          stage: 'error',
          pdfReady: false,
          message:
            'Предыдущий результат отклонён: язык документа не соответствует издателю. Выполните поиск повторно.',
          verification: {
            ...job.verification,
            language: {
              version: 2,
              status: 'failed',
              message: 'Проверка содержимого выявила другой язык документа.',
            },
          },
        });
      }
      if (!job.archiveReady && job.kind !== 'search') {
        let handle;
        try {
          handle = await fs.open(path.join(job.directory, 'archive.zip'), 'r');
          const stat = await handle.stat();
          const header = Buffer.alloc(4);
          await handle.read(header, 0, 4, 0);
          if (
            stat.size >= 4 &&
            stat.size <= 250 * 1024 * 1024 &&
            header[0] === 0x50 &&
            header[1] === 0x4b
          ) {
            job.update({
              archiveReady: true,
              archiveFilename: job.archiveFilename || cleanName(job.title) + '.zip',
            });
          }
        } catch {
          /* An interrupted upload may not have reached disk. */
        } finally {
          await handle?.close();
        }
      }
      if (!terminal.has(job.stage) && !['choosing', 'selecting', 'language'].includes(job.stage))
        job.update({
          stage: 'interrupted',
          pdfReady: false,
          message:
            'Работа прервана закрытием программы. Нажми «Продолжить», чтобы использовать сохранённые страницы.',
        });
      jobs.set(id, job);
    } catch {
      /* Ignore incomplete metadata files. */
    }
  }
  const sorted = [...jobs.entries()].sort((a, b) => a[1].createdAt.localeCompare(b[1].createdAt));
  jobs.clear();
  for (const [id, job] of sorted) jobs.set(id, job);
  await fs.mkdir(path.join(DATA, 'batches'), { recursive: true });
  for (const file of await fs.readdir(path.join(DATA, 'batches'))) {
    if (!/^[a-f\d-]{36}\.json$/.test(file)) continue;
    try {
      const batch = JSON.parse(await fs.readFile(path.join(DATA, 'batches', file), 'utf8'));
      if (
        batch.id + '.json' === file &&
        Array.isArray(batch.jobIds) &&
        batch.jobIds.every((id) => jobs.has(id))
      )
        batches.set(batch.id, batch);
    } catch {
      /* Ignore incomplete batch metadata. */
    }
  }
  const orderedBatches = [...batches.values()].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
  batches.clear();
  for (const batch of orderedBatches) batches.set(batch.id, batch);
  server.on('error', (error) => {
    console.error(
      error.code === 'EADDRINUSE'
        ? `Приложение уже запущено: http://127.0.0.1:${PORT}`
        : error.message,
    );
    process.exitCode = 1;
  });
  server.listen(PORT, '127.0.0.1', () => console.log(`DOC88_READY http://127.0.0.1:${PORT}`));
  process.on('SIGINT', () => {
    active?.controller.abort();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
