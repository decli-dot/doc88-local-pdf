'use strict';
(() => {
  if (!/^\/p-\d+\.html$/.test(location.pathname) || document.getElementById('doc88-pdf-extension'))
    return;
  // Canvas/placeholder loading follows apankowski/doc88-downloader.
  // OCR and ZIP libraries run in a separate page, outside Doc88's JS globals.
  const host = document.createElement('div');
  host.id = 'doc88-pdf-extension';
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `:host{position:fixed;bottom:24px;right:24px;z-index:2147483647;font:14px/1.45 system-ui,sans-serif;color:#17372b}section{max-width:310px;padding:16px;border:1px solid #bacebf;border-radius:16px;background:#f8fcf8;box-shadow:0 8px 35px #0002}button{font:inherit;font-weight:650;border:0;border-radius:9px;padding:11px 15px;background:#205b40;color:white;cursor:pointer}button:disabled{opacity:.6;cursor:wait}p{margin:10px 0 0;white-space:pre-wrap}button.cancel{background:transparent;color:#205b40;padding:8px 0}button[hidden]{display:none}`;
  const box = document.createElement('section');
  const button = document.createElement('button');
  button.textContent = 'Скачать OCR PDF';
  const status = document.createElement('p');
  status.textContent = 'PDF с поиском • English';
  const cancel = document.createElement('button');
  cancel.className = 'cancel';
  cancel.textContent = 'Остановить';
  cancel.hidden = true;
  box.append(button, status, cancel);
  root.append(style, box);
  document.documentElement.append(host);
  let active = null;
  async function send(type, data = {}) {
    const response = await chrome.runtime.sendMessage({ channel: 'DOC88_PDF', type, ...data });
    if (response?.error) throw new Error(response.error);
    return response;
  }
  button.onclick = async () => {
    button.disabled = true;
    status.textContent = 'Открываем обработку…';
    try {
      const result = await send('START_DOC88');
      if (!active) active = { id: result.id, cancelled: false, waiting: true };
      cancel.hidden = false;
    } catch (error) {
      button.disabled = false;
      status.textContent = error.message;
    }
  };
  cancel.onclick = () => {
    if (active)
      void send('CANCEL', { id: active.id }).catch((error) => {
        status.textContent = error.message;
      });
  };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  function check(job) {
    if (job.cancelled) throw new Error('Обработка остановлена.');
  }
  async function waitFor(job, predicate, message, timeout = 90000) {
    const end = Date.now() + timeout;
    let progressAt = 0;
    while (!predicate()) {
      check(job);
      if (Date.now() > end) throw new Error(message + ' Время ожидания истекло.');
      // Messages also keep the MV3 service worker alive while waiting for Doc88.
      if (Date.now() - progressAt > 5000) {
        status.textContent = message;
        await send('CAPTURE_PROGRESS', { id: job.id, message });
        progressAt = Date.now();
      }
      await sleep(200);
    }
    check(job);
  }
  async function capture(job) {
    try {
      button.disabled = true;
      cancel.hidden = false;
      await waitFor(
        job,
        () => document.getElementById('page_1') && document.getElementById('pageNumInput'),
        'Ждём загрузку документа…',
      );
      let repeat;
      do {
        check(job);
        repeat = false;
        const more = document.getElementById('continueButton');
        if (more) {
          more.click();
          repeat = true;
          await sleep(200);
        }
        for (const selector of ['captcha_reading', 'continue_page']) {
          const element = document.getElementById(selector);
          if (!element) continue;
          repeat = true;
          element.scrollIntoView({ block: 'center' });
          await waitFor(
            job,
            () => !element.isConnected,
            selector === 'captcha_reading'
              ? 'Реши капчу на Doc88 — продолжим автоматически.'
              : 'Подтверди чтение на Doc88 — продолжим автоматически.',
            15 * 60 * 1000,
          );
        }
      } while (repeat);
      const input = document.getElementById('pageNumInput');
      const total = parseInt(
        input.parentNode.innerText.replaceAll(' ', '').replaceAll('/', ''),
        10,
      );
      if (!Number.isSafeInteger(total) || total < 1 || total > 500)
        throw new Error('Не удалось прочитать число страниц или документ больше 500 страниц.');
      for (let page = 1; page <= total; page++) {
        if (!document.getElementById('page_' + page))
          throw new Error(`Doc88 не предоставил страницу ${page}.`);
      }
      const title =
        document.querySelector('h1')?.title ||
        document.querySelector('meta[property="og:title"]')?.content ||
        document.title;
      await send('CAPTURE_META', { id: job.id, total, title });
      for (let index = 0; index < total; index++) {
        check(job);
        const canvas = document.getElementById('page_' + (index + 1));
        canvas.scrollIntoView({ block: 'center' });
        await waitFor(
          job,
          () => canvas.getAttribute('lz') === '1',
          `Загружаем страницу ${index + 1} из ${total}…`,
        );
        if (!canvas.width || !canvas.height || canvas.width * canvas.height > 50000000)
          throw new Error('Некорректный размер страницы.');
        const image = canvas.toDataURL('image/jpeg', 0.9);
        await send('CAPTURE_PAGE', { id: job.id, index, image });
        status.textContent = `Передано ${index + 1} из ${total} страниц`;
      }
      await send('CAPTURE_DONE', { id: job.id });
      status.textContent = 'Страницы переданы. Распознаём текст в открытой вкладке…';
      cancel.hidden = true;
    } catch (error) {
      status.textContent = error.message;
      if (!job.cancelled)
        await send('CAPTURE_ERROR', { id: job.id, message: error.message }).catch(() => {});
      if (active === job || !active) {
        button.disabled = false;
        cancel.hidden = true;
        active = null;
      }
    }
  }
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id || message?.channel !== 'DOC88_PDF') return;
    if (message.type === 'CAPTURE') {
      if (!active || (active.id === message.id && active.waiting)) {
        active = { id: message.id, cancelled: false };
        void capture(active);
      }
      reply({ ok: true });
    } else if (message.type === 'STOP_CAPTURE' && active?.id === message.id) {
      active.cancelled = true;
      active = null;
      button.disabled = false;
      cancel.hidden = true;
      status.textContent = message.error || 'PDF с поиском • English';
      reply({ ok: true });
    } else if (message.type === 'NOTICE') {
      status.textContent = message.message;
      reply({ ok: true });
    }
  });
})();
