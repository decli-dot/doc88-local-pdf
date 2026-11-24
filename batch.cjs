'use strict';
const { createReadStream } = require('node:fs');
const path = require('node:path');
const { dependency } = require('./runtime.cjs');
const { validateQuery } = require('./search.cjs');
const { name: productName, displayText } = require('./dist/product.js');
const JSZip = dependency('jszip');
function validateBatch(value) {
  const lines = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/\r?\n/)
      : [];
  const values = lines.filter((line) => typeof line !== 'string' || line.trim());
  if (!values.length || values.length > 30)
    throw Error('Добавь от 1 до 30 документов, каждый с новой строки.');
  return [
    ...new Map(
      values.map((value) => {
        const query = validateQuery(value);
        return [query.toLowerCase(), query];
      }),
    ).values(),
  ];
}
function summarizeBatch(batch, jobs, snapshot) {
  const members = batch.jobIds.map((id) => jobs.get(id)).filter(Boolean);
  const items = members.map((job) => {
    const value = snapshot(job);
    return {
      id: job.id,
      query: job.query,
      title: job.title,
      stage: job.stage,
      message: job.message,
      canResume: value.canResume,
      pdfReady: Boolean(job.pdfReady && job.stage === 'done'),
      documentLanguage: job.documentLanguage || null,
      pageCheckStatus: job.pageIntegrity?.status || 'unknown',
    };
  });
  const ready = items.filter((item) => item.pdfReady).length;
  const waiting = items.filter((item) =>
    ['choosing', 'selecting', 'language'].includes(item.stage),
  ).length;
  const busy = items.some(
    (item) =>
      !['done', 'error', 'cancelled', 'interrupted', 'choosing', 'selecting', 'language'].includes(
        item.stage,
      ),
  );
  return {
    ...batch,
    items,
    total: items.length,
    ready,
    waiting,
    resumable: items.filter((item) => item.canResume).length,
    status: busy ? 'running' : waiting ? 'waiting' : ready === items.length ? 'done' : 'partial',
  };
}
function batchZip(batch, jobs, diagnostics = false) {
  const zip = new JSZip();
  const names = new Set();
  const report = [productName, `Создано: ${batch.createdAt}`, ''];
  for (const id of batch.jobIds) {
    const job = jobs.get(id);
    if (!job) continue;
    const labels = {
      done: 'Готово',
      error: 'Ошибка',
      cancelled: 'Остановлено',
      interrupted: 'Прервано',
      choosing: 'Нужен выбор издания',
      language: 'Нужен выбор языка',
      selecting: 'Нужен выбор документов',
      queued: 'В очереди',
    };
    report.push(
      `${job.query}${job.resolvedQuery ? ' → ' + job.resolvedQuery : ''}: ${labels[job.stage] || 'Обрабатывается'}`,
      ...(diagnostics ? [displayText(job.message)] : []),
      '',
    );
    if (job.stage !== 'done' || !job.pdfReady) continue;
    const original = pdfFilename(job).replace(/[\\/]/g, '_');
    let name = original,
      number = 2;
    while (names.has(name.toLowerCase())) name = original.replace(/\.pdf$/i, ` (${number++}).pdf`);
    names.add(name.toLowerCase());
    zip.file(name, createReadStream(path.join(job.directory, 'result.pdf')));
  }
  zip.file('Отчёт.txt', report.join('\r\n'));
  return zip.generateNodeStream({ streamFiles: true, compression: 'DEFLATE' });
}
function pdfFilename(job) {
  const original = displayText(job.pdfFilename || 'document.pdf');
  const suffix = { eng: 'EN', deu: 'DE', fra: 'FR', rus: 'RU' }[job.documentLanguage];
  return job.multilingual && suffix ? original.replace(/\.pdf$/i, ` [${suffix}].pdf`) : original;
}
module.exports = { validateBatch, summarizeBatch, batchZip, pdfFilename };
