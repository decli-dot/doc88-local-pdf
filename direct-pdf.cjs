'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { downloadDirect, mergeExport } = require('./experimental/direct-extractor.cjs');
const { ensureConverter, convertSWF } = require('./experimental/converter.cjs');
const { inspectPDF } = require('./experimental/quality.cjs');
const { inspectScripts, sampleIndices } = require('./script-check.cjs');
const { resolve, policy } = require('./dist/ocr-language.js');
const { digest } = require('./page-check.cjs');
const { readJSON, atomicWrite } = require('./checkpoints.cjs');
async function cachedResources(directory, url) {
  const record = await readJSON(path.join(directory, 'download-report.json'));
  if (
    record?.decoderVersion !== 2 ||
    record.preview ||
    record.sourceURL !== url ||
    !record.pages?.length ||
    record.total !== record.pages.length
  )
    return null;
  for (const page of record.pages) {
    if (!/^page\d{5}\.swf$/.test(page.filename)) return null;
    try {
      if (digest(await fs.readFile(path.join(directory, 'swf', page.filename))) !== page.sha256)
        return null;
    } catch {
      return null;
    }
  }
  return record;
}
async function convertDirect(job, dataDirectory) {
  const signal = job.controller.signal;
  signal.throwIfAborted();
  const java = spawnSync('java', ['-version'], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 5000,
  });
  if (java.status !== 0)
    throw Object.assign(Error('Java недоступна для прямого извлечения.'), {
      code: 'DIRECT_UNAVAILABLE',
    });
  const directory = path.join(job.directory, 'direct');
  await fs.mkdir(directory, { recursive: true });
  job.update({ stage: 'opening', message: 'Готовим прямое извлечение документа…' });
  const jar = await ensureConverter(path.join(dataDirectory, 'direct-experiment', 'tools'), signal);
  let report = await cachedResources(directory, job.url);
  const reused = Boolean(report);
  if (!report)
    report = await downloadDirect(job.url, directory, {
      signal,
      concurrency: 4,
      resourceDirectory: path.join(job.directory, 'resource-cache'),
      onProgress(value) {
        job.update({
          stage: 'downloading',
          current: value.current,
          total: value.total,
          message: `Получаем страницы: ${value.current} из ${value.total}`,
        });
      },
    });
  job.update({
    stage: 'merging',
    total: report.total,
    current: report.total,
    message: 'Преобразуем исходные страницы в PDF…',
  });
  const source = path.join(directory, 'source.pdf');
  const stamp = digest(JSON.stringify(report.pages));
  const converted = await readJSON(path.join(directory, 'converted.json'));
  let cacheValid = false;
  try {
    cacheValid =
      converted?.stamp === stamp && converted.sha256 === digest(await fs.readFile(source));
  } catch {
    /* New or interrupted conversion. */
  }
  if (!cacheValid) {
    await convertSWF(jar, path.join(directory, 'swf'), path.join(directory, 'export'), {
      signal,
      workers: 3,
      logFile: path.join(directory, 'conversion.log'),
    });
    await mergeExport(path.join(directory, 'export'), report.total, source);
    await atomicWrite(
      path.join(directory, 'converted.json'),
      JSON.stringify({ version: 2, stamp, sha256: digest(await fs.readFile(source)) }),
    );
  } else if (converted.version !== 2) {
    await mergeExport(path.join(directory, 'export'), report.total, source);
    await atomicWrite(
      path.join(directory, 'converted.json'),
      JSON.stringify({ version: 2, stamp, sha256: digest(await fs.readFile(source)) }),
    );
  }
  signal.throwIfAborted();
  const ocrDirectory = path.join(job.directory, 'ocr');
  await fs.mkdir(ocrDirectory, { recursive: true });
  const language = resolve(job.query, job.ocrLanguage, job.documentLanguage);
  const catalogue = job.catalogueEdition ||
    job.isoEdition || { reference: job.query || '', title: job.title, pageCount: report.total };
  const sampleNumbers = [
    ...new Set([
      1,
      Math.min(2, report.total),
      ...sampleIndices(report.total).map((index) => index + 1),
    ]),
  ].sort((a, b) => a - b);
  const inspectOptions = {
    signal,
    language,
    modelsDirectory: job.cacheDirectory,
    samples: sampleNumbers,
    pageTextDirectory: ocrDirectory,
    onProgress(current, total) {
      job.update({
        stage: 'checking',
        current,
        total,
        message: `Проверяем исходный текст: ${current} из ${total}`,
      });
    },
  };
  let quality = await inspectPDF(source, directory, catalogue, inspectOptions);
  let scriptVerification;
  if (policy(job.query)) {
    const proof = await inspectScripts(
      { ...job, directory: path.join(directory, 'samples') },
      sampleNumbers.map((n) =>
        path.join(directory, 'samples', `page${String(n).padStart(5, '0')}.png`),
      ),
      { sampleAll: true },
    );
    scriptVerification = {
      ...proof,
      evidence: proof.evidence.map((item) => ({ ...item, page: sampleNumbers[item.page - 1] })),
    };
    job.update({ scriptVerification });
    if (proof.status === 'failed')
      throw Object.assign(Error(proof.message), {
        code: 'FOREIGN_SCRIPT',
        verification: scriptVerification,
      });
  }
  if (quality.language.status === 'failed')
    throw Object.assign(Error(quality.language.message), { code: 'FOREIGN_LANGUAGE' });
  if (quality.identity.status === 'failed')
    throw Object.assign(Error(quality.identity.message), { code: 'DOCUMENT_MISMATCH' });
  if (quality.extent.status === 'failed' || quality.pages !== report.total)
    throw Object.assign(Error('Получен неполный документ.'), { code: 'INCOMPLETE_DOCUMENT' });
  const repairPages = [
    ...new Set([
      ...(quality.needsOCR || []),
      ...(quality.identity.status === 'unknown' ? [1, Math.min(2, report.total)] : []),
    ]),
  ].sort((a, b) => a - b);
  let repairedPages = [];
  if (
    quality.language.status === 'passed' &&
    repairPages.length > 0 &&
    repairPages.length <= Math.max(2, Math.min(16, Math.ceil(report.total / 4)))
  ) {
    job.log?.('Direct extraction: OCR repair on pages ' + repairPages.join(', '));
    const repaired = await require('./direct-repair.cjs').repairDirectPages(
      job,
      source,
      path.join(directory, 'repair'),
      repairPages,
    );
    quality = await inspectPDF(repaired, directory, catalogue, {
      ...inspectOptions,
      recognizedPages: repairPages,
    });
    repairedPages = repairPages;
  }
  if (quality.language.status === 'failed')
    throw Object.assign(Error(quality.language.message), { code: 'FOREIGN_LANGUAGE' });
  if (quality.identity.status === 'failed')
    throw Object.assign(Error(quality.identity.message), { code: 'DOCUMENT_MISMATCH' });
  if (quality.extent.status === 'failed')
    throw Object.assign(Error(quality.extent.message), { code: 'INCOMPLETE_DOCUMENT' });
  if (!quality.ready)
    throw Object.assign(
      Error('Исходный текст не прошёл проверку пригодности для поиска. Требуется OCR.'),
      {
        code: 'DIRECT_TEXT_UNUSABLE',
        localPDF: { sha256: digest(await fs.readFile(source)), total: report.total },
      },
    );
  signal.throwIfAborted();
  await fs.copyFile(path.join(directory, 'result.pdf'), path.join(job.directory, 'result.pdf'));
  await fs.copyFile(path.join(directory, 'text.txt'), path.join(job.directory, 'copy-text.txt'));
  const stat = await fs.stat(path.join(job.directory, 'result.pdf'));
  job.update({
    stage: 'done',
    message: 'PDF с исходным текстом готов.',
    total: report.total,
    current: report.total,
    pdfReady: true,
    archiveReady: false,
    pdfFilename: job.officialFilename || 'document.pdf',
    bytes: stat.size,
    textChars: quality.pageDetails.reduce((n, page) => n + page.characters, 0),
    blankPages: quality.pageDetails.filter((item) => item.characters === 0).length,
    textlessPages: quality.pageDetails
      .filter((item) => item.characters === 0)
      .map((item) => item.page),
    identityVerification: quality.identity,
    scriptVerification,
    pageIntegrity: quality.pageIntegrity,
    documentStructure: quality.structure,
    normativeReferences: quality.normativeReferences,
    copyTextReady: true,
    nativeTextPages: report.total - repairedPages.length,
    reusedDownloadPages: reused ? report.total : 0,
    reusedOCRPages: 0,
    repairedOCRPages: repairedPages.length,
    directReport: { ...report, pages: undefined },
  });
}
module.exports = { cachedResources, convertDirect };
