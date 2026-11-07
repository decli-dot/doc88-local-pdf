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
const { validateBatch, summarizeBatch, batchZip } = require('./batch.cjs');
const { atomicWrite } = require('./checkpoints.cjs');

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

function enhanceSetting(value) {
  if (value === undefined) return true;
  if (typeof value !== 'boolean')
    throw Error('Настройка улучшения страниц должна быть включена или выключена.');
  return value;
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
  job.update({ resumeRequested: false });
  const downloadOptions = {
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
    if (job.kind === 'search')
      await runSearchJob(job, DATA, {
        downloadOptions,
        resume,
        ...(job.searchCandidates ? { candidates: job.searchCandidates } : {}),
      });
    else {
      if (needsDownload) await downloadArchive(job, DATA, downloadOptions);
      await convertArchive(job);
    }
  } catch (error) {
    const cancelled = job.controller.signal.aborted;
    job.update({
      stage: cancelled ? 'cancelled' : 'error',
      message: cancelled ? 'Обработка остановлена.' : error.message,
      finishedAt: new Date().toISOString(),
    });
    console.error('Job', job.id, cancelled ? 'cancelled' : error.message);
  } finally {
    browserViews.delete(job.id);
    if (job.challengeAvailable) job.update({ challengeAvailable: false });
    if (active === job) active = null;
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
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/query.js', ['query.js', 'text/javascript; charset=utf-8']],
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
        ocr: nativeAvailable ? 'ready' : 'download-on-first-use',
        activeId: active?.id || null,
        jobs: [...jobs.values()].slice(-10).reverse().map(snapshot),
        batches: [...batches.values()]
          .slice(-5)
          .reverse()
          .map((batch) => summarizeBatch(batch, jobs, snapshot)),
      });
    if (request.method === 'POST' && url.pathname === '/api/batches') {
      const input = JSON.parse((await readBody(request, 20000)).toString('utf8'));
      const queries = validateBatch(input.queries);
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
              query,
              title: query,
              batchId: batch.id,
              enhanceImages: enhanceSetting(input.enhanceImages),
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
        json(response, 202, summarizeBatch(batch, jobs, snapshot));
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
      if (request.method === 'GET' && !batchMatch[2])
        return json(response, 200, summarizeBatch(batch, jobs, snapshot));
      if (request.method === 'GET' && batchMatch[2] === 'zip') {
        if (!summarizeBatch(batch, jobs, snapshot).ready)
          return json(response, 409, { error: 'Готовых PDF пока нет.' });
        response.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': 'attachment; filename="Doc88_PDF.zip"',
          'Cache-Control': 'no-store',
        });
        await pipeline(batchZip(batch, jobs), response);
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
        return json(response, 200, summarizeBatch(batch, jobs, snapshot));
      }
    }
    if (request.method === 'POST' && url.pathname === '/api/jobs') {
      const input = JSON.parse((await readBody(request, 10000)).toString('utf8'));
      const docURL = validateURL(input.url);
      const range = validateRange(input.fromPage, input.toPage);
      const job = await newJob({
        url: docURL,
        ...range,
        enhanceImages: enhanceSetting(input.enhanceImages),
      });
      json(response, 202, snapshot(job));
      void runJob(job, true);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/search') {
      const input = JSON.parse((await readBody(request, 10000)).toString('utf8'));
      const query = validateQuery(input?.query);
      let searchCandidates;
      let isoMetadata;
      if (input.candidateURL) {
        const previous = jobs.get(input.sourceJobId);
        const candidateURL = validateURL(input.candidateURL);
        const candidate =
          previous?.kind === 'search' && validateQuery(previous.query) === query
            ? previous.searchResults?.find((item) => item.url === candidateURL)
            : null;
        if (!candidate)
          throw new Error('Вариант не найден в результатах поиска. Запусти поиск снова.');
        searchCandidates = [{ ...candidate, status: 'unverified', checks: null, error: undefined }];
        isoMetadata = {
          resolvedQuery: previous.resolvedQuery,
          isoEdition: previous.isoEdition,
          isoLookupURL: previous.isoLookupURL,
        };
      }
      const job = await newJob({
        kind: 'search',
        query,
        title: query,
        enhanceImages: enhanceSetting(input.enhanceImages),
        ...(searchCandidates ? { searchCandidates } : {}),
        ...isoMetadata,
      });
      json(response, 202, snapshot(job));
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
        enhanceImages: enhanceHeader !== '0',
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
      json(response, 202, snapshot(job));
      void runJob(job, false);
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
          item.reference === input?.reference && /^(Published|Withdrawn)$/.test(item.status),
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
        isoEdition: edition,
        title: edition.reference,
        searchResults: [],
        searchCandidates: null,
        namingWarning: null,
        message: `Выбрано ${edition.reference}. Готовим поиск…`,
      });
      json(response, 202, snapshot(job));
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
    const match = url.pathname.match(/^\/api\/jobs\/([a-f\d-]{36})(?:\/(cancel|resume|pdf|zip))?$/);
    if (match) {
      const job = jobs.get(match[1]);
      if (!job) return json(response, 404, { error: 'Документ не найден.' });
      if (request.method === 'GET' && !match[2]) return json(response, 200, snapshot(job));
      if (request.method === 'POST' && match[2] === 'cancel') {
        cancelJob(job);
        return json(response, 200, { ok: true });
      }
      if (request.method === 'POST' && match[2] === 'resume') {
        resumeJob(job);
        json(response, 202, snapshot(job));
        pump();
        return;
      }
      if (request.method === 'GET' && ['pdf', 'zip'].includes(match[2])) {
        const isPDF = match[2] === 'pdf';
        if (!(isPDF ? job.pdfReady : job.archiveReady))
          return json(response, 409, { error: 'Файл ещё не готов.' });
        const file = path.join(job.directory, isPDF ? 'result.pdf' : 'archive.zip');
        const stat = await fs.stat(file);
        const filename = isPDF ? job.pdfFilename : job.archiveFilename;
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
  await fs.mkdir(path.join(DATA, 'jobs'), { recursive: true });
  const ids = await fs.readdir(path.join(DATA, 'jobs'));
  for (const id of ids) {
    if (!/^[a-f\d-]{36}$/.test(id)) continue;
    try {
      const saved = JSON.parse(await fs.readFile(path.join(DATA, 'jobs', id, 'job.json'), 'utf8'));
      if (saved.id !== id) continue;
      const job = attachMethods(saved);
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
      if (!terminal.has(job.stage) && job.stage !== 'choosing')
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
