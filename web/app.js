'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  let current = null;
  let installed = false;
  let zipBusy = false;
  let pdfURL = null;
  let zipURL = null;
  const pending = new Map();
  async function command(type, extra = {}, timeout = 5000) {
    const request = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(request);
        reject(new Error('Расширение не отвечает. Установи его и обнови страницу.'));
      }, timeout);
      pending.set(request, { resolve, reject, timer });
      window.postMessage(
        { channel: 'DOC88_PAGE_COMMAND', request, type, ...extra },
        location.origin,
      );
    });
  }
  function showError(error) {
    $('error').textContent = error?.message || String(error);
    $('error').hidden = false;
  }
  function showTask(title = 'Готовим документ') {
    $('error').hidden = true;
    $('url-form').hidden = true;
    $('task').hidden = false;
    $('task-title').textContent = title;
    $('results').hidden = true;
    $('reset').hidden = true;
    $('cancel').hidden = false;
    $('archive-option').hidden = true;
    $('setup').hidden = true;
    $('progress').value = 0;
  }
  function progress(message, value) {
    $('message').textContent = message;
    if (value != null) $('progress').value = value;
  }
  function stop({ notify = true, error } = {}) {
    const job = current;
    if (!job) return;
    current = null;
    job.controller.abort();
    if (notify && job.id) void command('CANCEL', { id: job.id }).catch(() => {});
    $('cancel').hidden = true;
    $('reset').hidden = false;
    progress(error ? 'Не удалось завершить обработку' : 'Обработка остановлена.', 0);
    if (error) showError(error);
  }
  function download(href, filename) {
    const link = document.createElement('a');
    link.href = href;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
  }
  async function convert(job) {
    try {
      const result = await Doc88OCR.createPDF(job.images, {
        title: job.title,
        signal: job.controller.signal,
        onProgress: (event) => {
          if (current === job) progress(event.message, event.percent);
        },
      });
      if (current !== job) return;
      pdfURL = URL.createObjectURL(new Blob([result.bytes], { type: 'application/pdf' }));
      const filename = Doc88OCR.cleanName(job.title) + '_OCR.pdf';
      $('pdf-link').href = pdfURL;
      $('pdf-link').download = filename;
      $('task-title').textContent = 'PDF готов';
      $('message').textContent =
        'Можно искать и копировать текст. Если скачивание не началось, нажми кнопку ниже.';
      $('stats').textContent =
        `${result.pages} стр. · ${(result.bytes.length / 1024 / 1024).toFixed(1)} МБ · ${result.textChars.toLocaleString('ru')} знаков текста` +
        (result.blankPages ? ` · Без распознанного текста: ${result.blankPages} стр.` : '');
      $('results').hidden = false;
      $('cancel').hidden = true;
      $('reset').hidden = false;
      $('progress').value = 100;
      current = null;
      if (job.id) void command('FINISH', { id: job.id }).catch(() => {});
      $('zip-link').onclick = async () => {
        if (zipBusy) return;
        zipBusy = true;
        $('zip-link').disabled = true;
        try {
          if (!zipURL) {
            const zip = new JSZip();
            job.images.forEach((image, index) =>
              zip.file(
                `page${String(index + 1).padStart(3, '0')}.${image.type === 'image/png' ? 'png' : 'jpg'}`,
                image,
              ),
            );
            zipURL = URL.createObjectURL(await zip.generateAsync({ type: 'blob' }));
          }
          download(zipURL, Doc88OCR.cleanName(job.title) + '.zip');
        } catch (error) {
          showError(error);
        } finally {
          zipBusy = false;
          $('zip-link').disabled = false;
        }
      };
      download(pdfURL, filename);
    } catch (error) {
      if (current === job) stop({ error });
    }
  }
  async function ready(id) {
    const job = { id, title: 'document', total: 0, images: [], controller: new AbortController() };
    current = job;
    showTask();
    progress('Ждём страницы Doc88. Оставь вкладку документа открытой.', 0);
    try {
      await command('READY', { id });
    } catch (error) {
      if (current === job) stop({ error });
    }
  }
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (message?.channel === 'DOC88_EXT_REPLY') {
      const request = pending.get(message.request);
      if (!request) return;
      clearTimeout(request.timer);
      pending.delete(message.request);
      if (message.result?.error) request.reject(new Error(message.result.error));
      else request.resolve(message.result);
      return;
    }
    if (message?.channel !== 'DOC88_EXT_EVENT' || !current || message.id !== current.id) return;
    const job = current;
    if (message.type === 'PROGRESS') progress(message.message);
    else if (message.type === 'META') {
      if (!Number.isSafeInteger(message.total) || message.total < 1 || message.total > 500) {
        stop({ error: new Error('Некорректное число страниц.') });
        return;
      }
      job.total = message.total;
      job.title = String(message.title || 'document').slice(0, 100);
      $('task-title').textContent = job.title;
    } else if (message.type === 'PAGE') {
      if (
        message.index !== job.images.length ||
        job.images.length >= job.total ||
        typeof message.image !== 'string' ||
        !/^data:image\/jpeg;base64,/.test(message.image)
      ) {
        stop({ error: new Error('Не удалось получить все страницы по порядку.') });
        return;
      }
      const binary = atob(message.image.slice(message.image.indexOf(',') + 1));
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      job.images.push(new Blob([bytes], { type: 'image/jpeg' }));
      progress(
        `Получено ${job.images.length} из ${job.total} страниц…`,
        (job.images.length / job.total) * 100,
      );
    } else if (message.type === 'DONE') {
      if (job.images.length !== job.total || !job.total) {
        stop({ error: new Error('Переданы не все страницы. PDF не создан.') });
        return;
      }
      void convert(job);
    } else if (message.type === 'ERROR') stop({ notify: false, error: new Error(message.message) });
    else if (message.type === 'CANCELLED') stop({ notify: false });
  });
  $('cancel').onclick = () => stop();
  $('reset').onclick = () => {
    if (zipBusy) return;
    if (pdfURL) URL.revokeObjectURL(pdfURL);
    if (zipURL) URL.revokeObjectURL(zipURL);
    pdfURL = zipURL = null;
    $('zip-link').onclick = null;
    $('error').hidden = true;
    $('task').hidden = true;
    $('url-form').hidden = false;
    $('archive-option').hidden = false;
    $('setup').hidden = installed;
    $('archive').value = '';
    history.replaceState(null, '', location.pathname);
  };
  $('url-form').onsubmit = async (event) => {
    event.preventDefault();
    if (current) return;
    if (!installed) {
      $('setup').hidden = false;
      $('setup').scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    $('start').disabled = true;
    try {
      const url = Doc88OCR.validateURL($('url').value);
      const { id } = await command('START_URL', { url }, 15000);
      history.replaceState(null, '', '#job=' + id);
      await ready(id);
    } catch (error) {
      showError(error);
    } finally {
      $('start').disabled = false;
    }
  };
  $('archive').onchange = async () => {
    const file = $('archive').files[0];
    if (!file || current) return;
    const job = {
      controller: new AbortController(),
      title: file.name.replace(/\.zip$/i, ''),
      images: [],
    };
    current = job;
    showTask(job.title);
    progress('Проверяем изображения в архиве…', 0);
    try {
      job.images = await Doc88OCR.unpackZip(file, job.controller.signal);
      if (current === job) await convert(job);
    } catch (error) {
      if (current === job) stop({ error });
    }
  };
  const extensionAddress = /Edg\//.test(navigator.userAgent)
    ? 'edge://extensions'
    : 'chrome://extensions';
  $('extensions-address').textContent = extensionAddress;
  $('extensions-address').onclick = async () => {
    try {
      await navigator.clipboard.writeText(extensionAddress);
      $('extensions-address').textContent = 'Скопировано ✓';
      setTimeout(() => {
        $('extensions-address').textContent = extensionAddress;
      }, 1500);
    } catch {
      $('extensions-address').textContent = extensionAddress;
    }
  };
  window.addEventListener('beforeunload', (event) => {
    if (current) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
  (async () => {
    try {
      const result = await command('PING', {}, 2000);
      installed = Boolean(result?.version);
    } catch {
      installed = false;
    }
    $('connection').textContent = installed
      ? '● Расширение подключено'
      : 'Нужна однократная установка';
    $('setup').hidden = installed;
    $('start').textContent = installed ? 'Получить PDF →' : 'Добавить расширение →';
    const id = new URLSearchParams(location.hash.slice(1)).get('job');
    if (id && /^[0-9a-f-]{36}$/.test(id) && installed) await ready(id);
  })();
})();
