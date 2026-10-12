'use strict';
const $ = (id) => document.getElementById(id);
const completeStages = new Set(['done', 'error', 'cancelled']);
const stageNames = {
  queued: 'Подготовка',
  opening: 'Открываем',
  waiting: 'Нужно действие',
  downloading: 'Скачиваем',
  unpacking: 'Проверяем ZIP',
  ocr: 'Распознаём',
  merging: 'Собираем PDF',
  done: 'Готово',
  error: 'Ошибка',
  cancelled: 'Остановлено',
};
let selectedId = localStorage.getItem('doc88-selected');
let selectedFile = null;
let uploading = false;
let latestJobs = [];
let offline = false;
let lastHistory = '';

function error(message) {
  $('form-error').textContent = message;
  $('form-error').hidden = !message;
}
async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'x-doc88-request': '1', ...options.headers },
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'Не удалось выполнить действие.');
  return value;
}
function chooseTab(mode) {
  for (const name of ['url', 'zip']) {
    const chosen = mode === name;
    $(name + '-tab').setAttribute('aria-selected', String(chosen));
    $(name + '-tab').tabIndex = chosen ? 0 : -1;
    $(name + '-panel').hidden = !chosen;
  }
  error('');
}
for (const mode of ['url', 'zip']) {
  $(mode + '-tab').onclick = () => chooseTab(mode);
  $(mode + '-tab').onkeydown = (event) => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const next = mode === 'url' ? 'zip' : 'url';
      chooseTab(next);
      $(next + '-tab').focus();
    }
  };
}
function selectJob(id) {
  selectedId = id;
  localStorage.setItem('doc88-selected', id);
  renderJob(latestJobs.find((job) => job.id === id));
  renderHistory();
}
function size(bytes) {
  return bytes >= 1024 * 1024
    ? (bytes / 1024 / 1024).toFixed(1) + ' МБ'
    : Math.ceil(bytes / 1024) + ' КБ';
}
function renderJob(job) {
  $('empty-state').hidden = !!job;
  $('job-state').hidden = !job;
  $('status-pill').textContent = job ? stageNames[job.stage] : 'Ожидание';
  $('status-pill').dataset.status = job?.stage || 'idle';
  if (!job) return;
  $('job-title').textContent = job.title;
  $('job-message').textContent = job.message;
  const end = completeStages.has(job.stage);
  const step = job.stage === 'done' ? 2 : ['ocr', 'merging'].includes(job.stage) ? 1 : 0;
  document.querySelectorAll('.steps>div').forEach((element, index) => {
    element.classList.toggle('active', index === step);
    element.classList.toggle('complete', index < step || job.stage === 'done');
  });
  let progress = 0;
  if (job.stage === 'done') progress = 100;
  else if (job.stage === 'merging') progress = 95;
  else if (job.stage === 'ocr') progress = 35 + 60 * (job.total ? job.current / job.total : 0);
  else if (job.stage === 'unpacking') progress = 32;
  else if (job.total) progress = (30 * job.current) / job.total;
  $('progress-fill').style.width = progress + '%';
  $('progress').classList.toggle('indeterminate', !job.total && !end);
  if (job.total) $('progress').setAttribute('aria-valuenow', String(Math.round(progress)));
  else $('progress').removeAttribute('aria-valuenow');
  $('progress').hidden = end && job.stage !== 'done';
  const seconds = Math.max(
    0,
    Math.round(
      ((job.finishedAt ? Date.parse(job.finishedAt) : Date.now()) - Date.parse(job.createdAt)) /
        1000,
    ),
  );
  const time = seconds >= 60 ? `${Math.floor(seconds / 60)} мин ${seconds % 60} с` : `${seconds} с`;
  $('job-meta').textContent =
    job.stage === 'done'
      ? `${job.total} стр. · ${size(job.bytes)} · ${time}`
      : `${job.total ? `${job.current} / ${job.total} стр. · ` : ''}${time}`;
  $('manual-note').hidden = job.stage !== 'waiting';
  $('result-actions').hidden = !job.pdfReady;
  $('pdf-download').href = `/api/jobs/${job.id}/pdf`;
  $('pdf-preview').href = `/api/jobs/${job.id}/pdf?preview=1`;
  $('zip-download').href = `/api/jobs/${job.id}/zip`;
  $('zip-download').hidden = !job.archiveReady;
  $('cancel').hidden = end;
  $('cancel').disabled = false;
  $('blank-note').hidden = !job.pdfReady || !job.blankPages;
  $('blank-note').textContent =
    `На ${job.blankPages} стр. текст не найден; изображения этих страниц сохранены.`;
}
function renderHistory() {
  const state = JSON.stringify(
    latestJobs.map((job) => [job.id, job.title, job.stage, job.total, selectedId]),
  );
  if (state === lastHistory) return;
  lastHistory = state;
  $('history-section').hidden = !latestJobs.length;
  $('history-list').replaceChildren();
  for (const job of latestJobs.slice(0, 5)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'history-item' + (job.id === selectedId ? ' selected' : '');
    const icon = document.createElement('span');
    icon.className = 'history-icon';
    icon.textContent = job.stage === 'done' ? '✓' : '▤';
    icon.setAttribute('aria-hidden', 'true');
    const title = document.createElement('span');
    title.className = 'history-title';
    title.textContent = job.title;
    const meta = document.createElement('span');
    meta.className = 'history-meta';
    meta.textContent = `${job.total ? job.total + ' стр. · ' : ''}${stageNames[job.stage]}`;
    button.append(icon, title, meta);
    button.onclick = () => selectJob(job.id);
    $('history-list').append(button);
  }
}
async function refresh() {
  if (offline) return;
  try {
    const state = await api('/api/status');
    latestJobs = state.jobs;
    $('engine-status').textContent =
      state.ocr === 'ready' ? 'Готов к работе' : 'Модель загрузится при первом запуске';
    if (state.activeId) selectedId = state.activeId;
    if (!latestJobs.some((job) => job.id === selectedId)) selectedId = latestJobs[0]?.id || null;
    const busy = !!state.activeId || uploading;
    for (const id of [
      'start-url',
      'start-zip',
      'document-url',
      'from-page',
      'to-page',
      'archive-file',
    ])
      $(id).disabled = busy;
    renderJob(latestJobs.find((job) => job.id === selectedId));
    renderHistory();
  } catch {
    $('engine-status').textContent = 'Приложение не отвечает';
  }
}
$('url-panel').onsubmit = async (event) => {
  event.preventDefault();
  error('');
  $('start-url').disabled = true;
  try {
    const url = $('document-url').value.trim();
    localStorage.setItem('doc88-url', url);
    const job = await api('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, fromPage: $('from-page').value, toPage: $('to-page').value }),
    });
    selectedId = job.id;
    localStorage.setItem('doc88-selected', job.id);
    await refresh();
  } catch (failure) {
    error(failure.message);
    $('start-url').disabled = false;
  }
};
function chooseFile(file) {
  if (!file) return;
  if (!/\.zip$/i.test(file.name)) return error('Выбери ZIP-архив с изображениями страниц.');
  if (file.size > 250 * 1024 * 1024)
    return error('Архив больше 250 МБ. Обработай документ частями.');
  selectedFile = file;
  $('file-label').textContent = file.name;
  error('');
}
$('archive-file').onchange = (event) => chooseFile(event.target.files[0]);
for (const name of ['dragenter', 'dragover'])
  $('dropzone').addEventListener(name, (event) => {
    event.preventDefault();
    $('dropzone').classList.add('dragging');
  });
for (const name of ['dragleave', 'drop'])
  $('dropzone').addEventListener(name, (event) => {
    event.preventDefault();
    $('dropzone').classList.remove('dragging');
  });
$('dropzone').addEventListener('drop', (event) => {
  if (!$('archive-file').disabled) chooseFile(event.dataTransfer.files[0]);
});
$('zip-panel').onsubmit = async (event) => {
  event.preventDefault();
  error('');
  if (!selectedFile) return error('Сначала выбери архив.');
  uploading = true;
  $('start-zip').disabled = true;
  $('start-zip').textContent = 'Загружаем архив…';
  try {
    const job = await api('/api/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/zip',
        'x-filename': encodeURIComponent(selectedFile.name),
      },
      body: selectedFile,
    });
    selectedId = job.id;
    localStorage.setItem('doc88-selected', job.id);
  } catch (failure) {
    error(failure.message);
  } finally {
    uploading = false;
    $('start-zip').innerHTML = 'Распознать и создать PDF <span aria-hidden="true">↗</span>';
    await refresh();
  }
};
$('cancel').onclick = async () => {
  $('cancel').disabled = true;
  try {
    await api(`/api/jobs/${selectedId}/cancel`, { method: 'POST' });
    await refresh();
  } catch (failure) {
    error(failure.message);
  }
};
$('shutdown').onclick = async () => {
  try {
    await api('/api/shutdown', { method: 'POST' });
    offline = true;
    $('engine-status').textContent = 'Приложение закрыто';
    $('shutdown').disabled = true;
    error('Приложение закрыто. Для нового запуска открой Start.cmd.');
    for (const id of ['start-url', 'start-zip', 'cancel']) $(id).disabled = true;
  } catch (failure) {
    error(failure.message);
  }
};
$('document-url').value = localStorage.getItem('doc88-url') || '';
void refresh();
setInterval(refresh, 1000);
