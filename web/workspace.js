'use strict';
const fs = require('./store.js');
const { command, installed, catalogueContext, events } = require('./transport.js');
const {
  validateURL,
  validateRange,
  downloadArchive,
  convertArchive,
  challengeFrame,
  challengeInput,
} = require('./pipeline.js');
const { runSearchJob, validateQuery, searchDocuments } = require('../search.cjs');
const { reference, resolveISOStandard } = require('../iso-catalog.cjs');
const { validateBatch, summarizeBatch } = require('../batch.cjs');
const terminal = new Set(['done', 'error', 'cancelled', 'interrupted']);
const jobs = new Map(),
  batches = new Map(),
  pending = [],
  urls = new Map();
let active = null,
  storageError = null,
  ownership = false,
  stopped = false;
const json = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
function snapshot(job) {
  const { controller, directory, update, log, writing, ...value } = job;
  return {
    ...value,
    canResume:
      ['error', 'cancelled', 'interrupted'].includes(job.stage) &&
      Boolean(job.kind === 'search' || job.url || job.archiveReady),
  };
}
function persist(job) {
  const data = JSON.stringify(snapshot(job));
  job.writing = (job.writing || Promise.resolve())
    .then(() => fs.writeFile(job.directory + '/job.json', data))
    .catch((error) => {
      storageError =
        'Не удалось сохранить данные в браузере. Проверь свободное место и разрешения хранилища. ' +
        error.message;
      job.controller.abort();
    });
}
function attach(value) {
  const job = {
    ...value,
    directory: '/data/jobs/' + value.id,
    controller: new AbortController(),
    challengeAvailable: false,
  };
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
function newJob(input, queued = false) {
  if (!ownership)
    throw Error(
      'Программа уже открыта в другой вкладке. Продолжи работу там или закрой её и обнови эту страницу.',
    );
  if (!queued && (active || pending.length))
    throw Error('Сначала дождись текущей обработки или останови её.');
  if (input.enhanceImages !== undefined && typeof input.enhanceImages !== 'boolean')
    throw Error('Некорректная настройка подготовки изображений.');
  const job = attach({
    id: crypto.randomUUID(),
    stage: 'queued',
    title: input.title || 'Документ',
    createdAt: new Date().toISOString(),
    message: 'В очереди…',
    current: 0,
    total: 0,
    archiveReady: false,
    pdfReady: false,
    logs: [],
    ...input,
    enhanceImages: input.enhanceImages !== false,
  });
  jobs.set(job.id, job);
  persist(job);
  return job;
}
async function lookup(wanted, options = {}) {
  return resolveISOStandard(wanted, {
    ...options,
    dataDirectory: '/data',
    launchContext: catalogueContext,
  });
}
async function run(job) {
  const resume = Boolean(job.resumeRequested);
  job.update({ resumeRequested: false });
  try {
    if (job.kind === 'search')
      await runSearchJob(job, '/data', {
        resume,
        resolveISO: lookup,
        lookupISO: lookup,
        download: downloadArchive,
        convert: convertArchive,
        search: async (query, signal) => {
          await installed();
          signal.throwIfAborted();
          return searchDocuments(
            query,
            signal,
            async () =>
              new Response(
                (await globalThis.Doc88OCR.abortable(command('SEARCH', { query }), signal)).html,
              ),
          );
        },
        ...(job.searchCandidates ? { candidates: job.searchCandidates } : {}),
      });
    else {
      if (job.url) await downloadArchive(job);
      await convertArchive(job);
    }
  } catch (error) {
    job.update({
      stage: job.controller.signal.aborted ? 'cancelled' : 'error',
      message: job.controller.signal.aborted
        ? 'Обработка остановлена. Сохранённые страницы можно продолжить.'
        : error.message,
      pdfReady: false,
      finishedAt: new Date().toISOString(),
    });
  } finally {
    if (active === job) active = null;
    job.update({ challengeAvailable: false });
    pump();
  }
}
function pump() {
  if (active || !ownership) return;
  while (pending.length) {
    const job = pending.shift();
    if (job.stage !== 'queued') continue;
    active = job;
    void run(job);
    return;
  }
}
function queue(job) {
  pending.push(job);
  pump();
  return snapshot(job);
}
function cancel(job) {
  if (terminal.has(job.stage)) return;
  job.controller.abort();
  if (active !== job)
    job.update({
      stage: 'cancelled',
      message: 'Обработка остановлена.',
      finishedAt: new Date().toISOString(),
    });
}
function resume(job) {
  if (!snapshot(job).canResume) throw Error('Этот документ сейчас нельзя продолжить.');
  job.controller = new AbortController();
  if (job.kind === 'search' && job.isoChoices?.length && !job.resolvedQuery)
    job.update({ stage: 'choosing', finishedAt: null });
  else {
    job.update({
      stage: 'queued',
      resumeRequested: true,
      pdfReady: false,
      finishedAt: null,
      message: 'Продолжаем с сохранённого места…',
    });
    pending.push(job);
  }
}
async function file(apiPath) {
  const match = apiPath.split('?')[0].match(/^\/api\/(jobs|batches)\/([a-f\d-]{36})\/(pdf|zip)$/);
  if (!match) throw Error('Файл не найден.');
  if (match[1] === 'batches') {
    const batch = batches.get(match[2]);
    if (!batch) throw Error('Список не найден.');
    const zip = new globalThis.JSZip(),
      used = new Set(),
      report = ['Doc88 PDF', `Создано: ${batch.createdAt}`, ''];
    let ready = 0;
    for (const id of batch.jobIds) {
      const job = jobs.get(id);
      if (!job) continue;
      const labels = {
        done: 'Готово',
        error: 'Ошибка',
        cancelled: 'Остановлено',
        interrupted: 'Прервано',
        choosing: 'Нужен выбор издания',
        queued: 'В очереди',
      };
      report.push(`${job.query}: ${labels[job.stage] || 'Обрабатывается'}`, job.message || '', '');
      if (job.stage !== 'done' || !job.pdfReady) continue;
      const original = (job.pdfFilename || 'document.pdf').replace(/[\\/]/g, '_');
      let name = original,
        number = 2;
      while (used.has(name.toLowerCase())) name = original.replace(/\.pdf$/i, ` (${number++}).pdf`);
      used.add(name.toLowerCase());
      zip.file(name, await fs.readFile(job.directory + '/result.pdf'));
      ready++;
    }
    if (!ready) throw Error('Готовых PDF пока нет.');
    zip.file('Отчёт.txt', report.join('\r\n'));
    return {
      bytes: await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }),
      type: 'application/zip',
      name: 'Doc88_PDF.zip',
    };
  }
  const job = jobs.get(match[2]),
    pdf = match[3] === 'pdf';
  if (!job || (pdf ? !job.pdfReady || job.stage !== 'done' : !job.archiveReady))
    throw Error('Файл пока не готов.');
  return {
    bytes: await fs.readFile(job.directory + (pdf ? '/result.pdf' : '/archive.zip')),
    type: pdf ? 'application/pdf' : 'application/zip',
    name: (pdf ? job.pdfFilename : job.archiveFilename) || (pdf ? 'document.pdf' : 'document.zip'),
  };
}
function link(apiPath) {
  return location.pathname + '?export=' + encodeURIComponent(apiPath);
}
document.addEventListener('click', (event) => {
  const anchor = event.target.closest('a[href]');
  if (!anchor) return;
  const url = new URL(anchor.href, location.href),
    apiPath = url.searchParams.get('export');
  if (url.origin !== location.origin || url.pathname !== location.pathname || !apiPath) return;
  event.preventDefault();
  const preview = apiPath.includes('preview=1'),
    target = preview ? window.open('about:blank', '_blank') : null;
  if (target) target.opener = null;
  void file(apiPath)
    .then((value) => {
      const key = apiPath.split('?')[0];
      if (urls.has(key)) URL.revokeObjectURL(urls.get(key));
      const href = URL.createObjectURL(new Blob([value.bytes], { type: value.type }));
      urls.set(key, href);
      if (target)
        target.location.href = href + (apiPath.includes('#') ? '#' + apiPath.split('#')[1] : '');
      else {
        const download = document.createElement('a');
        download.href = href;
        download.download = value.name;
        download.click();
      }
    })
    .catch((error) => {
      target?.close();
      document.getElementById('form-error').textContent = error.message;
      document.getElementById('form-error').hidden = false;
    });
});
const ready = (async () => {
  const lockReady = new Promise((resolve) => {
    if (!navigator.locks) {
      resolve();
      return;
    }
    void navigator.locks.request('doc88-browser-worker', { ifAvailable: true }, async (lock) => {
      ownership = Boolean(lock);
      resolve();
      if (lock) await new Promise(() => {});
    });
  });
  await lockReady;
  for (const key of await fs.keys()) {
    try {
      if (/^\/data\/jobs\/[a-f\d-]{36}\/job.json$/.test(key)) {
        const job = attach(JSON.parse(await fs.readFile(key, 'utf8')));
        if (!terminal.has(job.stage) && job.stage !== 'choosing')
          Object.assign(job, {
            stage: 'interrupted',
            message: 'Вкладка была закрыта. Продолжи с сохранённого места.',
            pdfReady: false,
          });
        jobs.set(job.id, job);
        if (ownership) persist(job);
      } else if (/^\/data\/batches\/[a-f\d-]{36}\.json$/.test(key)) {
        const batch = JSON.parse(await fs.readFile(key, 'utf8'));
        batches.set(batch.id, batch);
      }
    } catch {
      /* Damaged metadata never exposes a partial PDF. */
    }
  }
  const setup = document.getElementById('browser-setup'),
    status = document.getElementById('browser-connection');
  try {
    await installed();
    if (ownership && !location.hash.startsWith('#job=')) await command('RESET_CAPTURE');
    status.textContent = ownership
      ? 'Расширение готово · всё работает в браузере'
      : 'Программа уже открыта в другой вкладке. Продолжи работу там или закрой её и обнови эту страницу.';
    setup.open = false;
  } catch (error) {
    status.textContent = error.message;
    setup.open = true;
  }
  const id = location.hash.match(/^#job=([a-f\d-]{36})$/)?.[1];
  if (id && ownership) {
    try {
      const captured = await command('GET_CAPTURE', { id });
      const job = newJob({
        url: validateURL(captured.url),
        fromPage: captured.fromPage || 1,
        toPage: captured.toPage || null,
        externalCaptureId: id,
      });
      localStorage.setItem('doc88-selected', job.id);
      queue(job);
      history.replaceState(null, '', location.pathname);
    } catch (error) {
      status.textContent = error.message;
    }
  }
})();
async function fetchAPI(url, options = {}) {
  try {
    await ready;
    if (storageError) throw Error(storageError);
    const pathname = new URL(url, location.origin).pathname,
      method = options.method || 'GET';
    if (stopped && method !== 'GET')
      throw Error('Работа остановлена. Обнови страницу, чтобы продолжить.');
    const input = typeof options.body === 'string' ? JSON.parse(options.body) : {};
    if (pathname === '/api/status')
      return json({
        app: 'doc88-local-pdf',
        ocr: 'ready',
        activeId: active?.id || null,
        jobs: [...jobs.values()].slice(-20).reverse().map(snapshot),
        batches: [...batches.values()]
          .slice(-10)
          .reverse()
          .map((batch) => summarizeBatch(batch, jobs, snapshot)),
      });
    if (method !== 'GET' && !ownership)
      throw Error('Работа уже идёт в другой вкладке. Закрой её и обнови эту страницу.');
    if (pathname === '/api/search' && method === 'POST') {
      await installed();
      const query = validateQuery(input.query);
      let extras = {};
      if (input.candidateURL) {
        const previous = jobs.get(input.sourceJobId),
          candidate = previous?.searchResults?.find(
            (item) => item.url === validateURL(input.candidateURL),
          );
        if (!candidate || validateQuery(previous.query) !== query)
          throw Error('Вариант не найден в сохранённом поиске.');
        extras = {
          searchCandidates: [{ ...candidate, status: 'unverified', checks: null }],
          resolvedQuery: previous.resolvedQuery,
          isoEdition: previous.isoEdition,
        };
      }
      return json(
        queue(
          newJob({
            kind: 'search',
            query,
            title: query,
            enhanceImages: input.enhanceImages,
            ...extras,
          }),
        ),
        202,
      );
    }
    if (pathname === '/api/jobs' && method === 'POST') {
      await installed();
      return json(
        queue(
          newJob({
            url: validateURL(input.url),
            ...validateRange(input.fromPage, input.toPage),
            enhanceImages: input.enhanceImages,
          }),
        ),
        202,
      );
    }
    if (pathname === '/api/upload' && method === 'POST') {
      const headers = new Headers(options.headers),
        blob = options.body;
      if (!blob || blob.size > 250 * 1024 * 1024) throw Error('Выбери ZIP размером до 250 МБ.');
      const job = newJob({
        title: globalThis.Doc88OCR.cleanName(
          decodeURIComponent(headers.get('x-filename') || 'document.zip').replace(/\.zip$/i, ''),
        ),
        enhanceImages: headers.get('x-doc88-enhance') !== '0',
      });
      active = job;
      try {
        await fs.writeFile(
          job.directory + '/archive.zip',
          new Uint8Array(await blob.arrayBuffer()),
        );
        job.update({ archiveReady: true, archiveFilename: job.title + '.zip' });
      } catch (error) {
        job.update({ stage: 'error', message: error.message });
        throw error;
      } finally {
        active = null;
      }
      return json(queue(job), 202);
    }
    if (pathname === '/api/batches' && method === 'POST') {
      await installed();
      const queries = validateBatch(input.queries);
      if (pending.length + queries.length > 100)
        throw Error('Сначала дождись освобождения очереди.');
      const batch = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), jobIds: [] },
        created = queries.map((query) =>
          newJob(
            {
              kind: 'search',
              query,
              title: query,
              batchId: batch.id,
              enhanceImages: input.enhanceImages,
            },
            true,
          ),
        );
      batch.jobIds = created.map((job) => job.id);
      await Promise.all(created.map((job) => job.writing));
      await fs.writeFile('/data/batches/' + batch.id + '.json', JSON.stringify(batch));
      batches.set(batch.id, batch);
      pending.push(...created);
      pump();
      return json(summarizeBatch(batch, jobs, snapshot), 202);
    }
    const batchMatch = pathname.match(/^\/api\/batches\/([a-f\d-]{36})(?:\/(cancel|resume))?$/);
    if (batchMatch) {
      const batch = batches.get(batchMatch[1]);
      if (!batch) throw Error('Список не найден.');
      if (method === 'POST') {
        for (const id of batch.jobIds) {
          const job = jobs.get(id);
          if (batchMatch[2] === 'cancel') cancel(job);
          else if (snapshot(job).canResume) resume(job);
        }
        pump();
      }
      return json(summarizeBatch(batch, jobs, snapshot));
    }
    const match = pathname.match(
      /^\/api\/jobs\/([a-f\d-]{36})(?:\/(cancel|resume|edition|challenge\/(?:frame|input)))?$/,
    );
    if (match) {
      const job = jobs.get(match[1]);
      if (!job) throw Error('Документ не найден.');
      if (match[2] === 'challenge/frame') return json(await challengeFrame());
      if (match[2] === 'challenge/input') {
        if (active?.id !== job.id) throw Error('Проверка не относится к активному документу.');
        return json(await challengeInput(input));
      }
      if (method === 'POST' && match[2] === 'cancel') cancel(job);
      else if (method === 'POST' && match[2] === 'resume') {
        resume(job);
        pump();
      } else if (method === 'POST' && match[2] === 'edition') {
        const edition = job.isoChoices?.find(
          (value) =>
            value.reference === input.reference && /^(Published|Withdrawn)$/.test(value.status),
        );
        if (job.stage !== 'choosing' || !edition)
          throw Error('Выбери издание из сохранённого списка ISO.');
        job.controller = new AbortController();
        job.update({
          resolvedQuery: edition.reference,
          isoEdition: edition,
          title: edition.reference,
          stage: 'queued',
          searchResults: [],
          searchCandidates: null,
          namingWarning: null,
        });
        queue(job);
      }
      return json(snapshot(job));
    }
    if (pathname === '/api/shutdown' && method === 'POST') {
      stopped = true;
      for (const job of jobs.values()) cancel(job);
      return json({ ok: true });
    }
    throw Error('Неизвестное действие.');
  } catch (error) {
    return json({ error: error.message }, 400);
  }
}
window.Doc88Browser = { fetch: fetchAPI, link };
events(async (message) => {
  if (message.type === 'CATALOGUE_WAIT') {
    if (active && !active.controller.signal.aborted)
      active.update({ stage: 'resolving', message: message.message });
    return;
  }
  if (message.type !== 'IMPORT_URL') return;
  const response = await fetchAPI('/api/jobs', {
    method: 'POST',
    body: JSON.stringify({
      url: message.url,
      enhanceImages: document.getElementById('enhance-images').checked,
    }),
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error);
  localStorage.setItem('doc88-selected', result.id);
  window.dispatchEvent(new CustomEvent('doc88-import', { detail: { id: result.id } }));
});
