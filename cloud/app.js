'use strict';
const $ = (id) => document.getElementById(id);
const terminal = new Set(['done', 'cancelled', 'error']);
let selected = localStorage.getItem('doc88-cloud-job');
let polling = false;
let submitting = false;
let finished = false;
async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'x-doc88-request': '1', ...options.headers },
    cache: 'no-store',
  });
  if (!response.headers.get('content-type')?.includes('application/json'))
    throw new Error('Сервер запускается или временно недоступен. Попробуй ещё раз через минуту.');
  const value = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(value.error || 'Сервер не отвечает. Попробуй ещё раз.'), {
      status: response.status,
    });
  return value;
}
function error(message) {
  $('error').textContent = message;
  $('error').hidden = !message;
}
function render(job) {
  finished = terminal.has(job.stage);
  $('url-form').hidden = true;
  $('task').hidden = false;
  $('task-title').textContent = job.title || 'Документ';
  $('message').textContent = job.message;
  $('cancel').hidden = terminal.has(job.stage);
  $('reset').hidden = !terminal.has(job.stage);
  let progress = job.total ? job.current / job.total : 0;
  progress =
    job.stage === 'done'
      ? 100
      : job.stage === 'merging'
        ? 98
        : job.stage === 'ocr'
          ? 35 + progress * 60
          : job.stage === 'unpacking'
            ? 32
            : progress * 30;
  $('progress').value = progress;
  $('results').hidden = !job.pdfReady;
  if (job.stage === 'error') error(job.message);
  if (job.pdfReady) {
    $('task-title').textContent = 'PDF готов';
    $('message').textContent =
      'Можно искать и копировать текст. Если скачивание не началось, нажми кнопку ниже.';
    $('pdf-link').href = `/api/jobs/${job.id}/pdf`;
    $('pdf-link').download = job.pdfFilename;
    $('zip-link').href = `/api/jobs/${job.id}/zip`;
    $('zip-link').download = job.archiveFilename;
    $('stats').textContent =
      `${job.total} стр. · ${(job.bytes / 1024 / 1024).toFixed(1)} МБ · ${job.textChars.toLocaleString('ru')} знаков текста` +
      (job.blankPages ? ` · Без текста: ${job.blankPages} стр.` : '');
    if (localStorage.getItem('doc88-cloud-downloaded') !== job.id) {
      localStorage.setItem('doc88-cloud-downloaded', job.id);
      const link = document.createElement('a');
      link.href = $('pdf-link').href;
      link.download = job.pdfFilename;
      document.body.append(link);
      link.click();
      link.remove();
    }
  }
}
async function refresh() {
  if (!selected || finished || polling || submitting) return;
  polling = true;
  const id = selected;
  try {
    const job = await api('/api/jobs/' + id);
    if (selected !== id) return;
    render(job);
    $('connection').textContent = '● Сервер подключён';
  } catch (failure) {
    if (selected !== id) return;
    if (failure.status === 404) {
      reset();
      error(failure.message);
      return;
    }
    error(failure.message);
    $('reset').hidden = false;
    $('cancel').hidden = true;
  } finally {
    polling = false;
  }
}
$('url-form').onsubmit = async (event) => {
  event.preventDefault();
  if (submitting) return;
  submitting = true;
  error('');
  $('start').disabled = true;
  try {
    const job = await api('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: $('url').value.trim(),
        fromPage: $('from').value,
        toPage: $('to').value,
      }),
    });
    selected = job.id;
    finished = false;
    localStorage.setItem('doc88-cloud-job', selected);
    render(job);
  } catch (failure) {
    error(failure.message);
  } finally {
    submitting = false;
    $('start').disabled = false;
  }
};
$('cancel').onclick = async () => {
  $('cancel').disabled = true;
  try {
    await api(`/api/jobs/${selected}/cancel`, { method: 'POST' });
    await refresh();
  } catch (failure) {
    error(failure.message);
  } finally {
    $('cancel').disabled = false;
  }
};
function reset() {
  selected = null;
  finished = false;
  localStorage.removeItem('doc88-cloud-job');
  $('task').hidden = true;
  $('url-form').hidden = false;
  error('');
}
$('reset').onclick = reset;
(async () => {
  try {
    const config = await api('/api/config');
    $('connection').textContent = '● Сервер подключён';
    $('limit').textContent =
      `До ${config.maxPages} страниц за один раз. Для большого документа выбери диапазон.`;
    await refresh();
  } catch (failure) {
    $('connection').textContent = 'Сервер просыпается…';
    error(failure.message);
  }
})();
setInterval(refresh, 2000);
window.addEventListener('beforeunload', (event) => {
  if (selected && !$('cancel').hidden) {
    event.preventDefault();
    event.returnValue = '';
  }
});
