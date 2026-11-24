'use strict';
const $ = (id) => document.getElementById(id);
const { normalizeQuery } = window.Doc88Query;
const { displayText, present } = window.DecliPDF;
const feedback = window.DecliFeedback;
const fileLink = (path) => window.Doc88Browser?.link(path) || path;
let reviewJobId = null,
  reviewStamp = '';
let cachedDocuments = [],
  cacheEvents = [];
const completeStages = new Set(['done', 'error', 'cancelled', 'interrupted']);
const stageNames = {
  queued: 'В очереди',
  interrupted: 'Прервано',
  resolving: 'Уточняем издание',
  choosing: 'Выбор издания',
  selecting: 'Выбор документов',
  language: 'Выбор языка',
  searching: 'Ищем документ',
  checking: 'Проверяем',
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
const linkedJob = new URLSearchParams(location.search).get('job');
const validLinkedJob = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(linkedJob || '')
  ? linkedJob.toLowerCase()
  : null;
let selectedId = validLinkedJob || localStorage.getItem('doc88-selected');
let selectedFile = null;
let uploading = false;
let latestJobs = [];
let offline = false;
let lastHistory = '';
let lastSearch = '';
let postingSearch = false;
let postingBatch = false;
let activeId = null;
let followActive = !validLinkedJob;
let latestBatches = [];
let lastBatches = '';
const workspaceKey = 'declipdf-cleared-workspace';
let clearedJobs = new Set(),
  clearedBatches = new Set();
try {
  const saved = JSON.parse(localStorage.getItem(workspaceKey) || '{}');
  clearedJobs = new Set(Array.isArray(saved.jobs) ? saved.jobs : []);
  clearedBatches = new Set(Array.isArray(saved.batches) ? saved.batches : []);
} catch {
  /* An invalid saved view must not prevent the app from opening. */
}
const visibleJobs = () => latestJobs.filter((job) => !clearedJobs.has(job.id));
const visibleBatches = () => latestBatches.filter((batch) => !clearedBatches.has(batch.id));
function saveWorkspace() {
  localStorage.setItem(
    workspaceKey,
    JSON.stringify({ jobs: [...clearedJobs], batches: [...clearedBatches] }),
  );
}
function workspaceBusy() {
  return (
    !!activeId ||
    uploading ||
    postingSearch ||
    postingBatch ||
    visibleJobs().some(
      (job) =>
        !completeStages.has(job.stage) &&
        !['choosing', 'selecting', 'language', 'waiting'].includes(job.stage),
    ) ||
    visibleBatches().some((batch) => batch.status === 'running')
  );
}
function renderClearButtons() {
  const busy = workspaceBusy();
  for (const id of ['clear-workspace', 'clear-queue']) {
    $(id).disabled = busy;
    $(id).title = busy ? 'Завершите или остановите текущую обработку.' : 'Очистить рабочую область';
  }
}
function clearWorkspace() {
  if (workspaceBusy()) return;
  for (const job of latestJobs) clearedJobs.add(job.id);
  for (const batch of latestBatches) {
    clearedBatches.add(batch.id);
    for (const item of batch.items) clearedJobs.add(item.id);
  }
  saveWorkspace();
  selectedId = null;
  followActive = true;
  selectedFile = null;
  for (const key of ['doc88-selected', 'doc88-query', 'doc88-batch-draft', 'doc88-url'])
    localStorage.removeItem(key);
  for (const id of [
    'search-query',
    'batch-queries',
    'document-url',
    'from-page',
    'to-page',
    'archive-file',
  ])
    $(id).value = '';
  $('file-label').removeAttribute('data-file');
  $('file-label').textContent = 'Выбрать ZIP-архив';
  $('copy-content').value = '';
  if ($('copy-dialog').open) $('copy-dialog').close();
  error('');
  chooseTab('search');
  lastHistory = lastSearch = lastBatches = '';
  renderJob(null);
  renderHistory();
  renderSearch(null);
  renderBatches();
  renderClearButtons();
  $('search-query').focus();
}
$('clear-workspace').onclick = clearWorkspace;
$('clear-queue').onclick = clearWorkspace;
window.addEventListener('doc88-import', (event) => {
  selectedId = event.detail.id;
  followActive = true;
  void refresh();
});
let devMode = false;
const requestedEnhancement = () => !devMode || $('enhance-images').checked;
let modes = ['search', 'batch'];
const processingSelect = $('processing-mode');
const savedProcessingMode = localStorage.getItem('declipdf-processing-mode') || 'auto';
processingSelect.value = ['auto', 'direct', 'ocr'].includes(savedProcessingMode)
  ? savedProcessingMode
  : 'auto';
const processingMode = () =>
  devMode && !$('zip-panel').hidden ? 'ocr' : devMode ? processingSelect.value : 'auto';
processingSelect.onchange = () =>
  localStorage.setItem('declipdf-processing-mode', processingSelect.value);
const sourceSelect = $('source-policy');
const savedSourcePolicy = localStorage.getItem('declipdf-source-policy');
if ([...sourceSelect.options].some((option) => option.value === savedSourcePolicy))
  sourceSelect.value = savedSourcePolicy;
const sourcePolicy = () => (devMode ? sourceSelect.value : 'doc88-first');
sourceSelect.onchange = () => localStorage.setItem('declipdf-source-policy', sourceSelect.value);
let captchaConfigured = false;
function renderCaptchaSettings(value) {
  captchaConfigured = value.configured;
  $('captcha-enabled').checked = value.enabled;
  $('captcha-job-limit').value = value.maxPerJob ?? 0;
  $('captcha-day-limit').value = value.maxPerDay ?? 0;
  $('captcha-key-status').textContent = value.configured ? 'Ключ сохранён' : 'Ключ не указан';
  $('captcha-balance').textContent = Number.isFinite(value.balance) ? value.balance + ' ₽' : '—';
  $('captcha-usage').textContent = value.attemptsToday + ' / ' + (value.maxPerDay ?? '∞');
  $('captcha-remove').disabled = !value.configured;
}
async function captchaAction(action) {
  $('captcha-error').hidden = true;
  for (const id of ['captcha-save', 'captcha-check', 'captcha-remove']) $(id).disabled = true;
  try {
    renderCaptchaSettings(await action());
  } catch (failure) {
    $('captcha-error').textContent = failure.message;
    $('captcha-error').hidden = false;
  } finally {
    for (const id of ['captcha-save', 'captcha-check', 'captcha-remove']) $(id).disabled = false;
    $('captcha-remove').disabled = !captchaConfigured;
  }
}
async function loadCaptchaSettings() {
  if (!devMode || window.Doc88Browser) return;
  await captchaAction(() => api('/api/dev/captcha'));
}
$('captcha-settings').ontoggle = () => {
  if ($('captcha-settings').open) void loadCaptchaSettings();
};
$('captcha-form').onsubmit = async (event) => {
  event.preventDefault();
  const key = $('captcha-key').value.trim();
  await captchaAction(async () => {
    const result = await api('/api/dev/captcha', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled: $('captcha-enabled').checked,
        maxPerJob: Number($('captcha-job-limit').value) || null,
        maxPerDay: Number($('captcha-day-limit').value) || null,
        ...(key ? { apiKey: key } : {}),
      }),
    });
    $('captcha-key').value = '';
    return result;
  });
};
$('captcha-check').onclick = () =>
  captchaAction(() => api('/api/dev/captcha/balance', { method: 'POST' }));
$('captcha-remove').onclick = () =>
  captchaAction(async () => {
    const result = await api('/api/dev/captcha', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: '', enabled: false }),
    });
    $('captcha-key').value = '';
    return result;
  });
function setDevMode(value) {
  if (devMode === value) return;
  devMode = value;
  document.body.classList.toggle('dev-mode', value);
  $('dev-logout').hidden = !value;
  $('url-tab').hidden = true;
  $('zip-tab').hidden = true;
  modes = ['search', 'batch'];
  if (!value) {
    $('captcha-key').value = '';
    $('url-panel').hidden = true;
    $('url-tab').setAttribute('aria-selected', 'false');
    $('url-tab').tabIndex = -1;
    if (localStorage.getItem('doc88-mode') === 'url') chooseTab('search');
  }
  if (value) {
    void loadCaptchaSettings();
    void loadDocumentCache();
  }
  lastSearch = lastHistory = lastBatches = '';
}
const languageSelect = $('ocr-language');
let preferredOCR = localStorage.getItem('declipdf-ocr-language') || 'eng';
if (!window.DecliOCR.languages.includes(preferredOCR)) preferredOCR = 'eng';
function syncOCRLanguage() {
  processingSelect.disabled = !$('zip-panel').hidden;
  const batch = !$('batch-panel').hidden;
  const search = !$('search-panel').hidden;
  if (batch || search) {
    const queries = batch
      ? $('batch-queries')
          .value.split(/\r?\n/)
          .filter((line) => line.trim())
      : [$('search-query').value];
    const values = new Set(queries.map((query) => window.DecliOCR.policy(query)?.models || 'auto'));
    const job = latestJobs.find((item) => item.id === selectedId);
    if (
      search &&
      job?.documentLanguage &&
      queries.some((query) => [job.query, job.resolvedQuery].includes(normalizeQuery(query)))
    ) {
      values.clear();
      values.add(job.documentLanguage);
    }
    languageSelect.value = values.size === 1 ? [...values][0] : 'auto';
    languageSelect.disabled = true;
  } else {
    languageSelect.disabled = false;
    languageSelect.value = ['eng', 'deu', 'fra', 'rus'].includes(preferredOCR)
      ? preferredOCR
      : 'eng';
  }
  const value = languageSelect.value;
  const name = feedback.languageLabel(value);
  $('document-language-summary').textContent = name
    ? 'Язык документа: ' + name
    : value.includes('+')
      ? 'Язык документа: выбор при поиске'
      : batch
        ? 'Язык документа: для каждого документа'
        : 'Язык документа: автоматически';
}
languageSelect.onchange = () => {
  preferredOCR = languageSelect.value;
  localStorage.setItem('declipdf-ocr-language', preferredOCR);
};
$('search-query').addEventListener('input', syncOCRLanguage);
$('batch-queries').addEventListener('input', syncOCRLanguage);
function showDevLogin() {
  if (!window.Doc88Browser && !devMode) {
    $('dev-error').hidden = true;
    $('dev-dialog').showModal();
    $('dev-password').focus();
  }
}
document.addEventListener('keydown', (event) => {
  if (event.ctrlKey && event.shiftKey && event.code === 'KeyD') {
    event.preventDefault();
    showDevLogin();
  }
});
$('dev-close').onclick = () => $('dev-dialog').close();
$('dev-form').onsubmit = async (event) => {
  event.preventDefault();
  $('dev-submit').disabled = true;
  try {
    await api('/api/dev/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: $('dev-password').value }),
    });
    $('dev-password').value = '';
    $('dev-dialog').close();
    await refresh();
  } catch (failure) {
    $('dev-error').textContent = failure.message;
    $('dev-error').hidden = false;
  } finally {
    $('dev-submit').disabled = false;
  }
};
$('dev-logout').onclick = async () => {
  try {
    await api('/api/dev/logout', { method: 'POST' });
    await refresh();
  } catch (failure) {
    error(failure.message);
  }
};
function stageLabel(stage) {
  return stageNames[stage] || stage;
}
let editionKey = '';
let editionJobId = null;
let editionPosting = false;
let detailsKey = '',
  supplementsKey = '';

function renderDocumentDetails(job) {
  const structure = job?.documentStructure,
    references = job?.normativeReferences;
  const hasStructure = Boolean(job?.pdfReady && structure?.nodes?.length),
    hasReferences = Boolean(job?.pdfReady && references?.items?.length);
  $('structure-panel').hidden = !hasStructure;
  $('references-panel').hidden = !hasReferences;
  $('document-details').hidden = !hasStructure && !hasReferences;
  $('document-details').classList.toggle('single-panel', hasStructure !== hasReferences);
  const key = JSON.stringify([job?.id, job?.pdfReady, structure, references]);
  if (key === detailsKey) return;
  detailsKey = key;
  $('structure-count').textContent = structure?.count ? `(${structure.count})` : '';
  $('structure-message').textContent = structure?.message || 'Структура ещё не извлечена.';
  const tree = (nodes) => {
    const list = document.createElement('ol');
    for (const node of nodes || []) {
      const item = document.createElement('li'),
        link = document.createElement('a');
      link.textContent = node.label + (node.title ? ' ' + node.title : '');
      link.href = fileLink(`/api/jobs/${job.id}/pdf?preview=1#page=${node.page}`);
      link.target = '_blank';
      link.rel = 'noopener';
      link.title = `Лист PDF ${node.page}`;
      if (node.children?.length) {
        const details = document.createElement('details'),
          summary = document.createElement('summary');
        summary.append(link);
        details.append(summary, tree(node.children));
        item.append(details);
      } else item.append(link);
      list.append(item);
    }
    return list;
  };
  $('structure-tree').replaceChildren(tree(structure?.nodes));
  $('references-message').textContent =
    references?.message || 'Нормативные ссылки ещё не извлечены.';
  $('references-list').replaceChildren();
  let selected = 0;
  for (const entry of references?.items || []) {
    const label = document.createElement('label');
    label.className = 'reference-option';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = entry.query;
    checkbox.disabled = !entry.searchable;
    checkbox.checked = Boolean(entry.searchable) && selected++ < 30;
    const text = document.createElement('span');
    text.textContent =
      entry.label +
      (entry.series ? ' — уточни часть' : entry.incomplete ? ' — проверь обозначение по PDF' : '');
    label.append(checkbox, text);
    $('references-list').append(label);
  }
  $('find-references').hidden = !(references?.items || []).some((entry) => entry.searchable);
  $('find-references').disabled = !$('references-list').querySelector('input:checked');
}
function renderSupplements(job) {
  const edition = job?.isoEdition;
  const key = JSON.stringify([job?.id, edition?.supplements, Boolean(activeId)]);
  if (key === supplementsKey) return;
  supplementsKey = key;
  $('iso-supplements').replaceChildren();
  $('iso-supplements').hidden =
    !edition?.supplements?.length || /\/(?:Amd|Cor)\b/i.test(edition?.reference || '');
  if ($('iso-supplements').hidden) return;
  const title = document.createElement('strong');
  title.textContent = edition.supplements.length
    ? 'Поправки к этому изданию'
    : 'В карточке ISO поправки не найдены.';
  $('iso-supplements').append(title);
  for (const supplement of edition.supplements) {
    const row = document.createElement('div');
    row.className = 'supplement-row';
    const link = document.createElement('a');
    link.href = supplement.sourceURL;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = supplement.reference + ' ↗';
    const button = document.createElement('button');
    button.className = 'secondary';
    button.type = 'button';
    button.textContent = 'Искать отдельно';
    button.onclick = () => void startSearch({ query: supplement.reference });
    button.disabled = Boolean(activeId);
    if (supplement.status === 'Withdrawn') {
      const note = document.createElement('span');
      note.textContent = 'Отозвано';
      row.append(note);
    }
    row.append(link, button);
    $('iso-supplements').append(row);
  }
}
$('references-list').onchange = () => {
  $('find-references').disabled = !$('references-list').querySelector('input:checked');
};
$('find-references').onclick = async () => {
  const queries = [...$('references-list').querySelectorAll('input:checked')].map(
    (input) => input.value,
  );
  if (!queries.length) return;
  $('find-references').disabled = true;
  postingBatch = true;
  renderClearButtons();
  try {
    const batch = await api('/api/batches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        queries,
        sourcePolicy: sourcePolicy(),
        processingMode: processingMode(),
        enhanceImages: requestedEnhancement(),
        ocrLanguage: languageSelect.value,
      }),
    });
    selectedId = batch.stage === 'language' ? batch.id : batch.items[0]?.id;
    followActive = true;
    if (selectedId) localStorage.setItem('doc88-selected', selectedId);
    await refresh();
  } catch (failure) {
    $('references-message').textContent = failure.message;
    $('find-references').disabled = false;
  } finally {
    postingBatch = false;
    renderClearButtons();
  }
};

let seriesKey = '',
  seriesJobId = null,
  seriesPosting = false;
function seriesCount() {
  const selected = $('series-options').querySelectorAll('input:checked').length;
  $('series-count').textContent = `Выбрано: ${selected}`;
  $('series-submit').disabled = !selected || seriesPosting;
}
function renderSeriesChoice(job) {
  const dialog = $('series-dialog');
  if (job?.stage !== 'selecting') {
    if (dialog.open) dialog.close();
    seriesKey = '';
    seriesJobId = null;
    return;
  }
  seriesJobId = job.id;
  const key = JSON.stringify([job.id, job.seriesOptions]);
  if (key !== seriesKey) {
    seriesKey = key;
    $('series-reference').textContent = job.seriesReference || job.query;
    $('series-error').hidden = true;
    $('series-options').replaceChildren();
    for (const edition of job.seriesOptions || []) {
      const row = document.createElement('div');
      row.className = 'edition-option';
      const label = document.createElement('label'),
        checkbox = document.createElement('input'),
        text = document.createElement('span'),
        title = document.createElement('strong'),
        description = document.createElement('span');
      checkbox.type = 'checkbox';
      checkbox.value = edition.reference;
      title.className = 'edition-reference';
      title.textContent = edition.reference;
      description.className = 'edition-title';
      description.textContent = edition.title;
      text.append(title, description);
      if (edition.status !== 'Published') {
        const status = document.createElement('span');
        status.className = 'edition-status';
        status.textContent = 'Архивное издание';
        text.append(status);
      }
      label.append(checkbox, text);
      row.append(label);
      $('series-options').append(row);
    }
  }
  seriesCount();
  if (!dialog.open) dialog.showModal();
}
$('series-options').onchange = seriesCount;
$('series-all').onclick = () => {
  for (const checkbox of $('series-options').querySelectorAll('input')) checkbox.checked = true;
  seriesCount();
};
$('series-none').onclick = () => {
  for (const checkbox of $('series-options').querySelectorAll('input')) checkbox.checked = false;
  seriesCount();
};
$('series-form').onsubmit = async (event) => {
  event.preventDefault();
  if (seriesPosting || !seriesJobId) return;
  seriesPosting = true;
  seriesCount();
  $('series-cancel').disabled = true;
  try {
    const batch = await api(`/api/jobs/${seriesJobId}/series`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        references: [...$('series-options').querySelectorAll('input:checked')].map(
          (checkbox) => checkbox.value,
        ),
      }),
    });
    selectedId = batch.stage === 'language' ? batch.id : batch.items[0]?.id;
    followActive = true;
    localStorage.setItem('doc88-selected', selectedId);
    await refresh();
  } catch (error) {
    $('series-error').textContent = error.message;
    $('series-error').hidden = false;
  } finally {
    seriesPosting = false;
    $('series-cancel').disabled = false;
    seriesCount();
  }
};
$('series-cancel').onclick = async () => {
  if (seriesPosting || !seriesJobId) return;
  try {
    await api(`/api/jobs/${seriesJobId}/cancel`, { method: 'POST' });
    await refresh();
  } catch (error) {
    $('series-error').textContent = error.message;
    $('series-error').hidden = false;
  }
};
$('series-dialog').addEventListener('cancel', (event) => {
  event.preventDefault();
  $('series-cancel').click();
});
$('show-copy-text').onclick = async () => {
  $('show-copy-text').disabled = true;
  try {
    const result = await api(`/api/jobs/${selectedId}/text`);
    $('copy-content').value = result.text;
    $('copy-message').textContent = '';
    $('copy-dialog').showModal();
  } catch (failure) {
    error(failure.message);
  } finally {
    $('show-copy-text').disabled = false;
  }
};
$('copy-close').onclick = () => $('copy-dialog').close();
$('copy-button').onclick = async () => {
  try {
    await navigator.clipboard.writeText($('copy-content').value);
    $('copy-message').textContent = 'Текст скопирован.';
  } catch {
    $('copy-content').focus();
    $('copy-content').select();
    $('copy-message').textContent = 'Нажмите Ctrl+C, чтобы скопировать выделенный текст.';
  }
};

let languageJobId = null,
  languageKey = '',
  languagePosting = false;
function renderLanguageChoice(job) {
  const dialog = $('language-dialog');
  if (job?.stage !== 'language') {
    if (dialog.open) dialog.close();
    languageKey = '';
    languageJobId = null;
    return;
  }
  languageJobId = job.id;
  const key = JSON.stringify([
    job.id,
    job.languageChoices,
    job.languageScope,
    job.languageException,
  ]);
  if (key !== languageKey) {
    languageKey = key;
    const series = job.languageScope === 'series';
    $('language-heading').textContent = series ? 'Язык серии' : 'Язык документа';
    $('language-reference').textContent = series
      ? job.seriesReference
      : job.resolvedQuery || job.query;
    $('language-question').textContent = series
      ? 'Выберите один или несколько языков для выбранных документов.'
      : job.languageException === 'batch-unavailable'
        ? 'Выбранный для серии язык недоступен. Подтвердите язык этого документа.'
        : 'Выберите один или несколько языков документа.';
    $('language-toolbar').hidden = (job.languageChoices || []).length < 2;
    $('language-error').hidden = true;
    $('language-options').replaceChildren();
    for (const choice of job.languageChoices || []) {
      const row = document.createElement('label'),
        input = document.createElement('input'),
        text = document.createElement('strong');
      row.className = 'edition-option';
      input.type = 'checkbox';
      input.name = 'document-language';
      input.value = choice.code;
      text.textContent = choice.label;
      row.append(input, text);
      $('language-options').append(row);
    }
  }
  $('language-submit').disabled =
    languagePosting || !$('language-options').querySelector('input:checked');
  $('language-all').disabled = $('language-none').disabled = languagePosting;
  if (!dialog.open) dialog.showModal();
}
$('language-form').onchange = () => {
  $('language-submit').disabled =
    languagePosting || !$('language-options').querySelector('input:checked');
};
for (const [id, checked] of [
  ['language-all', true],
  ['language-none', false],
]) {
  $(id).onclick = () => {
    if (languagePosting) return;
    for (const input of $('language-options').querySelectorAll('input')) input.checked = checked;
    $('language-form').onchange();
  };
}
$('language-form').onsubmit = async (event) => {
  event.preventDefault();
  const codes = [...$('language-options').querySelectorAll('input:checked')].map(
    (input) => input.value,
  );
  if (languagePosting || !codes.length || !languageJobId) return;
  languagePosting = true;
  $('language-submit').disabled = true;
  $('language-cancel').disabled = true;
  $('language-all').disabled = $('language-none').disabled = true;
  try {
    await api(`/api/jobs/${languageJobId}/language`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(codes.length === 1 ? { code: codes[0] } : { codes }),
    });
    await refresh();
  } catch (error) {
    $('language-error').textContent = error.message;
    $('language-error').hidden = false;
  } finally {
    languagePosting = false;
    $('language-form').onchange();
    $('language-cancel').disabled = false;
    $('language-all').disabled = $('language-none').disabled = false;
  }
};
$('language-cancel').onclick = async () => {
  if (languagePosting || !languageJobId) return;
  try {
    await api(`/api/jobs/${languageJobId}/cancel`, { method: 'POST' });
    await refresh();
  } catch (error) {
    $('language-error').textContent = error.message;
    $('language-error').hidden = false;
  }
};
$('language-dialog').addEventListener('cancel', (event) => {
  event.preventDefault();
  $('language-cancel').click();
});

function renderEditionChoice(job) {
  const dialog = $('edition-dialog');
  if (job?.stage !== 'choosing') {
    if (dialog.open) dialog.close();
    editionKey = '';
    editionJobId = null;
    return;
  }
  editionJobId = job.id;
  const key = JSON.stringify([job.id, job.isoChoices]);
  if (key !== editionKey) {
    editionKey = key;
    $('edition-description').textContent = devMode ? job.message : 'Выберите издание документа.';
    $('edition-error').hidden = true;
    $('edition-options').replaceChildren();
    for (const edition of job.isoChoices || []) {
      const option = document.createElement('div');
      option.className = 'edition-option';
      option.dataset.current = String(edition.status === 'Published');
      const label = document.createElement('label');
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'edition';
      radio.value = edition.reference;
      radio.required = true;
      const text = document.createElement('span');
      const reference = document.createElement('strong');
      reference.className = 'edition-reference';
      reference.textContent = edition.reference;
      const status = document.createElement('span');
      status.className = 'edition-status';
      status.textContent =
        (edition.status === 'Published'
          ? edition.currentConfirmed === false
            ? 'Опубликованное издание'
            : 'Действующее издание'
          : edition.status === 'Historical'
            ? 'Архивное издание'
            : 'Отозвано') +
        (edition.relation === 'predecessor' ? ' · другое обозначение в истории' : '') +
        (edition.pageCount ? ` · ${edition.pageCount} стр.` : '');
      const title = document.createElement('span');
      title.className = 'edition-title';
      title.textContent = edition.title || '';
      text.append(reference, status, title);
      label.append(radio, text);
      const source = document.createElement('a');
      source.href = edition.sourceURL;
      source.target = '_blank';
      source.rel = 'noopener';
      source.textContent = job.choicePublisher ? 'Каталог издателя ↗' : 'Карточка на ISO ↗';
      option.append(label, source);
      $('edition-options').append(option);
    }
  }
  $('edition-submit').disabled =
    editionPosting || !$('edition-form').querySelector('input:checked');
  $('edition-cancel').disabled = editionPosting;
  if (!dialog.open) dialog.showModal();
}
function editionError(error) {
  $('edition-error').hidden = false;
  $('edition-error').textContent = error.message;
}
$('edition-form').onchange = () => {
  $('edition-submit').disabled =
    editionPosting || !$('edition-form').querySelector('input:checked');
};
$('edition-form').onsubmit = async (event) => {
  event.preventDefault();
  const reference = $('edition-form').querySelector('input:checked')?.value;
  if (editionPosting || !editionJobId || !reference) return;
  editionPosting = true;
  $('edition-submit').disabled = true;
  $('edition-cancel').disabled = true;
  try {
    const job = await api(`/api/jobs/${editionJobId}/edition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reference }),
    });
    selectedId = job.id;
    followActive = false;
    localStorage.setItem('doc88-selected', job.id);
    $('search-query').value = job.resolvedQuery;
    localStorage.setItem('doc88-query', job.resolvedQuery);
    await refresh();
  } catch (error) {
    editionError(error);
  } finally {
    editionPosting = false;
    renderEditionChoice(latestJobs.find((job) => job.id === selectedId));
  }
};
async function cancelEditionChoice() {
  if (editionPosting || !editionJobId) return;
  editionPosting = true;
  $('edition-submit').disabled = true;
  $('edition-cancel').disabled = true;
  try {
    await api(`/api/jobs/${editionJobId}/cancel`, { method: 'POST' });
    await refresh();
  } catch (error) {
    editionError(error);
  } finally {
    editionPosting = false;
    renderEditionChoice(latestJobs.find((job) => job.id === selectedId));
  }
}
$('edition-cancel').onclick = () => void cancelEditionChoice();
$('edition-dialog').addEventListener('cancel', (event) => {
  event.preventDefault();
  void cancelEditionChoice();
});

function error(message) {
  $('form-error').textContent = displayText(message);
  $('form-error').hidden = !message;
}
async function api(url, options = {}) {
  const response = await (window.Doc88Browser?.fetch || fetch)(url, {
    ...options,
    headers: { 'x-doc88-request': '1', ...options.headers },
  });
  const value = present(await response.json());
  if (!response.ok) throw new Error(value.error || 'Не удалось выполнить действие.');
  return value;
}
function chooseTab(mode) {
  if (!modes.includes(mode)) mode = 'search';
  $('url-panel').hidden = true;
  $('zip-panel').hidden = true;
  localStorage.setItem('doc88-mode', mode);
  for (const name of modes) {
    const chosen = mode === name;
    $(name + '-tab').setAttribute('aria-selected', String(chosen));
    $(name + '-tab').tabIndex = chosen ? 0 : -1;
    $(name + '-panel').hidden = !chosen;
  }
  syncOCRLanguage();
  error('');
}
for (const mode of ['search', 'batch', 'url', 'zip']) {
  $(mode + '-tab').onclick = () => chooseTab(mode);
  $(mode + '-tab').onkeydown = (event) => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const next =
        event.key === 'Home'
          ? modes[0]
          : event.key === 'End'
            ? modes.at(-1)
            : modes[
                (modes.indexOf(mode) + (event.key === 'ArrowLeft' ? modes.length - 1 : 1)) %
                  modes.length
              ];
      chooseTab(next);
      $(next + '-tab').focus();
    }
  };
}
async function selectJob(id) {
  try {
    if (!latestJobs.some((job) => job.id === id)) latestJobs.push(await api(`/api/jobs/${id}`));
  } catch (failure) {
    error(failure.message);
    return;
  }
  selectedId = id;
  followActive = false;
  localStorage.setItem('doc88-selected', id);
  renderJob(latestJobs.find((job) => job.id === id));
  renderHistory();
  renderSearch(latestJobs.find((job) => job.id === id));
  renderBatches();
}
function size(bytes) {
  return bytes >= 1024 * 1024
    ? (bytes / 1024 / 1024).toFixed(1) + ' МБ'
    : Math.ceil(bytes / 1024) + ' КБ';
}
function renderJob(job) {
  if (!job) {
    $('document-review').hidden = true;
    reviewJobId = null;
  }
  renderPerformance(job);
  renderUserFeedback(job);
  $('result-section').hidden = !job;
  document.querySelector('.workspace').classList.toggle('empty-workspace', !job);
  renderDocumentDetails(job);
  renderSupplements(job);
  renderEditionChoice(job);
  renderSeriesChoice(job);
  renderLanguageChoice(job);
  syncOCRLanguage();
  window.Doc88Challenge?.render(job);
  $('empty-state').hidden = !!job;
  $('job-state').hidden = !job;
  const userProgress = job && (job.progress || feedback.phase(job));
  const problem = job && (job.problem || feedback.problem(job));
  const notes = job && (job.qualityNotes || feedback.qualityNotes(job));
  $('status-pill').textContent = !job
    ? 'Ожидание'
    : devMode
      ? stageLabel(job.stage)
      : problem
        ? problem.label
        : job.stage === 'done' && notes.length
          ? 'Готово с замечаниями'
          : userProgress.label;
  $('status-pill').dataset.status = job?.stage || 'idle';
  if (!job) return;
  $('job-title').textContent = job.title;
  $('naming-warning').hidden = !job.namingWarning;
  $('naming-warning').textContent = job.namingWarning || '';
  const edition = job.catalogueEdition || job.isoEdition;
  const publisher =
    edition?.publisher || (edition?.reference?.startsWith('ISO/IEC') ? 'ISO/IEC' : 'ISO');
  const legacyExtent =
    devMode &&
    job.kind === 'search' &&
    edition &&
    job.stage === 'done' &&
    !job.verification?.extent;
  if (legacyExtent) {
    $('status-pill').textContent = 'Нужна проверка';
    $('status-pill').dataset.status = 'waiting';
  }
  const isoURL = edition?.sourceURL || job.isoLookupURL;
  $('iso-edition').hidden = !isoURL;
  if (isoURL) {
    $('iso-edition-label').textContent = edition ? 'Издание ' + publisher : 'Каталог издателя';
    $('iso-edition-link').href = isoURL;
    $('iso-edition-link').textContent = edition ? edition.reference + ' ↗' : 'Открыть каталог ↗';
    $('iso-edition-date').textContent = edition
      ? 'Проверено ' + new Date(edition.checkedAt).toLocaleDateString('ru')
      : job.namingWarning
        ? 'Полное название получить не удалось.'
        : job.stage === 'cancelled'
          ? 'Уточнение издания остановлено.'
          : job.stage === 'error'
            ? 'Год не подтверждён. Можно указать его в запросе вручную.'
            : 'Проверяем обозначение и статус публикации…';
    $('iso-page-count').textContent = edition?.pageCount
      ? `Каталог ${publisher}: ${edition.pageCount} стр.${job.stage === 'done' ? ` · PDF: ${job.total} стр.` : ''}`
      : 'Число страниц по каталогу ещё не подтверждено.';
  }
  $('job-message').textContent = legacyExtent
    ? 'Этот PDF создан до добавления сверки объёма по каталогу. Повтори поиск, чтобы проверить, что это не сокращённый документ.'
    : devMode
      ? job.message
      : problem?.message || userProgress.message;
  const end = completeStages.has(job.stage);
  const step = userProgress.step;
  document.querySelectorAll('.steps>div').forEach((element, index) => {
    element.classList.toggle('active', index === step && job.stage !== 'done');
    element.classList.toggle('complete', index < step || job.stage === 'done');
  });
  let progress = 0;
  if (job.stage === 'done') progress = 100;
  else if (job.stage === 'merging') progress = 95;
  else if (job.stage === 'checking') progress = 98;
  else if (job.stage === 'ocr') progress = 35 + 60 * (job.total ? job.current / job.total : 0);
  else if (job.stage === 'unpacking') progress = 32;
  else if (job.total) progress = (30 * job.current) / job.total;
  $('progress-fill').style.width = progress + '%';
  $('progress').classList.toggle('indeterminate', !job.total && !end);
  if (job.total) $('progress').setAttribute('aria-valuenow', String(Math.round(progress)));
  else $('progress').removeAttribute('aria-valuenow');
  $('progress').hidden =
    ['choosing', 'selecting', 'language'].includes(job.stage) || (end && job.stage !== 'done');
  const seconds = Math.max(
    0,
    Math.round(
      ((job.finishedAt ? Date.parse(job.finishedAt) : Date.now()) - Date.parse(job.createdAt)) /
        1000,
    ),
  );
  const time = seconds >= 60 ? `${Math.floor(seconds / 60)} мин ${seconds % 60} с` : `${seconds} с`;
  $('job-meta').hidden = !devMode && job.stage !== 'done';
  $('processing-result').hidden = !devMode || !job.processingEngine;
  $('processing-result').textContent =
    job.processingEngine === 'direct'
      ? 'Прямое извлечение'
      : job.processingEngine === 'ocr'
        ? job.engineFallback
          ? 'Изображения + OCR · автоматическое переключение'
          : 'Изображения + OCR'
        : '';
  $('job-meta').textContent =
    job.stage === 'done'
      ? `${job.total} стр. · ${size(job.bytes)} · ${time}`
      : `${job.total ? `${job.current} / ${job.total} стр. · ` : ''}${time}`;
  $('manual-note').hidden = job.stage !== 'waiting';
  $('result-actions').hidden = !job.pdfReady;
  renderDocumentReview(job);
  $('show-copy-text').hidden = !job.pdfReady || !job.copyTextReady;
  $('pdf-download').href = fileLink(`/api/jobs/${job.id}/pdf`);
  $('pdf-download').download = job.pdfFilename || 'document.pdf';
  $('pdf-preview').href = fileLink(`/api/jobs/${job.id}/pdf?preview=1`);
  $('zip-download').href = fileLink(`/api/jobs/${job.id}/zip`);
  $('zip-download').hidden = !job.archiveReady;
  $('cancel').hidden = end;
  $('cancel').disabled = false;
  $('resume').hidden = !job.canResume;
  const retry = problem?.actions.find((action) => action.type === 'retry');
  $('resume').textContent = retry?.label || 'Продолжить';
  const reused = (job.reusedDownloadPages || 0) + (job.reusedOCRPages || 0);
  $('resume-note').hidden = !reused;
  $('resume-note').textContent =
    `Повторно использовано: изображений — ${job.reusedDownloadPages || 0}, страниц OCR — ${job.reusedOCRPages || 0}.`;
  $('integrity-note').hidden = !job.pageIntegrity && !job.pdfReady;
  $('integrity-note').dataset.status = job.pageIntegrity?.status || 'unknown';
  $('integrity-note').textContent =
    job.pageIntegrity?.message ||
    'Этот PDF создан без проверки нумерации и дублей. При необходимости запусти проверку документа заново.';
  const language = job.verification?.language;
  $('language-note').hidden = !job.pdfReady || language?.status !== 'unknown';
  $('language-note').textContent = language?.message || '';
  const enhanced = job.imageEnhancement?.pages || [];
  $('enhancement-note').hidden = !enhanced.length;
  $('enhancement-note').textContent = enhanced.length
    ? `Увеличено перед OCR: ${enhanced.length} стр., до ${Math.max(...enhanced.map((page) => page.scaleX)).toLocaleString('ru', { maximumFractionDigits: 1 })}×. Исходные изображения сохранены в ZIP.`
    : '';
  $('blank-note').hidden = !job.pdfReady || !job.blankPages;
  $('blank-note').textContent =
    `На ${job.blankPages} стр. текст не найден; изображения этих страниц сохранены.`;
}
let lastUserFeedback = '';
function renderUserFeedback(job) {
  const problem = job && (job.problem || feedback.problem(job));
  const notes = job && (job.qualityNotes || feedback.qualityNotes(job));
  const key = JSON.stringify([job?.id, problem, notes]);
  if (key === lastUserFeedback) return;
  lastUserFeedback = key;
  const actions = $('problem-actions'),
    container = $('quality-notes');
  actions.replaceChildren();
  container.replaceChildren();
  actions.hidden = !problem;
  container.hidden = !notes?.length;
  for (const action of problem?.actions || []) {
    if (action.type === 'retry') continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'secondary';
    button.textContent = action.label;
    button.onclick = async () => {
      if (action.type === 'edit') {
        chooseTab('search');
        $('search-query').value = job.resolvedQuery || job.query || '';
        syncOCRLanguage();
        $('search-query').focus();
        $('search-query').select();
        return;
      }
      if (action.type === 'language') {
        button.disabled = true;
        try {
          await api(`/api/jobs/${job.id}/reselect-language`, { method: 'POST' });
          await refresh();
        } catch (failure) {
          error(failure.message);
        } finally {
          button.disabled = false;
        }
      }
    };
    actions.append(button);
  }
  for (const note of notes || []) {
    const article = document.createElement('div');
    article.className = 'quality-note';
    article.dataset.kind = note.type;
    const message = document.createElement('p');
    message.textContent = note.message;
    article.append(message);
    const linkTo = (page) => {
      const link = document.createElement('a');
      link.className = 'text-link';
      link.target = '_blank';
      link.rel = 'noopener';
      link.href = fileLink(`/api/jobs/${job.id}/pdf?preview=1`) + (page ? '#page=' + page : '');
      link.textContent = page ? 'Страница ' + page : 'Открыть PDF ↗';
      return link;
    };
    const links = document.createElement('div');
    links.className = 'quality-page-links';
    if (!note.pages.length) links.append(linkTo(null));
    for (const page of note.pages.slice(0, 4)) links.append(linkTo(page));
    article.append(links);
    if (note.pages.length > 4) {
      const more = document.createElement('details'),
        summary = document.createElement('summary'),
        rest = document.createElement('div');
      summary.textContent = 'Ещё страниц: ' + (note.pages.length - 4);
      rest.className = 'quality-page-links';
      for (const page of note.pages.slice(4)) rest.append(linkTo(page));
      more.append(summary, rest);
      article.append(more);
    }
    container.append(article);
  }
}
function renderPerformance(job) {
  const metrics = devMode ? job?.performanceMetrics : null;
  $('performance-panel').hidden = !metrics?.stages?.length;
  const table = $('performance-stages');
  table.replaceChildren();
  if (!metrics) return;
  const labels = {
    cache: 'Проверка сохранённых файлов',
    cache_write: 'Сохранение для повторного поиска',
    catalogue: 'Каталог издателя',
    search: 'Поиск',
    preview: 'Предварительная проверка',
    download: 'Загрузка',
    prepare: 'Подготовка изображений',
    ocr: 'OCR',
    pdf: 'Сборка PDF',
    verification: 'Проверка документа',
    waiting: 'Подтверждение доступа',
  };
  const delta =
    metrics.status === 'running' && metrics.updatedAt
      ? Math.max(0, Date.now() - Date.parse(metrics.updatedAt))
      : 0;
  const duration = (ms) =>
    (ms / 1000).toLocaleString(window.DecliI18n?.locale === 'en' ? 'en' : 'ru', {
      maximumFractionDigits: 1,
    }) + ' с';
  $('performance-total').textContent = 'Общее время: ' + duration(metrics.elapsedMs + delta);
  for (const stage of metrics.stages) {
    const row = document.createElement('tr');
    for (const value of [
      labels[stage.key] || stage.key,
      duration(stage.wallMs + (stage.active ? delta : 0)),
      String(stage.calls),
    ]) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    }
    if (stage.active) row.dataset.active = 'true';
    table.append(row);
  }
  const pool = job.previewDiagnostics;
  $('performance-parallel').textContent = pool
    ? `Предварительная проверка: завершено ${pool.completed} из ${pool.started ?? pool.total}; максимум одновременно — ${pool.peak}.`
    : '';
}
function renderSearch(job) {
  const results = devMode ? job?.searchResults || [] : [];
  $('search-results-section').hidden = !results.length;
  const busy = !!activeId || uploading || postingSearch;
  const key = JSON.stringify([job?.id, results, busy]);
  if (key === lastSearch) return;
  lastSearch = key;
  $('search-results-list').replaceChildren();
  const requiresExtent = Boolean(job?.isoEdition || job?.catalogueEdition || job?.isoLookupURL);
  const resultStatus = (item) =>
    item.status === 'passed' && requiresExtent && item.checks?.extent?.status !== 'passed'
      ? 'unverified'
      : item.status;
  const passed = results.some((item) => resultStatus(item) === 'passed');
  $('search-summary').textContent = passed
    ? 'Подходящий вариант проверен'
    : busy
      ? 'Проверяем найденные варианты…'
      : 'Подтверждённого варианта пока нет';
  for (const result of results) {
    const status = resultStatus(result);
    const card = document.createElement('article');
    card.className = 'search-result';
    card.dataset.status = status;
    const heading = document.createElement('h3');
    heading.textContent = displayText(result.title);
    const meta = document.createElement('p');
    meta.className = 'helper';
    meta.textContent = `${result.format || 'Документ'} · ${result.pageCount ? result.pageCount + ' стр.' : 'Число страниц уточняется'} · ${status === 'checking' ? 'Идёт проверка' : status === 'passed' ? 'Подходит' : status === 'unverified' ? 'Ещё не проверен' : 'Проверка не пройдена'}`;
    const badges = document.createElement('div');
    badges.className = 'check-badges';
    for (const [name, label] of [
      [
        'language',
        { eng: 'Английский', deu: 'Немецкий', fra: 'Французский', rus: 'Русский' }[
          job.documentLanguage || job.ocrLanguage
        ] || 'Язык документа',
      ],
      ['completeness', 'Все страницы'],
      ...(requiresExtent ? [['extent', 'Объём издания']] : []),
      ['identity', 'Издание'],
      ['pageIntegrity', 'Нумерация и дубли'],
    ]) {
      const check = result.checks?.[name];
      const badge = document.createElement('span');
      badge.dataset.status = check?.status || 'unknown';
      badge.textContent = `${check?.status === 'passed' ? '✓' : check?.status === 'failed' ? '×' : '·'} ${label}`;
      badge.title = check?.message || 'Пока не проверено';
      badges.append(badge);
    }
    card.append(heading, meta, badges);
    if (result.checks?.extent && result.checks.extent.status !== 'passed') {
      const reason = document.createElement('p');
      reason.className = 'helper';
      reason.textContent = result.checks.extent.message;
      card.append(reason);
    }
    if (result.checks) {
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = 'Основания проверки';
      details.append(summary);
      for (const check of Object.values(result.checks)) {
        const explanation = document.createElement('p');
        explanation.className = 'helper';
        explanation.textContent = check.message;
        details.append(explanation);
      }
      card.append(details);
    }
    if (result.error) {
      const message = document.createElement('p');
      message.className = 'helper';
      message.textContent = result.error;
      card.append(message);
    }
    const actions = document.createElement('div');
    actions.className = 'search-actions';
    if (status === 'passed' && job.pdfReady) {
      const pdf = document.createElement('a');
      pdf.className = 'text-link';
      pdf.textContent = 'Скачать проверенный PDF ↓';
      pdf.href = fileLink(`/api/jobs/${job.id}/pdf`);
      actions.append(pdf);
    } else if (result.status !== 'checking') {
      const check = document.createElement('button');
      check.type = 'button';
      check.className = 'secondary';
      check.textContent = 'Проверить этот вариант';
      check.disabled = busy;
      check.onclick = () =>
        startSearch({ query: job.query, sourceJobId: job.id, candidateURL: result.url });
      actions.append(check);
    }
    card.append(actions);
    $('search-results-list').append(card);
  }
}
async function startSearch(input) {
  if (postingSearch || offline) return;
  input = {
    ...input,
    query: normalizeQuery(input.query),
    enhanceImages: requestedEnhancement(),
    ocrLanguage: languageSelect.value,
    processingMode: processingMode(),
    sourcePolicy: sourcePolicy(),
  };
  postingSearch = true;
  renderClearButtons();
  error('');
  $('start-search').disabled = true;
  try {
    const job = await api('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    selectedId = job.id;
    followActive = true;
    localStorage.setItem('doc88-selected', job.id);
    const displayedQuery = job.resolvedQuery || job.query;
    $('search-query').value = displayedQuery;
    localStorage.setItem('doc88-query', displayedQuery);
    syncOCRLanguage();
  } catch (failure) {
    error(failure.message);
  } finally {
    postingSearch = false;
    await refresh();
  }
}
$('search-panel').onsubmit = (event) => {
  event.preventDefault();
  $('search-query').value = normalizeQuery($('search-query').value);
  void startSearch({ query: $('search-query').value });
};
$('search-query').onblur = () => {
  $('search-query').value = normalizeQuery($('search-query').value);
};
async function continueJob(id) {
  try {
    await api(`/api/jobs/${id}/resume`, { method: 'POST' });
    selectedId = id;
    followActive = false;
    localStorage.setItem('doc88-selected', id);
    await refresh();
  } catch (failure) {
    error(failure.message);
  }
}
$('resume').onclick = () => void continueJob(selectedId);
$('batch-queries').onblur = () => {
  $('batch-queries').value = $('batch-queries')
    .value.split(/\r?\n/)
    .map((value) => (value.trim() ? normalizeQuery(value) : ''))
    .join('\n');
  localStorage.setItem('doc88-batch-draft', $('batch-queries').value);
};
$('batch-queries').oninput = () =>
  localStorage.setItem('doc88-batch-draft', $('batch-queries').value);
$('batch-panel').onsubmit = async (event) => {
  event.preventDefault();
  error('');
  $('start-batch').disabled = true;
  postingBatch = true;
  renderClearButtons();
  try {
    const batch = await api('/api/batches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        queries: $('batch-queries').value,
        sourcePolicy: sourcePolicy(),
        processingMode: processingMode(),
        enhanceImages: requestedEnhancement(),
        ocrLanguage: languageSelect.value,
      }),
    });
    $('batch-queries').value = batch.items.map((item) => item.query).join('\n');
    localStorage.setItem('doc88-batch-draft', $('batch-queries').value);
    selectedId = batch.items[0]?.id;
    followActive = true;
    if (selectedId) localStorage.setItem('doc88-selected', selectedId);
    await refresh();
  } catch (failure) {
    error(failure.message);
  } finally {
    $('start-batch').disabled = false;
    postingBatch = false;
    renderClearButtons();
  }
};
function renderBatches() {
  const batches = visibleBatches();
  $('batch-section').hidden = !batches.length;
  const key = JSON.stringify([
    batches.map((batch) => [
      batch.id,
      batch.ready,
      batch.status,
      batch.items.map((item) => [
        item.id,
        item.stage,
        item.pdfReady,
        item.canResume,
        item.pageCheckStatus,
        item.documentLanguage,
      ]),
    ]),
    selectedId,
  ]);
  if (key === lastBatches) return;
  lastBatches = key;
  $('batch-list').replaceChildren();
  for (const batch of batches) {
    const card = document.createElement('article');
    card.className = 'batch-card';
    const heading = document.createElement('h3');
    heading.textContent = `Готово ${batch.ready} из ${batch.total}${batch.waiting ? ` · ждут выбора: ${batch.waiting}` : ''}`;
    card.append(heading);
    const actions = document.createElement('div');
    actions.className = 'batch-actions';
    if (batch.ready) {
      const link = document.createElement('a');
      link.className = 'primary';
      link.href = fileLink(`/api/batches/${batch.id}/zip`);
      link.textContent = `Скачать готовые PDF (${batch.ready}) ↓`;
      actions.append(link);
    }
    for (const [action, label, visible] of [
      ['resume', 'Продолжить незавершённые', batch.resumable],
      ['cancel', 'Остановить очередь', ['running', 'waiting'].includes(batch.status)],
    ]) {
      if (!visible) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'secondary';
      button.textContent = label;
      button.onclick = async () => {
        button.disabled = true;
        try {
          await api(`/api/batches/${batch.id}/${action}`, { method: 'POST' });
          await refresh();
        } catch (failure) {
          error(failure.message);
          button.disabled = false;
        }
      };
      actions.append(button);
    }
    card.append(actions);
    for (const item of batch.items) {
      const row = document.createElement('div');
      row.className = 'batch-row';
      row.classList.toggle('selected', item.id === selectedId);
      const choose = document.createElement('button');
      choose.type = 'button';
      choose.className = 'batch-document';
      const title = document.createElement('strong');
      title.textContent = item.query;
      const status = document.createElement('span');
      status.textContent =
        devMode && item.stage === 'done' && item.pageCheckStatus !== 'passed'
          ? 'Готово · проверь страницы'
          : devMode
            ? stageLabel(item.stage) || item.stage
            : item.hasQualityNotes
              ? 'Готово с замечаниями'
              : item.problem?.label || item.progress?.label || feedback.phase(item).label;
      choose.append(title, status);
      if (batch.languages?.length > 1 && item.documentLanguage) {
        const language = document.createElement('span');
        language.textContent =
          { eng: 'Английский', deu: 'Немецкий', fra: 'Французский', rus: 'Русский' }[
            item.documentLanguage
          ] || item.documentLanguage;
        choose.insertBefore(language, status);
      }
      choose.onclick = () => void selectJob(item.id);
      row.append(choose);
      if (['choosing', 'selecting', 'language', 'waiting'].includes(item.stage) || item.canResume) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'secondary';
        button.textContent =
          item.stage === 'selecting'
            ? 'Выбрать документы'
            : item.stage === 'language'
              ? 'Выбрать язык'
              : item.stage === 'choosing'
                ? 'Выбрать издание'
                : item.stage === 'waiting'
                  ? 'Показать проверку'
                  : 'Продолжить';
        button.onclick = () =>
          ['choosing', 'selecting', 'language', 'waiting'].includes(item.stage)
            ? void selectJob(item.id)
            : void continueJob(item.id);
        row.append(button);
      }
      if (item.pdfReady) {
        const link = document.createElement('a');
        link.className = 'text-link';
        link.href = fileLink(`/api/jobs/${item.id}/pdf`);
        link.textContent = 'PDF ↓';
        row.append(link);
      }
      card.append(row);
    }
    $('batch-list').append(card);
  }
}
function renderHistory() {
  const jobs = visibleJobs();
  const state = JSON.stringify(
    jobs.map((job) => [job.id, job.title, job.stage, job.total, selectedId]),
  );
  if (state === lastHistory) return;
  lastHistory = state;
  $('history-section').hidden = !jobs.length;
  $('history-list').replaceChildren();
  for (const job of jobs.slice(0, 5)) {
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
    meta.textContent = `${job.total ? job.total + ' стр. · ' : ''}${stageLabel(job.stage)}`;
    button.append(icon, title, meta);
    button.onclick = () => selectJob(job.id);
    $('history-list').append(button);
  }
}
async function refresh() {
  if (offline) return;
  try {
    const state = await api('/api/status');
    setDevMode(Boolean(state.devMode));
    latestJobs = state.jobs;
    activeId = state.activeId;
    latestBatches = state.batches || [];
    if (state.activeId && clearedJobs.has(state.activeId)) {
      clearedJobs.delete(state.activeId);
      for (const batch of latestBatches)
        if (batch.items.some((item) => item.id === state.activeId)) clearedBatches.delete(batch.id);
      saveWorkspace();
    }
    $('engine-status').textContent =
      state.ocr === 'ready' ? 'Готов к работе' : 'Модель загрузится при первом запуске';
    if (
      state.activeId &&
      followActive &&
      !$('edition-dialog').open &&
      !$('series-dialog').open &&
      !$('language-dialog').open
    )
      selectedId = state.activeId;
    if (clearedJobs.has(selectedId)) selectedId = null;
    if (!visibleJobs().some((job) => job.id === selectedId)) {
      if (selectedId) {
        try {
          const job = await api(`/api/jobs/${selectedId}`);
          if (!clearedJobs.has(job.id)) latestJobs.push(job);
          else selectedId = visibleJobs()[0]?.id || null;
        } catch {
          selectedId = visibleJobs()[0]?.id || null;
        }
      } else selectedId = visibleJobs()[0]?.id || null;
    }
    if (
      followActive &&
      !state.activeId &&
      !$('edition-dialog').open &&
      !$('series-dialog').open &&
      !$('language-dialog').open
    ) {
      const selected = latestJobs.find((job) => job.id === selectedId);
      const waiting = latestBatches
        .find((batch) => batch.id === selected?.batchId)
        ?.items.find((item) => item.stage === 'language');
      if (waiting) {
        if (!latestJobs.some((job) => job.id === waiting.id))
          latestJobs.push(await api(`/api/jobs/${waiting.id}`));
        selectedId = waiting.id;
        localStorage.setItem('doc88-selected', selectedId);
      }
    }
    const busy = !!state.activeId || uploading || postingSearch;
    for (const id of [
      'start-url',
      'start-search',
      'search-query',
      'start-zip',
      'document-url',
      'from-page',
      'to-page',
      'archive-file',
    ])
      $(id).disabled = busy;
    renderJob(latestJobs.find((job) => job.id === selectedId));
    renderHistory();
    renderSearch(latestJobs.find((job) => job.id === selectedId));
    renderBatches();
    renderClearButtons();
  } catch {
    $('engine-status').textContent = 'Приложение не отвечает';
    renderClearButtons();
  }
}
$('anna-form').onsubmit = async (event) => {
  event.preventDefault();
  $('anna-submit').disabled = true;
  $('anna-error').hidden = true;
  try {
    const job = await api('/api/experiments/anna', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: $('anna-query').value,
        cardURL: $('anna-card').value,
        slowURL: $('anna-slow').value,
      }),
    });
    selectedId = job.id;
    followActive = true;
    localStorage.setItem('doc88-selected', job.id);
    await refresh();
  } catch (error) {
    $('anna-error').textContent = error.message;
    $('anna-error').hidden = false;
  } finally {
    $('anna-submit').disabled = false;
  }
};
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
      body: JSON.stringify({
        url,
        processingMode: processingMode(),
        fromPage: $('from-page').value,
        toPage: $('to-page').value,
        enhanceImages: requestedEnhancement(),
        ocrLanguage: languageSelect.value,
      }),
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
  $('file-label').dataset.file = '1';
  $('file-label').textContent = displayText(file.name);
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
        'x-ocr-language': languageSelect.value,
        'x-doc88-enhance': requestedEnhancement() ? '1' : '0',
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
    error(
      window.Doc88Browser
        ? 'Работа остановлена. Обнови страницу, чтобы продолжить.'
        : 'Приложение закрыто. Для нового запуска открой Start.cmd.',
    );
    for (const id of ['start-search', 'start-url', 'start-zip', 'cancel']) $(id).disabled = true;
  } catch (failure) {
    error(failure.message);
  }
};
$('document-url').value = localStorage.getItem('doc88-url') || '';
$('search-query').value = localStorage.getItem('doc88-query') || '';
$('batch-queries').value = localStorage.getItem('doc88-batch-draft') || '';
$('enhance-images').checked = localStorage.getItem('doc88-enhance') !== '0';
$('enhance-images').onchange = () =>
  localStorage.setItem('doc88-enhance', $('enhance-images').checked ? '1' : '0');
const initialMode =
  new URLSearchParams(location.search).get('mode') ||
  (localStorage.getItem('declipdf-ui') ? localStorage.getItem('doc88-mode') : 'search');
localStorage.setItem('declipdf-ui', '1');
chooseTab(modes.includes(initialMode) ? initialMode : 'search');
if (new URLSearchParams(location.search).get('dev') === '1') showDevLogin();
void refresh();
setInterval(refresh, 1000);

function renderDocumentReview(job) {
  const ready = job?.stage === 'done' && job.pdfReady;
  $('document-review').hidden = !ready;
  if (!ready) {
    reviewJobId = null;
    return;
  }
  const stamp = JSON.stringify(job.review || null);
  if (reviewJobId !== job.id || reviewStamp !== stamp) {
    reviewJobId = job.id;
    reviewStamp = stamp;
    for (const radio of document.querySelectorAll('[name="review-rating"]'))
      radio.checked = radio.value === job.review?.rating;
    $('review-comment').value = job.review?.comment || '';
    $('review-status').textContent = job.review ? 'Оценка сохранена' : '';
  }
}
$('document-review').onsubmit = async (event) => {
  event.preventDefault();
  const id = reviewJobId;
  if (!id) return;
  const rating = document.querySelector('[name="review-rating"]:checked')?.value || null;
  $('review-save').disabled = true;
  try {
    const result = await api('/api/jobs/' + id + '/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating, comment: $('review-comment').value }),
    });
    const job = latestJobs.find((j) => j.id === id);
    if (job) job.review = result.review;
    $('review-status').textContent = 'Оценка сохранена';
    reviewStamp = JSON.stringify(result.review);
    if (devMode) await loadDocumentCache();
  } catch (failure) {
    $('review-status').textContent = failure.message;
  } finally {
    $('review-save').disabled = false;
  }
};
async function loadDocumentCache() {
  if (!devMode) return;
  try {
    const result = await api('/api/dev/cache');
    cachedDocuments = result.items;
    cacheEvents = result.events;
    renderDocumentCache();
  } catch (failure) {
    $('cache-summary').textContent = failure.message;
  }
}
function renderDocumentCache() {
  const filter = $('cache-filter').value.trim().toLowerCase();
  const items = cachedDocuments.filter((item) =>
    (item.reference + ' ' + item.title).toLowerCase().includes(filter),
  );
  $('cache-summary').textContent = items.length + ' / ' + cachedDocuments.length;
  const container = $('cache-items');
  container.replaceChildren();
  const table = document.createElement('table');
  table.className = 'cache-table';
  const head = table.createTHead().insertRow();
  for (const label of ['Документ', 'Язык', 'Страницы', 'Оценка', 'Комментарий', 'Действия']) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = label;
    head.append(th);
  }
  const body = table.createTBody();
  for (const item of items) {
    const row = body.insertRow();
    const documentCell = row.insertCell();
    const title = document.createElement('strong');
    title.textContent = item.reference;
    documentCell.append(title);
    if (item.title && item.title !== item.reference) {
      const subtitle = document.createElement('span');
      subtitle.className = 'cache-subtitle';
      subtitle.textContent = item.title.replace(item.reference, '').replace(/^[\s—–:-]+/, '');
      subtitle.title = item.title;
      documentCell.append(subtitle);
    }
    const languageCell = row.insertCell(),
      language = document.createElement('span');
    language.className = 'cache-language';
    language.textContent =
      (item.language || '')
        .split('+')
        .map((code) => ({ eng: 'EN', deu: 'DE', fra: 'FR', rus: 'RU' })[code] || code.toUpperCase())
        .join(' + ') || '—';
    languageCell.append(language);
    const pages = row.insertCell();
    pages.className = 'cache-pages';
    pages.textContent = item.pages || '—';
    const rating = row.insertCell(),
      badge = document.createElement('span');
    badge.className =
      'cache-rating ' +
      (item.review?.rating === 'bad'
        ? 'is-bad'
        : item.review?.rating === 'good' && item.reusable
          ? 'is-good'
          : 'is-neutral');
    badge.textContent =
      item.review?.rating === 'bad'
        ? '✕ Есть проблема'
        : !item.reusable
          ? 'Издание требует проверки'
          : item.review?.rating === 'good'
            ? '✓ Подходит'
            : 'Не оценён';
    rating.append(badge);
    const commentCell = row.insertCell(),
      comment = document.createElement('p');
    comment.className = 'cache-comment';
    comment.textContent = item.review?.comment || '—';
    comment.title = item.review?.comment || '';
    commentCell.append(comment);
    const actionsCell = row.insertCell(),
      actions = document.createElement('div');
    actions.className = 'cache-actions';
    const open = document.createElement('a');
    open.href = '/api/jobs/' + item.id + '/pdf?preview';
    open.target = '_blank';
    open.rel = 'noopener';
    open.textContent = 'PDF ↗';
    open.setAttribute('aria-label', item.reference + ' PDF');
    const review = document.createElement('button');
    review.type = 'button';
    review.className = 'quiet';
    review.textContent = 'Оценить';
    review.onclick = async () => {
      await selectJob(item.id);
      $('document-review').scrollIntoView({ behavior: 'smooth', block: 'center' });
    };
    const reuse = document.createElement('button');
    reuse.type = 'button';
    reuse.className = 'secondary cache-reuse';
    reuse.textContent = 'Получить из кеша';
    reuse.disabled = !item.reusable;
    reuse.onclick = async () => {
      reuse.disabled = true;
      try {
        const job = await api('/api/dev/cache/' + item.id + '/reuse', { method: 'POST' });
        latestJobs.push(job);
        await selectJob(job.id);
        await loadDocumentCache();
      } catch (failure) {
        $('cache-summary').textContent = failure.message;
      } finally {
        reuse.disabled = !item.reusable;
      }
    };
    actions.append(open, review, reuse);
    actionsCell.append(actions);
  }
  if (!items.length) {
    const cell = body.insertRow().insertCell();
    cell.colSpan = 6;
    cell.className = 'cache-empty';
    cell.textContent = filter ? 'Ничего не найдено' : 'В кеше пока нет стандартов';
  }
  container.append(table);
  const log = $('review-log');
  log.replaceChildren();
  for (const event of cacheEvents.slice().reverse()) {
    const row = document.createElement('p');
    row.className = 'cache-comment';
    row.textContent = [
      new Date(event.at).toLocaleString(),
      event.reference,
      event.rating === 'good' ? '✓' : event.rating === 'bad' ? '✕' : '—',
      event.comment,
    ].join(' · ');
    log.append(row);
  }
}
$('cache-refresh').onclick = loadDocumentCache;
$('cache-filter').oninput = renderDocumentCache;
$('document-cache').ontoggle = () => {
  if ($('document-cache').open) void loadDocumentCache();
};
