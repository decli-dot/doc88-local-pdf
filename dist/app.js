'use strict';
const $ = (id) => document.getElementById(id);
const { normalizeQuery } = window.Doc88Query;
const completeStages = new Set(['done', 'error', 'cancelled', 'interrupted']);
const stageNames = {
  queued: 'В очереди',
  interrupted: 'Прервано',
  resolving: 'Уточняем издание',
  choosing: 'Выбери издание',
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
let selectedId = localStorage.getItem('doc88-selected');
let selectedFile = null;
let uploading = false;
let latestJobs = [];
let offline = false;
let lastHistory = '';
let lastSearch = '';
let postingSearch = false;
let activeId = null;
let followActive = true;
let latestBatches = [];
let lastBatches = '';
const modes = ['search', 'batch', 'url', 'zip'];
let editionKey = '';
let editionJobId = null;
let editionPosting = false;
let detailsKey = '',
  supplementsKey = '';

function renderDocumentDetails(job) {
  const structure = job?.documentStructure,
    references = job?.normativeReferences;
  $('document-details').hidden = !job?.pdfReady || (!structure && !references);
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
      link.href = `/api/jobs/${job.id}/pdf?preview=1#page=${node.page}`;
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
    !Array.isArray(edition?.supplements) || /\/(?:Amd|Cor)\b/i.test(edition?.reference || '');
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
  try {
    const batch = await api('/api/batches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ queries, enhanceImages: $('enhance-images').checked }),
    });
    selectedId = batch.items[0]?.id;
    followActive = true;
    if (selectedId) localStorage.setItem('doc88-selected', selectedId);
    await refresh();
  } catch (failure) {
    $('references-message').textContent = failure.message;
    $('find-references').disabled = false;
  }
};

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
    $('edition-description').textContent = job.message;
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
        (edition.status === 'Published' ? 'Действующее издание' : 'Отозвано') +
        (edition.relation === 'predecessor' ? ' · другое обозначение в истории' : '') +
        (edition.pageCount ? ` · ${edition.pageCount} стр. по ISO` : '');
      const title = document.createElement('span');
      title.className = 'edition-title';
      title.textContent = edition.title || '';
      text.append(reference, status, title);
      label.append(radio, text);
      const source = document.createElement('a');
      source.href = edition.sourceURL;
      source.target = '_blank';
      source.rel = 'noopener';
      source.textContent = 'Карточка на ISO ↗';
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
  localStorage.setItem('doc88-mode', mode);
  for (const name of modes) {
    const chosen = mode === name;
    $(name + '-tab').setAttribute('aria-selected', String(chosen));
    $(name + '-tab').tabIndex = chosen ? 0 : -1;
    $(name + '-panel').hidden = !chosen;
  }
  error('');
}
for (const mode of modes) {
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
  renderDocumentDetails(job);
  renderSupplements(job);
  renderEditionChoice(job);
  window.Doc88Challenge?.render(job);
  $('empty-state').hidden = !!job;
  $('job-state').hidden = !job;
  $('status-pill').textContent = job ? stageNames[job.stage] : 'Ожидание';
  $('status-pill').dataset.status = job?.stage || 'idle';
  if (!job) return;
  $('job-title').textContent = job.title;
  $('naming-warning').hidden = !job.namingWarning;
  $('naming-warning').textContent = job.namingWarning || '';
  const edition = job.isoEdition;
  const legacyExtent =
    job.kind === 'search' && edition && job.stage === 'done' && !job.verification?.extent;
  if (legacyExtent) {
    $('status-pill').textContent = 'Нужна проверка';
    $('status-pill').dataset.status = 'waiting';
  }
  const isoURL = edition?.sourceURL || job.isoLookupURL;
  $('iso-edition').hidden = !isoURL;
  if (isoURL) {
    $('iso-edition-label').textContent = edition
      ? edition.status === 'Published'
        ? 'Опубликованное издание по ISO'
        : 'Указанное издание по каталогу ISO'
      : 'Уточнение издания в каталоге ISO';
    $('iso-edition-link').href = isoURL;
    $('iso-edition-link').textContent = edition ? edition.reference + ' ↗' : 'Открыть поиск ISO ↗';
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
      ? `Каталог ISO: ${edition.pageCount} стр.${job.stage === 'done' ? ` · PDF: ${job.total} стр.` : ''}`
      : 'Число страниц по каталогу ISO ещё не подтверждено.';
  }
  $('job-message').textContent = legacyExtent
    ? 'Этот PDF создан до добавления сверки объёма по ISO. Повтори поиск, чтобы проверить, что это не сокращённый документ.'
    : job.message;
  const end = completeStages.has(job.stage);
  const step =
    job.stage === 'done' ? 2 : ['ocr', 'merging', 'checking'].includes(job.stage) ? 1 : 0;
  document.querySelectorAll('.steps>div').forEach((element, index) => {
    element.classList.toggle('active', index === step);
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
  $('progress').hidden = job.stage === 'choosing' || (end && job.stage !== 'done');
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
  $('pdf-download').download = job.pdfFilename || 'document.pdf';
  $('pdf-preview').href = `/api/jobs/${job.id}/pdf?preview=1`;
  $('zip-download').href = `/api/jobs/${job.id}/zip`;
  $('zip-download').hidden = !job.archiveReady;
  $('source-document').hidden = job.kind !== 'search' || !job.pdfReady;
  $('source-document').href = job.url || '#';
  $('cancel').hidden = end;
  $('cancel').disabled = false;
  $('resume').hidden = !job.canResume;
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
function renderSearch(job) {
  const results = job?.searchResults || [];
  $('search-results-section').hidden = !results.length;
  const busy = !!activeId || uploading || postingSearch;
  const key = JSON.stringify([job?.id, results, busy]);
  if (key === lastSearch) return;
  lastSearch = key;
  $('search-results-list').replaceChildren();
  const requiresExtent = Boolean(job?.isoEdition || job?.isoLookupURL);
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
    const link = document.createElement('a');
    link.textContent = result.title;
    link.href = result.url;
    link.target = '_blank';
    link.rel = 'noopener';
    heading.append(link);
    const meta = document.createElement('p');
    meta.className = 'helper';
    meta.textContent = `${result.format || 'Документ'} · ${result.pageCount ? result.pageCount + ' стр.' : 'Число страниц уточняется'} · ${status === 'checking' ? 'Идёт проверка' : status === 'passed' ? 'Подходит' : status === 'unverified' ? 'Ещё не проверен' : 'Проверка не пройдена'}`;
    const badges = document.createElement('div');
    badges.className = 'check-badges';
    for (const [name, label] of [
      ['language', 'Английский'],
      ['completeness', 'Страницы Doc88'],
      ...(requiresExtent ? [['extent', 'Объём ISO']] : []),
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
    const source = document.createElement('a');
    source.className = 'text-link';
    source.textContent = 'Открыть на Doc88 ↗';
    source.href = result.url;
    source.target = '_blank';
    source.rel = 'noopener';
    actions.append(source);
    if (status === 'passed' && job.pdfReady) {
      const pdf = document.createElement('a');
      pdf.className = 'text-link';
      pdf.textContent = 'Скачать проверенный PDF ↓';
      pdf.href = `/api/jobs/${job.id}/pdf`;
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
    enhanceImages: $('enhance-images').checked,
  };
  postingSearch = true;
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
  try {
    const batch = await api('/api/batches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        queries: $('batch-queries').value,
        enhanceImages: $('enhance-images').checked,
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
  }
};
function renderBatches() {
  $('batch-section').hidden = !latestBatches.length;
  const key = JSON.stringify([
    latestBatches.map((batch) => [
      batch.id,
      batch.ready,
      batch.status,
      batch.items.map((item) => [
        item.id,
        item.stage,
        item.pdfReady,
        item.canResume,
        item.pageCheckStatus,
      ]),
    ]),
    selectedId,
  ]);
  if (key === lastBatches) return;
  lastBatches = key;
  $('batch-list').replaceChildren();
  for (const batch of latestBatches) {
    const card = document.createElement('article');
    card.className = 'batch-card';
    const heading = document.createElement('h3');
    heading.textContent = `Готово ${batch.ready} из ${batch.total}${batch.waiting ? ` · ждут выбора издания: ${batch.waiting}` : ''}`;
    card.append(heading);
    const actions = document.createElement('div');
    actions.className = 'batch-actions';
    if (batch.ready) {
      const link = document.createElement('a');
      link.className = 'primary';
      link.href = `/api/batches/${batch.id}/zip`;
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
        item.stage === 'done' && item.pageCheckStatus !== 'passed'
          ? 'Готово · проверь страницы'
          : stageNames[item.stage] || item.stage;
      choose.append(title, status);
      choose.onclick = () => void selectJob(item.id);
      row.append(choose);
      if (item.stage === 'choosing' || item.stage === 'waiting' || item.canResume) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'secondary';
        button.textContent =
          item.stage === 'choosing'
            ? 'Выбрать издание'
            : item.stage === 'waiting'
              ? 'Показать проверку'
              : 'Продолжить';
        button.onclick = () =>
          ['choosing', 'waiting'].includes(item.stage)
            ? void selectJob(item.id)
            : void continueJob(item.id);
        row.append(button);
      }
      if (item.pdfReady) {
        const link = document.createElement('a');
        link.className = 'text-link';
        link.href = `/api/jobs/${item.id}/pdf`;
        link.textContent = 'PDF ↓';
        row.append(link);
      }
      card.append(row);
    }
    $('batch-list').append(card);
  }
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
    activeId = state.activeId;
    latestBatches = state.batches || [];
    $('engine-status').textContent =
      state.ocr === 'ready' ? 'Готов к работе' : 'Модель загрузится при первом запуске';
    if (state.activeId && followActive && !$('edition-dialog').open) selectedId = state.activeId;
    if (!latestJobs.some((job) => job.id === selectedId)) {
      if (selectedId) {
        try {
          latestJobs.push(await api(`/api/jobs/${selectedId}`));
        } catch {
          selectedId = latestJobs[0]?.id || null;
        }
      } else selectedId = latestJobs[0]?.id || null;
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
      body: JSON.stringify({
        url,
        fromPage: $('from-page').value,
        toPage: $('to-page').value,
        enhanceImages: $('enhance-images').checked,
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
        'x-doc88-enhance': $('enhance-images').checked ? '1' : '0',
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
  new URLSearchParams(location.search).get('mode') || localStorage.getItem('doc88-mode');
if (modes.includes(initialMode)) chooseTab(initialMode);
void refresh();
setInterval(refresh, 1000);
