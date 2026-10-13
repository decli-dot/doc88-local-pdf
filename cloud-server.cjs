'use strict';
const http = require('node:http');
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { validateURL, validateRange, downloadArchive, convertArchive } = require('./pipeline.cjs');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const terminal = new Set(['done', 'error', 'cancelled']);

function createCloudServer(options = {}) {
  const port = Number(options.port || process.env.PORT || 10000);
  const origin = new URL(
    options.origin ||
      process.env.DOC88_PUBLIC_ORIGIN ||
      process.env.RENDER_EXTERNAL_URL ||
      `http://127.0.0.1:${port}`,
  ).origin;
  const data = path.resolve(
    options.data || process.env.DOC88_CLOUD_DATA || path.join(__dirname, '.data/cloud-jobs'),
  );
  const maxPages = Number(options.maxPages || process.env.DOC88_CLOUD_MAX_PAGES || 40);
  const ttl = Number(options.ttl || 15 * 60 * 1000);
  const timeout = Number(options.timeout || 10 * 60 * 1000);
  if (
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !Number.isSafeInteger(maxPages) ||
    maxPages < 1 ||
    maxPages > 100
  )
    throw new Error('Invalid cloud server configuration.');
  const jobs = new Map();
  const starts = [];
  let active = null;
  function session(request) {
    const value = request.headers.cookie
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('doc88_session='))
      ?.slice('doc88_session='.length);
    return UUID.test(value || '') ? value : null;
  }
  function ensureSession(request, response) {
    const id = session(request) || randomUUID();
    response.setHeader(
      'Set-Cookie',
      `doc88_session=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400${origin.startsWith('https:') ? '; Secure' : ''}`,
    );
    return id;
  }
  function snapshot(job) {
    return {
      id: job.id,
      stage: job.stage,
      message: job.message,
      title: job.title,
      current: job.current,
      total: job.total,
      createdAt: job.createdAt,
      finishedAt: job.finishedAt,
      pdfReady: Boolean(job.pdfReady),
      archiveReady: Boolean(job.archiveReady),
      pdfFilename: job.pdfFilename,
      archiveFilename: job.archiveFilename,
      bytes: job.bytes,
      textChars: job.textChars,
      blankPages: job.blankPages,
    };
  }
  function json(response, status, value) {
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(JSON.stringify(value));
  }
  async function body(request) {
    let size = 0;
    const chunks = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 10000) throw Object.assign(new Error('Запрос слишком большой.'), { status: 413 });
      chunks.push(chunk);
    }
    try {
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      return value;
    } catch {
      throw new Error('Не удалось прочитать запрос.');
    }
  }
  async function remove(job) {
    const absolute = path.resolve(job.directory);
    if (path.dirname(absolute) !== data || !UUID.test(path.basename(absolute)))
      throw new Error('Invalid cleanup path.');
    jobs.delete(job.id);
    await fs.rm(absolute, { recursive: true, force: true });
  }
  async function cleanup() {
    for (const job of jobs.values()) {
      if (terminal.has(job.stage) && Date.now() - Date.parse(job.finishedAt) > ttl && !job.readers)
        await remove(job);
    }
  }
  async function defaultRun(job) {
    await downloadArchive(job, job.directory, {
      headless: true,
      channel: 'chromium',
      rejectChallenges: true,
      viewport: { width: 1280, height: 900 },
      deviceScaleFactor: 1.5,
      maxPages,
    });
    await convertArchive(job);
  }
  async function run(job) {
    const timer = setTimeout(() => {
      job.timedOut = true;
      job.controller.abort();
    }, timeout);
    try {
      await (options.run || defaultRun)(job);
    } catch (error) {
      job.update({
        stage: job.controller.signal.aborted ? 'cancelled' : 'error',
        message: job.timedOut
          ? 'Сервер не успел обработать документ. Попробуй меньший диапазон страниц.'
          : job.controller.signal.aborted
            ? 'Обработка остановлена.'
            : error.message,
        finishedAt: new Date().toISOString(),
      });
      // A cancelled job cannot expose a partial ZIP/PDF.
      job.pdfReady = job.archiveReady = false;
    } finally {
      clearTimeout(timer);
      if (!job.finishedAt) job.finishedAt = new Date().toISOString();
      if (active === job) active = null;
    }
  }
  const staticFiles = new Map([
    ['/', ['cloud/index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['cloud/app.js', 'application/javascript; charset=utf-8']],
    ['/style.css', ['web/style.css', 'text/css; charset=utf-8']],
    ['/icon.svg', ['dist/icon.svg', 'image/svg+xml']],
  ]);
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, origin);
      if (request.method === 'GET' && url.pathname === '/healthz')
        return json(response, 200, { ok: true });
      if (request.headers.host !== new URL(origin).host)
        return json(response, 403, { error: 'Неверный адрес приложения.' });
      if (
        request.method === 'POST' &&
        (request.headers.origin !== origin || request.headers['x-doc88-request'] !== '1')
      )
        return json(response, 403, { error: 'Открой приложение на его странице.' });
      if (request.method === 'GET' && staticFiles.has(url.pathname)) {
        const [file, type] = staticFiles.get(url.pathname);
        if (url.pathname === '/') ensureSession(request, response);
        response.writeHead(200, {
          'Content-Type': type,
          'Cache-Control': 'no-cache',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'same-origin',
          'Content-Security-Policy':
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
        });
        return response.end(await fs.readFile(path.join(__dirname, file)));
      }
      if (request.method === 'GET' && url.pathname === '/api/config') {
        ensureSession(request, response);
        return json(response, 200, {
          maxPages,
          busy: Boolean(active),
          retentionMinutes: Math.round(ttl / 60000),
        });
      }
      const owner = session(request);
      if (request.method === 'POST' && url.pathname === '/api/jobs') {
        if (!owner)
          return json(response, 403, {
            error: 'Обнови страницу и разреши необходимые cookies для этого сайта.',
          });
        const input = await body(request);
        const docURL = validateURL(input.url);
        const range = validateRange(input.fromPage, input.toPage);
        if (range.toPage !== null && range.toPage - range.fromPage + 1 > maxPages)
          throw new Error(`Выбери не больше ${maxPages} страниц за один раз.`);
        if (active)
          return json(response, 409, {
            error: 'Сервер сейчас обрабатывает документ. Попробуй через минуту.',
          });
        const now = Date.now();
        while (starts[0] < now - 60 * 60 * 1000) starts.shift();
        if (starts.length >= 30)
          return json(response, 429, {
            error: 'Достигнут лимит обработок за час. Попробуй позже.',
          });
        const id = randomUUID();
        const job = {
          id,
          owner,
          directory: path.join(data, id),
          controller: new AbortController(),
          url: docURL,
          ...range,
          title: 'Документ',
          stage: 'queued',
          message: 'Готовим документ…',
          current: 0,
          total: 0,
          createdAt: new Date().toISOString(),
          readers: 0,
          update(value) {
            Object.assign(this, value);
          },
          log() {},
        };
        active = job;
        try {
          await fs.mkdir(job.directory, { recursive: true });
        } catch (error) {
          if (active === job) active = null;
          throw error;
        }
        jobs.set(id, job);
        starts.push(now);
        json(response, 202, snapshot(job));
        void run(job);
        return;
      }
      const match = url.pathname.match(/^\/api\/jobs\/([a-f0-9-]{36})(?:\/(pdf|zip|cancel))?$/);
      if (match) {
        const job = jobs.get(match[1]);
        // Existence and file URLs are private to the session that created the job.
        if (!job || job.owner !== owner)
          return json(response, 404, { error: 'Документ не найден или срок хранения истёк.' });
        if (terminal.has(job.stage) && Date.now() - Date.parse(job.finishedAt) > ttl) {
          if (!job.readers) await remove(job);
          return json(response, 404, {
            error: 'Срок хранения документа истёк. Вставь ссылку снова.',
          });
        }
        if (request.method === 'GET' && !match[2]) return json(response, 200, snapshot(job));
        if (request.method === 'POST' && match[2] === 'cancel') {
          if (!terminal.has(job.stage)) job.controller.abort();
          return json(response, 200, { ok: true });
        }
        if (request.method === 'GET' && ['pdf', 'zip'].includes(match[2])) {
          const isPDF = match[2] === 'pdf';
          if (job.stage !== 'done' || !(isPDF ? job.pdfReady : job.archiveReady))
            return json(response, 409, { error: 'Файл ещё не готов.' });
          const file = path.join(job.directory, isPDF ? 'result.pdf' : 'archive.zip');
          job.readers++;
          try {
            const stat = await fs.stat(file);
            response.writeHead(200, {
              'Content-Type': isPDF ? 'application/pdf' : 'application/zip',
              'Content-Length': stat.size,
              'Content-Disposition': `attachment; filename="document.${isPDF ? 'pdf' : 'zip'}"; filename*=UTF-8''${encodeURIComponent(isPDF ? job.pdfFilename : job.archiveFilename)}`,
              'Cache-Control': 'no-store',
              'X-Content-Type-Options': 'nosniff',
            });
            await pipeline(createReadStream(file), response);
          } finally {
            job.readers--;
          }
          return;
        }
      }
      json(response, 404, { error: 'Страница не найдена.' });
    } catch (error) {
      if (!response.headersSent) json(response, error.status || 400, { error: error.message });
      else response.destroy();
    }
  });
  const sweeper = setInterval(() => {
    void cleanup().catch((error) => console.error('Cleanup:', error.message));
  }, 30000);
  sweeper.unref();
  server.on('close', () => {
    clearInterval(sweeper);
    active?.controller.abort();
  });
  return { server, cleanup, jobs, port, origin };
}
if (require.main === module) {
  const app = createCloudServer();
  app.server.listen(app.port, process.env.DOC88_CLOUD_HOST || '0.0.0.0', () =>
    console.log(`DOC88_CLOUD_READY ${app.origin}`),
  );
  const stop = () => {
    app.server.close();
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
module.exports = { createCloudServer };
