'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path');
const { spawnSync } = require('node:child_process');
const { downloadDirect, mergeExport } = require('./experimental/direct-extractor.cjs');
const { ensureConverter, convertSWF } = require('./experimental/converter.cjs');
const { repairDirectPages } = require('./direct-repair.cjs');
const { inspectScripts } = require('./script-check.cjs');
const { atomicWrite, readJSON } = require('./checkpoints.cjs');
const { digest } = require('./page-check.cjs');
async function previewCandidate(job, dataDirectory, catalogue, { conversionWorkers = 2 } = {}) {
  const signal = job.controller.signal;
  signal.throwIfAborted();
  if (spawnSync('java', ['-version'], { windowsHide: true, timeout: 5000 }).status !== 0)
    throw Object.assign(Error('Ранняя проверка недоступна без конвертера.'), {
      code: 'PREVIEW_UNAVAILABLE',
    });
  const directory = path.join(job.directory, 'preview');
  await fs.mkdir(directory, { recursive: true });
  job.update({ stage: 'checking', message: 'Проверяем первые страницы документа…' });
  const report = await downloadDirect(job.url, directory, {
    signal,
    previewPages: 3,
    concurrency: 4,
    resourceDirectory: path.join(job.directory, 'resource-cache'),
  }).catch((error) => {
    if (/Invalid document extent/.test(error.message)) error.code = 'INCOMPLETE_DOCUMENT';
    throw error;
  });
  if (catalogue?.pageCount && report.declaredTotal < catalogue.pageCount)
    throw Object.assign(Error('Число страниц источника меньше объёма издания.'), {
      code: 'INCOMPLETE_DOCUMENT',
    });
  const source = path.join(directory, 'source.pdf');
  const stamp = digest(JSON.stringify(report.pages)),
    converted = await readJSON(path.join(directory, 'converted.json'));
  let reusable = false;
  try {
    reusable = converted?.stamp === stamp && converted.sha256 === digest(await fs.readFile(source));
  } catch {
    /* No complete conversion yet. */
  }
  if (!reusable) {
    const jar = await ensureConverter(
      path.join(dataDirectory, 'direct-experiment', 'tools'),
      signal,
    );
    await convertSWF(jar, path.join(directory, 'swf'), path.join(directory, 'export'), {
      signal,
      workers: conversionWorkers,
      logFile: path.join(directory, 'conversion.log'),
    });
    await mergeExport(path.join(directory, 'export'), report.total, source);
    await atomicWrite(
      path.join(directory, 'converted.json'),
      JSON.stringify({ stamp, sha256: digest(await fs.readFile(source)) }),
    );
  }
  const numbers = [1, 2, 3].filter((n) => n <= report.total);
  const textDirectory = path.join(directory, 'text');
  const quality = await require('./experimental/quality.cjs').inspectPDF(
    source,
    path.join(directory, 'native'),
    catalogue || { reference: job.query, title: job.title },
    {
      signal,
      samples: numbers,
      language: job.ocrLanguage,
      pageTextDirectory: textDirectory,
      preflight: true,
    },
  );
  const images = numbers.map((n) =>
    path.join(directory, 'native/samples', `page${String(n).padStart(5, '0')}.png`),
  );
  const proof = await inspectScripts(
    { ...job, directory: path.join(directory, 'native') },
    images,
    { sampleAll: true },
  );
  const script = {
    ...proof,
    evidence: proof.evidence.map((item) => ({ ...item, page: numbers[item.page - 1] })),
  };
  if (script.status === 'failed')
    throw Object.assign(Error(script.message), { code: 'FOREIGN_SCRIPT', verification: script });
  const texts = await Promise.all(
    Array.from({ length: report.total }, (_, i) =>
      fs.readFile(path.join(textDirectory, `page${String(i + 1).padStart(5, '0')}.txt`), 'utf8'),
    ),
  );
  const { analyseTextPages, identityCheck } = require('./search.cjs');
  let identity = identityCheck(job.query, texts);
  let language = await analyseTextPages(texts.length > 2 ? texts.slice(2) : texts, job.ocrLanguage);
  const repair =
    language.status === 'unknown'
      ? numbers.slice(0, 2)
      : language.status !== 'failed' && identity.status === 'unknown'
        ? [1, Math.min(2, report.total)]
        : [];
  if (repair.length) {
    const unique = [...new Set(repair)];
    await repairDirectPages(job, source, path.join(directory, 'ocr-preview'), unique);
    for (const [index, number] of unique.entries())
      texts[number - 1] = await fs.readFile(
        path.join(directory, 'ocr-preview/ocr', `page${String(index + 1).padStart(5, '0')}.txt`),
        'utf8',
      );
    identity = identityCheck(job.query, texts);
    language = await analyseTextPages(texts.length > 2 ? texts.slice(2) : texts, job.ocrLanguage);
  }
  if (language.status === 'unknown') {
    const all = await analyseTextPages(texts, job.ocrLanguage);
    if (all.status === 'passed') language = all;
  }
  const result = {
    samplePages: numbers,
    ocrPages: repair,
    declaredPages: report.declaredTotal,
    language,
    identity,
    scriptVerification: script,
    nativePages: report.total - quality.needsOCR.length,
  };
  await atomicWrite(path.join(directory, 'verification.json'), JSON.stringify(result, null, 2));
  job.previewVerification = result;
  if (script.status === 'failed')
    throw Object.assign(Error(script.message), { code: 'FOREIGN_SCRIPT', verification: script });
  if (language.status === 'failed')
    throw Object.assign(
      Error(
        language.machineTranslation
          ? language.message
          : 'Первые страницы написаны на другом языке.',
      ),
      {
        code: 'FOREIGN_LANGUAGE',
      },
    );
  if (identity.status === 'failed')
    throw Object.assign(Error(identity.message), { code: 'DOCUMENT_MISMATCH' });
  return result;
}
module.exports = { previewCandidate };
