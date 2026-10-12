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

const PORT = Number(process.env.DOC88_PORT || 8968);
if (!Number.isSafeInteger(PORT) || PORT < 1 || PORT > 65535)
  throw new Error('DOC88_PORT должен быть целым числом от 1 до 65535.');
const DATA = path.resolve(process.env.DOC88_DATA_DIR || path.join(__dirname, '.data'));
const jobs = new Map();
let active = null;
const terminal = new Set(['done', 'error', 'cancelled']);
const origins = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);

function snapshot(job) {
  const { controller, directory, browser, update, log, writing, cacheDirectory, ...publicData } =
    job;
  return publicData;
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

async function newJob(input) {
  if (active)
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
    ...input,
  });
  // Claim the slot before the first await so simultaneous requests cannot both run.
  active = job;
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
  try {
    if (needsDownload) await downloadArchive(job, DATA);
    await convertArchive(job);
  } catch (error) {
    const cancelled = job.controller.signal.aborted;
    job.update({
      stage: cancelled ? 'cancelled' : 'error',
      message: cancelled ? 'Обработка остановлена.' : error.message,
      finishedAt: new Date().toISOString(),
    });
    console.error('Job', job.id, cancelled ? 'cancelled' : error.message);
  } finally {
    if (active === job) active = null;
  }
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
      });
    if (request.method === 'POST' && url.pathname === '/api/jobs') {
      const input = JSON.parse((await readBody(request, 10000)).toString('utf8'));
      const docURL = validateURL(input.url);
      const range = validateRange(input.fromPage, input.toPage);
      const job = await newJob({ url: docURL, ...range });
      json(response, 202, snapshot(job));
      void runJob(job, true);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/upload') {
      if (active)
        return json(response, 409, { error: 'Сначала дождись текущей обработки или останови её.' });
      const archive = await readBody(request, 250 * 1024 * 1024);
      if (archive.length < 4 || archive[0] !== 0x50 || archive[1] !== 0x4b)
        return json(response, 400, { error: 'Выбери ZIP-архив с изображениями страниц.' });
      const uploadedName = cleanName(
        decodeURIComponent(request.headers['x-filename'] || 'document.zip'),
      );
      const job = await newJob({ title: uploadedName.replace(/\.zip$/i, ''), url: null });
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
    const match = url.pathname.match(/^\/api\/jobs\/([a-f\d-]{36})(?:\/(cancel|pdf|zip))?$/);
    if (match) {
      const job = jobs.get(match[1]);
      if (!job) return json(response, 404, { error: 'Документ не найден.' });
      if (request.method === 'GET' && !match[2]) return json(response, 200, snapshot(job));
      if (request.method === 'POST' && match[2] === 'cancel') {
        if (!terminal.has(job.stage)) job.controller.abort();
        return json(response, 200, { ok: true });
      }
      if (request.method === 'GET' && ['pdf', 'zip'].includes(match[2])) {
        const isPDF = match[2] === 'pdf';
        if (!(isPDF ? job.pdfReady : job.archiveReady))
          return json(response, 409, { error: 'Файл ещё не готов.' });
        const file = path.join(job.directory, isPDF ? 'result.pdf' : 'archive.zip');
        const stat = await fs.stat(file);
        const filename = isPDF ? job.pdfFilename : job.archiveFilename;
        const preview = isPDF && url.searchParams.has('preview');
        response.writeHead(200, {
          'Content-Type': isPDF ? 'application/pdf' : 'application/zip',
          'Content-Length': stat.size,
          'Content-Disposition': `${preview ? 'inline' : 'attachment'}; filename="document.${isPDF ? 'pdf' : 'zip'}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
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
      if (!terminal.has(job.stage))
        job.update({
          stage: 'error',
          message: 'Приложение было закрыто во время обработки. Запусти документ повторно.',
        });
      jobs.set(id, job);
    } catch {
      /* Ignore incomplete metadata files. */
    }
  }
  const sorted = [...jobs.entries()].sort((a, b) => a[1].createdAt.localeCompare(b[1].createdAt));
  jobs.clear();
  for (const [id, job] of sorted) jobs.set(id, job);
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
