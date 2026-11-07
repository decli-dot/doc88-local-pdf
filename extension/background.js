'use strict';
if (typeof importScripts === 'function') importScripts('services.js');
const SITE = chrome.runtime.getManifest().homepage_url;
const MAX_PAGES = 500;
const MAX_BYTES = 250 * 1024 * 1024;

function docURL(value) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    !['doc88.com', 'www.doc88.com'].includes(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    !/^\/p-\d+\.html$/.test(url.pathname)
  )
    throw new Error('Нужна ссылка на документ Doc88 вида https://www.doc88.com/p-123.html');
  return url.origin + url.pathname;
}
function isSite(value) {
  try {
    const url = new URL(value);
    return url.origin === new URL(SITE).origin && url.pathname.startsWith(new URL(SITE).pathname);
  } catch {
    return false;
  }
}
async function getJob() {
  return (await chrome.storage.session.get('job')).job;
}
async function saveJob(job) {
  await chrome.storage.session.set({ job });
}
async function notify(tabId, message) {
  return chrome.tabs.sendMessage(tabId, { channel: 'DOC88_PDF', ...message });
}
async function endJob(job, error) {
  if (!job || (await getJob())?.id !== job.id) return;
  await chrome.storage.session.remove('job');
  if (typeof releaseChallenge === 'function') await releaseChallenge(job);
  await Promise.allSettled([
    notify(job.sourceTab, { type: 'STOP_CAPTURE', id: job.id, error }),
    notify(job.targetTab, { type: error ? 'ERROR' : 'CANCELLED', id: job.id, message: error }),
  ]);
  if (job.protocol === 2 && job.createdSource)
    await chrome.tabs.remove(job.sourceTab).catch(() => {});
}
let starting = false;
async function startJob(url, sourceTab, targetTab, options = {}) {
  if (starting)
    throw new Error('Уже обрабатываем документ. Дождись результата или останови обработку.');
  starting = true;
  const createdTabs = [];
  try {
    if (await getJob())
      throw new Error('Уже обрабатываем документ. Дождись результата или останови обработку.');
    url = docURL(url);
    const id = crypto.randomUUID();
    if (targetTab == null) {
      const tab = await chrome.tabs.create({ url: SITE + '#job=' + id, active: false });
      targetTab = tab.id;
      createdTabs.push(tab.id);
    }
    if (sourceTab == null) {
      const tab = await chrome.tabs.create({ url, active: options.protocol !== 2 });
      sourceTab = tab.id;
      createdTabs.push(tab.id);
    }
    const fromPage = options.fromPage || 1,
      toPage = options.toPage || null;
    if (
      !Number.isSafeInteger(fromPage) ||
      fromPage < 1 ||
      (toPage != null && (!Number.isSafeInteger(toPage) || toPage < fromPage)) ||
      !Array.isArray(options.skip || []) ||
      (options.skip || []).some(
        (index) => !Number.isSafeInteger(index) || index < 0 || index >= MAX_PAGES,
      )
    )
      throw Error('Некорректный диапазон или сохранённые страницы.');
    await saveJob({
      id,
      url,
      sourceTab,
      targetTab,
      phase: 'waiting',
      received: 0,
      bytes: 0,
      protocol: options.protocol === 2 ? 2 : 1,
      fromPage,
      toPage,
      skip: options.skip || [],
      createdSource: createdTabs.includes(sourceTab),
    });
    return { id };
  } catch (error) {
    // Only close tabs created by this unsuccessful request.
    await Promise.allSettled(createdTabs.map((id) => chrome.tabs.remove(id)));
    throw error;
  } finally {
    starting = false;
  }
}
async function beginCapture(job) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    if ((await getJob())?.id !== job.id) return;
    try {
      await notify(job.sourceTab, {
        type: 'CAPTURE',
        id: job.id,
        fromPage: job.fromPage,
        toPage: job.toPage,
        skip: job.skip,
      });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  await endJob(job, 'Doc88 не загрузился. Проверь вкладку документа и повтори попытку.');
}
async function handle(message, sender) {
  if (message?.channel !== 'DOC88_PDF' || sender.frameId !== 0)
    throw new Error('Неизвестный запрос.');
  if (message.type === 'PING' && isSite(sender.url))
    return { version: chrome.runtime.getManifest().version };
  if (message.type === 'START_DOC88') {
    if (chrome.tabs.query) {
      const existing = (await chrome.tabs.query({ url: SITE + '*' })).find(
        (tab) => tab.id !== sender.tab.id,
      );
      if (existing) {
        const imported = await notify(existing.id, {
          type: 'IMPORT_URL',
          id: crypto.randomUUID(),
          index: -1,
          url: docURL(sender.url),
          ack: true,
        });
        if (imported?.error) throw Error(imported.error);
        await chrome.tabs.update(existing.id, { active: true });
        return { queued: true };
      }
    }
    return startJob(docURL(sender.url), sender.tab.id, null, { protocol: 2 });
  }
  if (message.type === 'START_URL' && isSite(sender.url))
    return startJob(message.url, null, sender.tab.id, message);
  const job = await getJob();
  if (message.type === 'RESET_CAPTURE' && isSite(sender.url)) {
    if (job?.targetTab === sender.tab.id) await endJob(job);
    return { ok: true };
  }
  if (!job || job.id !== message.id) throw new Error('Обработка уже завершена.');
  const target = sender.tab?.id === job.targetTab && isSite(sender.url);
  const source = sender.tab?.id === job.sourceTab && docURL(sender.url) === job.url;
  if (message.type === 'GET_CAPTURE' && target)
    return { url: job.url, fromPage: job.fromPage, toPage: job.toPage };
  if (message.type === 'READY' && target) {
    if (job.phase !== 'waiting')
      throw new Error('Страница обработки была перезагружена. Запусти документ заново.');
    job.phase = 'capturing';
    await saveJob(job);
    void beginCapture(job).catch((error) => enqueue(() => endJob(job, error.message)));
    return { ok: true };
  }
  if (message.type === 'CANCEL' && (target || source)) {
    await endJob(job);
    return { ok: true };
  }
  if (message.type === 'FINISH' && target && job.phase === 'ocr') {
    await chrome.storage.session.remove('job');
    await notify(job.sourceTab, { type: 'STOP_CAPTURE', id: job.id }).catch(() => {});
    if (typeof releaseChallenge === 'function') await releaseChallenge(job);
    if (job.protocol === 2 && job.createdSource)
      await chrome.tabs.remove(job.sourceTab).catch(() => {});
    return { ok: true };
  }
  if (!source || job.phase !== 'capturing')
    throw new Error('Запрос не относится к текущему документу.');
  if (message.type === 'CAPTURE_PROGRESS') {
    job.challenge = Boolean(message.challenge);
    await saveJob(job);
    if (!job.challenge && typeof releaseChallenge === 'function') await releaseChallenge(job);
    await notify(job.targetTab, {
      type: 'PROGRESS',
      id: job.id,
      message: String(message.message).slice(0, 300),
      challenge: job.challenge,
    });
  } else if (message.type === 'CAPTURE_META') {
    if (!Number.isSafeInteger(message.total) || message.total < 1 || message.total > MAX_PAGES)
      throw new Error(`За один раз можно обработать до ${MAX_PAGES} страниц.`);
    if (
      job.protocol === 2 &&
      (!Number.isSafeInteger(message.documentTotal) ||
        message.documentTotal < message.total ||
        (job.toPage || message.documentTotal) - job.fromPage + 1 !== message.total ||
        job.fromPage > message.documentTotal ||
        (job.toPage && job.toPage > message.documentTotal))
    )
      throw Error('Doc88 вернул неверное число страниц диапазона.');
    job.total = message.total;
    await saveJob(job);
    await notify(job.targetTab, {
      type: 'META',
      id: job.id,
      total: job.total,
      title: String(message.title || 'document').slice(0, 100),
      documentTotal: message.documentTotal || job.total,
    });
  } else if (message.type === 'CAPTURE_CACHED') {
    if (
      job.protocol !== 2 ||
      message.index !== job.received ||
      !job.skip.includes(message.index) ||
      job.received >= job.total
    )
      throw Error('Сохранённая страница не относится к заданию.');
    const acknowledged = await notify(job.targetTab, {
      type: 'CACHED',
      id: job.id,
      index: job.received,
      ack: true,
    });
    if (acknowledged?.error) throw Error(acknowledged.error);
    job.received++;
    await saveJob(job);
  } else if (message.type === 'CAPTURE_PAGE') {
    const image = message.image;
    if (
      message.index !== job.received ||
      !job.total ||
      job.received >= job.total ||
      typeof image !== 'string' ||
      !/^data:image\/jpeg;base64,/.test(image) ||
      image.length > 28 * 1024 * 1024
    )
      throw new Error('Не удалось получить изображение страницы.');
    job.bytes += Math.ceil((image.length * 3) / 4);
    if (job.bytes > MAX_BYTES)
      throw new Error(
        'Документ больше 250 МБ. Используй локальную программу для больших документов.',
      );
    const acknowledged = await notify(job.targetTab, {
      type: 'PAGE',
      id: job.id,
      index: job.received,
      image,
      ack: job.protocol === 2,
    });
    if (acknowledged?.error) throw Error(acknowledged.error);
    job.received++;
    await saveJob(job);
  } else if (message.type === 'CAPTURE_DONE') {
    if (job.received !== job.total) throw new Error('Переданы не все страницы. PDF не создан.');
    job.phase = 'ocr';
    await saveJob(job);
    await notify(job.targetTab, { type: 'DONE', id: job.id });
    await chrome.tabs.update(job.targetTab, { active: true });
  } else if (message.type === 'CAPTURE_ERROR') {
    await endJob(job, String(message.message || 'Не удалось загрузить документ.').slice(0, 300));
  } else throw new Error('Неизвестный запрос.');
  return { ok: true };
}
let messageQueue = Promise.resolve();
function enqueue(task) {
  const result = messageQueue.then(task);
  messageQueue = result.catch(() => {});
  return result;
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (typeof serviceTypes !== 'undefined' && serviceTypes.has(message?.type)) {
    if (message.channel !== 'DOC88_PDF') return;
    handleService(message, sender).then(reply, (error) => reply({ error: error.message }));
    return true;
  }
  enqueue(() => handle(message, sender)).then(reply, (error) => reply({ error: error.message }));
  return true;
});
chrome.action.onClicked.addListener(async (tab) => {
  try {
    docURL(tab.url);
    await enqueue(() => startJob(tab.url, tab.id, null, { protocol: 2 }));
  } catch (error) {
    if (tab.url && /^https:\/\/(?:www\.)?doc88\.com\/p-\d+\.html/.test(tab.url))
      await notify(tab.id, { type: 'NOTICE', message: error.message }).catch(() => {});
    else await chrome.tabs.create({ url: SITE });
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  void chrome.storage.session.get('isoSession').then(async ({ isoSession }) => {
    if (isoSession && (isoSession.owner === tabId || isoSession.tabId === tabId)) {
      await chrome.storage.session.remove('isoSession');
      if (isoSession.owner === tabId) await chrome.tabs.remove(isoSession.tabId).catch(() => {});
    }
  });
  void enqueue(async () => {
    const job = await getJob();
    if (job && (tabId === job.targetTab || (tabId === job.sourceTab && job.phase !== 'ocr')))
      await endJob(job, 'Вкладка документа или обработки закрыта. Запусти заново.');
  });
});
