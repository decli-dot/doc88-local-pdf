'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { normalizeQuery } = require('./dist/query.js');
const { digest, inspectPages } = require('./page-check.cjs');
const { validateURL, downloadArchive, convertArchive } = require('./pipeline.cjs');
const {
  reference,
  sameReference,
  resolveLatestISO,
  resolveISOStandard,
  searchURL,
  internationalISOName,
  officialFullTitle,
  officialPDFName,
} = require('./iso-catalog.cjs');

function validateQuery(value) {
  if (
    typeof value !== 'string' ||
    value.trim().length < 3 ||
    value.trim().length > 180 ||
    /[\u0000-\u001f]/.test(value)
  )
    throw new Error('Напиши название документа: от 3 до 180 символов.');
  return normalizeQuery(value);
}
function plain(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(x[\da-f]+|\d+);/gi, (_, number) => {
      const code = number[0].toLowerCase() === 'x' ? parseInt(number.slice(1), 16) : Number(number);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(
      /&(amp|lt|gt|quot|apos|nbsp);/g,
      (_, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[name],
    )
    .replace(/\s+/g, ' ')
    .trim();
}
function titleMatches(query, title) {
  const wanted = reference(query);
  if (wanted)
    return (
      internationalISOName(title) &&
      !/\b(?:DIS|FDIS|DRAFT|TR|TS)\b/i.test(title) &&
      (wanted.supplement || !/\b(?:AMD|AMENDMENT|COR|CORRIGENDUM)\b/i.test(title)) &&
      sameReference(wanted, reference(title))
    );
  const words = query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || [];
  const target = title.toLowerCase();
  return words.length > 0 && words.every((word) => target.includes(word));
}
function parseResults(html, query) {
  const results = [];
  const seen = new Set();
  for (const block of html.split(/<div\s+class=["']sd-list-con["'][^>]*>/i).slice(1)) {
    const anchor = block.match(
      /<a\b(?=[^>]*\bclass=["'][^"']*\bsd-title\b)[^>]*>[\s\S]*?<\/a>/i,
    )?.[0];
    if (!anchor) continue;
    let url;
    try {
      url = validateURL(plain(anchor.match(/\bhref=["']([^"']+)["']/i)?.[1]));
    } catch {
      continue;
    }
    const title = plain(anchor.match(/\btitle=["']([^"']*)["']/i)?.[1] || anchor);
    if (seen.has(url) || !titleMatches(query, title)) continue;
    seen.add(url);
    const pageCount = Number(block.match(/页数[：:]\s*(\d+)/)?.[1]) || null;
    const format = plain(block.match(/格式[：:]\s*([^<\s]+)/)?.[1]).toUpperCase();
    results.push({ url, title, pageCount, format, status: 'unverified', checks: null });
  }
  return results
    .sort((a, b) => Number(b.format === 'PDF') - Number(a.format === 'PDF'))
    .slice(0, 8);
}
async function searchDocuments(query, signal, fetcher = fetch) {
  query = validateQuery(query);
  const searchURL = new URL('https://www.doc88.com/search/post.do');
  searchURL.search = new URLSearchParams({
    from: '1',
    f: '0',
    h: '1',
    pageRange: '0',
    pageNum: '0',
    format: '',
    p: '1',
    q: query.replace(/:/g, ' '),
    sDate: '',
    eDate: '',
    ct: '0',
  }).toString();
  const response = await fetcher(searchURL, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
    redirect: 'error',
    headers: { Accept: 'text/html', Referer: 'https://www.doc88.com/' },
  });
  if (!response.ok)
    throw new Error(`Поиск Doc88 недоступен: HTTP ${response.status}. Попробуй позже.`);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 3 * 1024 * 1024) throw new Error('Doc88 вернул слишком большой ответ поиска.');
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel();
  }
  const html = Buffer.concat(chunks).toString('utf8');
  if (!/sd-list-con|pageResult/.test(html))
    throw new Error(
      'Doc88 не вернул результаты поиска. Возможно, нужен вход или подтверждение на сайте.',
    );
  return parseResults(html, query);
}

const functionWords = new Set(
  'the of and to a in is for as that with be by or are this an on from shall which it not can may at these has have such'.split(
    ' ',
  ),
);
async function analyseTextPages(texts) {
  const { franc } = await import('franc-min');
  const repeated = new Map();
  const key = (line) => line.trim().toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ');
  for (const text of texts)
    for (const line of new Set(
      text
        .split('\n')
        .map(key)
        .filter((line) => line.length > 8),
    ))
      repeated.set(line, (repeated.get(line) || 0) + 1);
  let englishChars = 0,
    otherChars = 0,
    englishPages = 0,
    otherPages = 0;
  const evidence = [];
  for (let index = 0; index < texts.length; index++) {
    const text = texts[index]
      .split('\n')
      .filter(
        (line) => (repeated.get(key(line)) || 0) < Math.max(3, Math.ceil(texts.length * 0.35)),
      )
      .join('\n');
    const letters = text.match(/\p{L}/gu)?.length || 0;
    if (letters < 150) continue;
    const words = text.toLowerCase().match(/[a-z]+/g) || [];
    const common = words.filter((word) => functionWords.has(word));
    const language = franc(text, { minLength: 200 });
    const latin = (text.match(/[A-Za-z]/g)?.length || 0) / letters;
    const commonRatio = common.length / Math.max(words.length, 1);
    const english =
      language === 'eng' ||
      (latin > 0.9 && common.length >= 6 && new Set(common).size >= 4 && commonRatio >= 0.08);
    const clearlyForeign =
      !english &&
      (latin < 0.5 ||
        (['fra', 'deu', 'spa', 'por', 'ita', 'rus', 'cmn', 'jpn', 'kor'].includes(language) &&
          commonRatio < 0.05));
    if (english) {
      englishChars += letters;
      englishPages++;
    } else if (clearlyForeign) {
      otherChars += letters;
      otherPages++;
    }
    evidence.push({ page: index + 1, language, english, clearlyForeign });
  }
  const total = englishChars + otherChars;
  const ratio = total ? englishChars / total : 0;
  const status =
    englishChars >= 250 && ratio >= 0.4
      ? 'passed'
      : otherChars >= 800 && otherPages >= 2 && englishPages === 0
        ? 'failed'
        : 'unknown';
  return {
    status,
    englishPages,
    otherPages,
    checkedPages: evidence.length,
    totalPages: texts.length,
    evidence,
    message:
      status === 'passed'
        ? `Английский текст распознан на ${englishPages} стр.; повторяющиеся колонтитулы исключены.`
        : status === 'failed'
          ? 'Основной распознанный текст не на английском.'
          : 'Язык не удалось определить уверенно. PDF сохранён; проверь язык вручную.',
  };
}
function identityCheck(query, texts) {
  const wanted = reference(query);
  if (!wanted)
    return { status: 'passed', message: 'Название соответствует запросу в поиске Doc88.' };
  const national =
    String(texts[0] || '').match(
      /\b(?:(?:BS|DIN|EN|NF|NEN|SIST|EVS|UNE|ABNT|NBR|JIS|ГОСТ)[\s/-]+)+(ISO\s*(?:\/\s*IEC\s*)?\d{3,6}\s*(?:-\s*\d{1,3})?\s*[: -]\s*(?:19|20)\d{2})/g,
    ) || [];
  if (
    national.some((value) => sameReference({ ...wanted, supplement: undefined }, reference(value)))
  )
    return {
      status: 'failed',
      message:
        'На обложке указана национальная или европейская адаптация ISO. Для этого поиска нужен международный ISO.',
    };
  const snippets =
    texts
      .slice(0, 4)
      .join('\n')
      .replace(/IS0/g, 'ISO')
      .match(
        /ISO\s*(?:\/\s*IEC\s*)?\d{3,6}\s*(?:-\s*\d{1,3})?\s*[:\- ]\s*(?:19|20)\d{2}(?:\s*[\/+]?\s*(?:AMD|AMENDMENT|COR|CORRIGENDUM)\.?\s*\d+\s*[:\- ]\s*(?:19|20)\d{2})?/gi,
      ) || [];
  const passed = snippets.some((value) => sameReference(wanted, reference(value)));
  return {
    status: passed ? 'passed' : 'unknown',
    message: passed
      ? 'Обозначение и год из запроса найдены внутри документа.'
      : 'Не удалось подтвердить обозначение и год внутри документа.',
  };
}
function isoExtentCheck(pages, edition) {
  const expected = edition?.pageCount;
  if (!Number.isSafeInteger(expected) || expected < 1)
    return {
      status: 'unknown',
      pages: pages || null,
      officialPages: null,
      message:
        'Число страниц в каталоге ISO не получено. Полнота издания не подтверждена; повтори поиск позже.',
    };
  if (!Number.isSafeInteger(pages) || pages < 1)
    return {
      status: 'unknown',
      pages: null,
      officialPages: expected,
      message: `Каталог ISO: ${expected} стр. Число страниц документа ещё не подтверждено.`,
    };
  return {
    status: pages >= expected ? 'passed' : 'failed',
    pages,
    officialPages: expected,
    message:
      pages >= expected
        ? `В PDF ${pages} стр.; в каталоге ISO — ${expected}. Объём не меньше официального. Обложка и вводные страницы могут увеличивать число страниц PDF.`
        : `Сокращённый документ: ${pages} стр., в каталоге ISO — ${expected}. Этот вариант отклонён.`,
  };
}
async function runSearchJob(job, dataDirectory, options = {}) {
  const assertActive = () => {
    if (job.controller.signal.aborted) throw new Error('Обработка остановлена.');
  };
  let query = validateQuery(job.resolvedQuery || job.query);
  const wanted = reference(query);
  if (wanted && !wanted.year) {
    job.update({
      stage: 'resolving',
      isoLookupURL: searchURL(wanted),
      message: 'Уточняем действующее издание в официальном каталоге ISO…',
    });
    const edition = await (options.resolveISO || resolveLatestISO)(wanted, {
      signal: job.controller.signal,
      dataDirectory,
    });
    assertActive();
    query = edition.reference;
    job.update({ resolvedQuery: query, isoEdition: edition, title: query });
  } else if (
    wanted?.year &&
    !(
      job.isoEdition?.title &&
      Number.isSafeInteger(job.isoEdition.pageCount) &&
      job.isoEdition.pageCount > 0 &&
      sameReference(wanted, reference(job.isoEdition.reference))
    )
  ) {
    job.update({
      stage: 'resolving',
      isoLookupURL: searchURL(wanted),
      message: 'Получаем официальное название и число страниц из каталога ISO…',
    });
    try {
      const edition = await (options.lookupISO || resolveISOStandard)(wanted, {
        signal: job.controller.signal,
        dataDirectory,
        onProgress: (message) => job.update({ message }),
      });
      assertActive();
      job.update({ isoEdition: edition, namingWarning: null });
    } catch (error) {
      assertActive();
      if (error.code === 'ISO_SUPPLEMENT_NOT_FOUND') throw error;
      if (error.code === 'ISO_EDITION_NOT_FOUND' && error.editions?.length) {
        job.update({
          stage: 'choosing',
          message: error.message,
          requestedReference: error.requestedReference,
          isoChoices: error.editions,
          isoHistoryIncomplete: Boolean(error.incomplete),
          pdfReady: false,
          archiveReady: false,
        });
        return;
      }
      job.update({
        namingWarning:
          'Не удалось получить данные издания ISO. Проверка полного объёма недоступна; варианты не будут отмечены как подходящие.',
      });
    }
  }
  job.update({ stage: 'searching', message: `Ищем ${query} на Doc88…` });
  const candidates = (
    options.candidates ||
    (options.resume && job.searchResults?.length
      ? job.searchResults
      : await (options.search || searchDocuments)(query, job.controller.signal))
  ).filter((candidate) => titleMatches(query, candidate.title));
  job.update({ searchResults: candidates });
  if (options.candidates && !candidates.length)
    throw new Error(
      `Выбранный вариант не соответствует ${query}. Запусти поиск заново; для старого издания укажи год явно.`,
    );
  if (!candidates.length)
    throw new Error(
      'На Doc88 не найдено документов с таким названием и годом. Попробуй изменить запрос.',
    );
  const iso = reference(query);
  // Reject clearly shortened uploads before spending time or the OCR budget on
  // them. Preserve their source links and the reason in the search results.
  const eligible = [];
  for (const candidate of candidates) {
    if (options.resume && candidate.status === 'rejected') continue;
    if (iso) {
      const extent = isoExtentCheck(candidate.pageCount, job.isoEdition);
      if (extent.status === 'failed' || !extent.officialPages) {
        candidate.status = 'rejected';
        candidate.checks = { extent };
        continue;
      }
    }
    eligible.push(candidate);
  }
  job.update({ searchResults: candidates });
  const checks = Math.min(eligible.length, options.maxCandidates || 3);
  for (let index = 0; index < checks; index++) {
    assertActive();
    const candidate = eligible[index];
    candidate.status = 'checking';
    job.update({
      candidateIndex: index + 1,
      candidateCount: checks,
      searchResults: candidates,
      pdfReady: false,
      archiveReady: false,
      total: 0,
      current: 0,
    });
    const child = {
      directory: path.join(job.directory, 'candidates', digest(candidate.url).slice(0, 24)),
      cacheDirectory: job.cacheDirectory,
      controller: job.controller,
      url: candidate.url,
      title: candidate.title,
      fromPage: 1,
      toPage: null,
      enhanceImages: job.enhanceImages !== false,
      officialPages: job.isoEdition?.pageCount,
      log: job.log,
      update(value) {
        Object.assign(this, value);
        const { stage, message, current, total } = this;
        job.update({
          stage: stage === 'done' ? 'checking' : stage,
          current: current || 0,
          total: total || 0,
          challengeAvailable: Boolean(this.challengeAvailable),
          message: `Вариант ${index + 1} из ${checks}. ${stage === 'done' ? 'Проверяем язык документа…' : message || ''}`,
        });
      },
    };
    try {
      await fs.mkdir(child.directory, { recursive: true });
      await (options.download || downloadArchive)(
        child,
        dataDirectory,
        options.downloadOptions || {},
      );
      if (wanted || reference(query)) {
        const edition = job.isoEdition?.title ? job.isoEdition : { reference: query };
        child.officialTitle = officialFullTitle(edition);
        child.officialFilename = officialPDFName(edition);
        child.title = child.officialTitle;
      }
      await (options.convert || convertArchive)(child);
      assertActive();
      job.update({
        stage: 'checking',
        message: 'Проверяем язык, издание и доступность всех страниц…',
      });
      const texts = await Promise.all(
        Array.from({ length: child.total }, (_, i) =>
          fs.readFile(
            path.join(child.directory, 'ocr', `page${String(i + 1).padStart(5, '0')}.txt`),
            'utf8',
          ),
        ),
      );
      const language = await analyseTextPages(texts);
      assertActive();
      const identity = identityCheck(query, texts);
      const complete =
        child.total > 0 && (!candidate.pageCount || child.total === candidate.pageCount);
      const completeness = {
        status: complete ? 'passed' : 'failed',
        pages: child.total,
        declaredPages: candidate.pageCount || child.total,
        message: complete
          ? `Загружено страниц: ${child.total} из ${child.total}, заявленных Doc88. Каждая сохранена и включена в PDF.`
          : `В поиске заявлено ${candidate.pageCount} страниц, получено ${child.total}. Полнота не подтверждена.`,
      };
      const extent = iso ? isoExtentCheck(child.total, job.isoEdition) : null;
      const pageIntegrity =
        child.pageIntegrity || inspectPages(texts, [], job.isoEdition?.pageCount);
      candidate.checks = {
        language,
        completeness,
        identity,
        ...(extent ? { extent } : {}),
        pageIntegrity,
      };
      candidate.status =
        [completeness, identity, ...(extent ? [extent] : [])].every(
          (check) => check.status === 'passed',
        ) &&
        language.status !== 'failed' &&
        pageIntegrity.status !== 'failed'
          ? 'passed'
          : 'rejected';
      job.update({ searchResults: candidates });
      if (candidate.status !== 'passed') continue;
      await fs.copyFile(
        path.join(child.directory, 'archive.zip'),
        path.join(job.directory, 'archive.zip'),
      );
      await fs.copyFile(
        path.join(child.directory, 'result.pdf'),
        path.join(job.directory, 'result.tmp'),
      );
      assertActive();
      await fs.rename(
        path.join(job.directory, 'result.tmp'),
        path.join(job.directory, 'result.pdf'),
      );
      assertActive();
      job.update({
        stage: 'done',
        title: child.officialTitle || candidate.title,
        sourceTitle: candidate.title,
        url: candidate.url,
        total: child.total,
        current: child.total,
        pdfReady: true,
        archiveReady: true,
        pdfFilename: child.pdfFilename,
        archiveFilename: child.archiveFilename,
        bytes: child.bytes,
        textChars: child.textChars,
        blankPages: child.blankPages,
        verification: candidate.checks,
        pageIntegrity,
        documentStructure: child.documentStructure,
        normativeReferences: child.normativeReferences,
        imageEnhancement: child.imageEnhancement,
        reusedDownloadPages: child.reusedDownloadPages || 0,
        reusedOCRPages: child.reusedOCRPages || 0,
        searchResults: candidates,
        message:
          pageIntegrity.status === 'unknown' || language.status === 'unknown'
            ? 'PDF готов. ' +
              [
                ...(pageIntegrity.status === 'unknown'
                  ? ['Нумерация требует ручной проверки.']
                  : []),
                ...(language.status === 'unknown'
                  ? ['Язык распознан неуверенно; проверь его вручную.']
                  : []),
              ].join(' ')
            : iso
              ? 'PDF готов: английский текст, объём по ISO и загрузка всех страниц Doc88 проверены.'
              : 'Подходящий документ найден: английский текст и все страницы Doc88 проверены. PDF готов.',
        finishedAt: new Date().toISOString(),
      });
      return;
    } catch (error) {
      if (job.controller.signal.aborted) {
        candidate.status = 'cancelled';
        candidate.error = 'Проверка остановлена.';
        job.update({ searchResults: candidates });
      }
      assertActive();
      candidate.status = 'error';
      candidate.error = error.message;
      job.update({ searchResults: candidates });
    }
  }
  throw new Error(
    'Среди проверенных вариантов пока нет документа с подтверждённым английским текстом и всеми страницами. Причины указаны в результатах поиска.',
  );
}
module.exports = {
  validateQuery,
  reference,
  titleMatches,
  parseResults,
  searchDocuments,
  analyseTextPages,
  identityCheck,
  isoExtentCheck,
  runSearchJob,
};
