'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const ocrPolicy = require('./dist/ocr-language.js');
const designation = require('./dist/standard-reference.js');
const { normalizeQuery } = require('./dist/query.js');
const { digest, inspectPages } = require('./page-check.cjs');
const { validateURL, downloadArchive, convertArchive } = require('./pipeline.cjs');
const { processDocument } = require('./document-engine.cjs');
const { createTimings } = require('./timing.cjs');
const { createPreviewPool } = require('./preview-pool.cjs');
const { loadSharedCache, saveSharedCache } = require('./shared-cache.cjs');
const SEARCH_VERSION = 4;
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
  const other = designation.parse(query);
  const wanted = reference(query);
  if (other || wanted) {
    const prefix = other?.prefix || wanted.organization;
    const number = other?.number || wanted.number + (wanted.part ? '-' + wanted.part : '');
    const escape = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const p = prefix
      .split(/[\s/]+/)
      .map(escape)
      .join('[\\s_/.-]*');
    const n = String(number).split(/[-.]/).map(escape).join('[\\s_.-]*');
    const text = String(title)
      .normalize('NFKC')
      .replace(/[‐‑–—−]/g, '-')
      .replace(/[\u200b-\u200d\ufeff]/g, '');
    // Titles only discover candidates. Edition, publisher and language are
    // established from the pages, including uploads labelled as translations.
    const match = new RegExp(
      p + '[\\s_-]*' + n + '(?:(?!\\d)(?![-.]\\d{1,3}(?!\\d))|(?=(?:19|20)\\d{2}(?!\\d)))',
      'i',
    ).exec(text);
    if (!match) return false;
    if (
      !other &&
      /(?:^|[^a-z])(?:DIN|BS|NF|EN|NEN|SIST|EVS|UNE|JIS)(?:[\s/-]+EN)?[\s/-]*$/i.test(
        text.slice(0, match.index),
      )
    )
      return false;
    return true;
  }
  const words = query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || [];
  const target = title.toLowerCase();
  return words.length > 0 && words.every((word) => target.includes(word));
}
function exactTitleMatches(query, title) {
  if (!titleMatches(query, title)) return false;
  const text = String(title)
    .normalize('NFKC')
    .replace(/[‐‑–—−_]/g, '-')
    .replace(/[\u200b-\u200d\ufeff]/g, '');
  if (/\b(?:DIS|FDIS|DRAFT|AWI|WD)\b/i.test(text)) return false;
  const national = designation.parse(query);
  if (national) {
    const wanted = { ...national, reaffirmed: null };
    return designation
      .references(text, national.publisher)
      .some(
        (found) =>
          designation.same(wanted, found) && Boolean(wanted.amendment) === Boolean(found.amendment),
      );
  }
  const iso = reference(query);
  if (iso)
    return Boolean(
      sameReference(iso, reference(text)) &&
      (iso.supplement || !/\b(?:AMD|AMENDMENT|COR|CORRIGENDUM|A\d+)\b/i.test(text)),
    );
  return plain(text).toLowerCase().includes(plain(query).toLowerCase());
}
function parseResults(html, query, { page = 1 } = {}) {
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
  results.sort((a, b) => Number(b.format === 'PDF') - Number(a.format === 'PDF'));
  Object.defineProperty(results, 'rawCount', {
    value: html.split(/<div\s+class=["']sd-list-con["'][^>]*>/i).length - 1,
  });
  Object.defineProperty(results, 'rawKey', {
    value: digest(
      html
        .split(/<div\s+class=["']sd-list-con["'][^>]*>/i)
        .slice(1)
        .map((block) => block.match(/\bhref=["']([^"']+)["']/i)?.[1] || '')
        .join('|'),
    ),
  });
  // Result counts vary by page (including pages containing only national
  // editions). Follow the site's actual pagination rather than assuming a
  // fixed page size or counting the candidates that survived our filters.
  const pager = html.match(/<div\b[^>]*\bid\s*=\s*["']page["'][^>]*>([\s\S]*?)<\/div>/i)?.[1];
  if (pager !== undefined) {
    const currentPage =
      Number(
        pager.match(/<span\b[^>]*class=["'][^"']*\bcurrent\b[^"']*["'][^>]*>\s*(\d+)/i)?.[1],
      ) || page;
    const following = [...pager.matchAll(/Search\.searchPage\(\s*["']p=(\d+)["'&]/g)]
      .map((match) => Number(match[1]))
      .filter((number) => Number.isSafeInteger(number) && number > currentPage);
    Object.defineProperty(results, 'pagination', {
      value: { currentPage, nextPage: following.length ? Math.min(...following) : null },
    });
  }
  return results;
}
async function searchDocuments(
  query,
  signal,
  fetcher = require('./doc88-network.cjs').fetchDoc88,
  { page = 1, searchText, exact = false } = {},
) {
  query = validateQuery(query);
  const searchURL = new URL('https://www.doc88.com/search/post.do');
  searchURL.search = new URLSearchParams({
    from: '1',
    f: '0',
    h: '1',
    pageRange: '0',
    pageNum: '0',
    format: '',
    p: String(page),
    q: exact ? searchText || query : (searchText || query).replace(/:/g, ' '),
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
    throw new Error(`Поиск временно недоступен: HTTP ${response.status}. Попробуй позже.`);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 3 * 1024 * 1024) throw new Error('Получен слишком большой ответ поиска.');
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel();
  }
  const html = Buffer.concat(chunks).toString('utf8');
  if (!/sd-list-con|pageResult/.test(html))
    throw new Error(
      'Не удалось получить результаты поиска. Возможно, требуется подтверждение доступа.',
    );
  return parseResults(html, query, { page });
}

const functionWords = new Set(
  'the of and to a in is for as that with be by or are this an on from shall which it not can may at these has have such'.split(
    ' ',
  ),
);
async function analyseTextPages(texts, target = 'eng') {
  const allowed = ocrPolicy.resolve('', target).split('+');
  const machineTranslation = texts.some((text) =>
    /(?:^|\n)[ \t]*(?:Machine[ \t]+translated[ \t]+by[ \t]+(?:Google|DeepL)|Translated[ \t]+by[ \t]+Google[ \t]+Translate)[ \t]*(?:\r?\n|$)/i.test(
      String(text),
    ),
  );
  const { franc } = await import('franc-min');
  const wordsByLanguage = {
    eng: functionWords,
    deu: new Set(
      'der die das und zu in ist von für mit den des auf als werden wird ein eine einer oder nicht sind bei durch diese dem muss sollen'.split(
        ' ',
      ),
    ),
    fra: new Set(
      'le la les de des du un une et en est pour dans par avec sont que qui sur au aux doit doivent ce cette ces ne pas ou'.split(
        ' ',
      ),
    ),
    rus: new Set(
      'и в на для не по из что с при или как быть должны должен это является к от до эти между'.split(
        ' ',
      ),
    ),
  };
  const repeated = new Map(),
    key = (line) => line.trim().toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ');
  for (const text of texts)
    for (const line of new Set(
      text
        .split('\n')
        .map(key)
        .filter((line) => line.length > 8),
    ))
      repeated.set(line, (repeated.get(line) || 0) + 1);
  let bodyChars = 0;
  let matchedChars = 0,
    otherChars = 0,
    matchedPages = 0,
    otherPages = 0,
    englishPages = 0;
  const evidence = [],
    matchedLanguages = new Set();
  for (let index = 0; index < texts.length; index++) {
    const text = texts[index]
      .split('\n')
      .filter(
        (line) => (repeated.get(key(line)) || 0) < Math.max(3, Math.ceil(texts.length * 0.35)),
      )
      .join('\n');
    const letters = text.match(/\p{L}/gu)?.length || 0;
    if (letters < 150) continue;
    bodyChars += letters;
    const words = text.toLowerCase().match(/\p{L}+/gu) || [],
      language = franc(text, { minLength: 200 });
    const score = (code) => {
      const common = words.filter((word) => wordsByLanguage[code]?.has(word));
      return {
        count: common.length,
        distinct: new Set(common).size,
        ratio: common.length / Math.max(words.length, 1),
      };
    };
    const detectedScore = score(language),
      best = allowed.map((code) => ({ code, ...score(code) })).sort((a, b) => b.ratio - a.ratio)[0];
    const scriptRatio =
      (text.match(allowed.includes('rus') ? /\p{Script=Cyrillic}/gu : /\p{Script=Latin}/gu)
        ?.length || 0) / letters;
    const matched =
      scriptRatio > 0.8 &&
      ((allowed.includes(language) &&
        detectedScore.count >= 4 &&
        detectedScore.distinct >= 3 &&
        detectedScore.ratio >= 0.06) ||
        (best.count >= 8 && best.distinct >= 5 && best.ratio >= 0.12));
    const clearlyForeign =
      !matched &&
      (scriptRatio < 0.5 ||
        (!allowed.includes(language) &&
          detectedScore.count >= 6 &&
          detectedScore.distinct >= 4 &&
          detectedScore.ratio >= 0.08));
    if (matched) {
      matchedChars += letters;
      matchedPages++;
      if (language === 'eng') englishPages++;
      matchedLanguages.add(allowed.includes(language) ? language : best.code);
    } else if (clearlyForeign) {
      otherChars += letters;
      otherPages++;
    }
    evidence.push({
      page: index + 1,
      language,
      matched,
      english: matched && allowed.includes('eng'),
      clearlyForeign,
      commonWords: best.count,
      commonRatio: best.ratio,
    });
  }
  const total = bodyChars,
    ratio = total ? matchedChars / total : 0;
  const status =
    matchedChars >= 250 && ratio >= 0.65
      ? 'passed'
      : otherChars >= 250 && otherPages >= Math.min(2, evidence.length) && ratio < 0.4
        ? 'failed'
        : 'unknown';
  return {
    version: 2,
    status: machineTranslation ? 'failed' : status,
    machineTranslation,
    englishPages,
    matchedPages,
    otherPages,
    ocrLanguage: target,
    allowedLanguages: allowed,
    matchedLanguages: [...matchedLanguages],
    detectedLanguage: matchedLanguages.size === 1 ? [...matchedLanguages][0] : null,
    checkedPages: evidence.length,
    totalPages: texts.length,
    bodyChars,
    evidence,
    message: machineTranslation
      ? 'В документе указан автоматический перевод. Официальная языковая версия не подтверждена.'
      : status === 'passed'
        ? 'Язык основного текста подтверждён.'
        : status === 'failed'
          ? 'Основной текст на языке, который не допускается для этого издателя.'
          : 'Недостаточно уверенных данных, чтобы определить язык текста.',
  };
}
function normalizeReferenceGlyphs(query, text) {
  const wanted = designation.parse(query);
  if (!wanted) return String(text || '');
  const spaced = (value) =>
    [...value]
      .map((c) =>
        c === ' '
          ? '\\s*'
          : /[.-]/.test(c)
            ? '[\\s_.-]*'
            : c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      )
      .join('\\s*');
  const expression = new RegExp(
    '\\b' +
      spaced(wanted.prefix) +
      '\\s*' +
      spaced(wanted.number) +
      '\\s*[:–—-]?\\s*((?:1\\s*9|2\\s*0)\\s*\\d\\s*\\d)(?!\\d)',
    'gi',
  );
  return String(text || '').replace(
    expression,
    (_, year) =>
      wanted.prefix +
      ' ' +
      wanted.number +
      (wanted.publisher === 'ASME' ? '-' : ':') +
      year.replace(/\s/g, ''),
  );
}
function identityCheck(query, texts) {
  const other = designation.parse(query);
  if (other) {
    texts = texts.map((text) => normalizeReferenceGlyphs(query, text));
    const base = {
      ...other,
      year: null,
      month: null,
      day: null,
      amendment: null,
      reaffirmed: null,
    };
    // Replaced editions and publication histories are not the cover identity.
    const primaryCover = String(texts[0] || '').split(
      /Ersatz\s+für|Replacement\s+for\b|Replaces\b|Supersedes\b|\[Revision\s+of/i,
    )[0];
    const cover = [primaryCover, texts[1] || ''].join('\n');
    const entries = designation
      .references(cover, other.publisher)
      .filter((found) => designation.same(base, found));
    const first = entries.find((found) => found.year);
    if (first?.year && other.year && first.year !== other.year)
      return { status: 'failed', message: 'На страницах указано другое издание документа.' };
    let passed = entries.some(
      (found) =>
        found.year === other.year && (!other.month || !found.month || found.month === other.month),
    );
    if (!passed && entries.length && other.year) {
      const months =
        'January|February|March|April|May|June|July|August|September|October|November|December|Januar|Februar|März|Mai|Juni|Juli|Oktober|Dezember|janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre';
      const dated = texts
        .slice(0, 2)
        .join('\n')
        .match(new RegExp('(?:' + months + ')\\s+((?:19|20)\\d{2})', 'i'));
      passed = Boolean(dated && dated[1] === other.year);
    }
    if (passed && other.amendment) {
      const amendment = new RegExp(
        '\\b' + other.amendment.number + '\\s*[:/ -]\\s*' + other.amendment.year + '\\b',
        'i',
      );
      passed =
        entries.some((found) =>
          designation.same({ ...other, month: null, day: null, reaffirmed: null }, found),
        ) || amendment.test(cover);
    }
    if (passed && other.publisher === 'ASME' && other.reaffirmed) {
      const front = texts.slice(0, 3).join('\n').replace(/\s+/g, '').toUpperCase();
      if (!front.includes('REAFFIRMED' + other.reaffirmed))
        return {
          status: 'failed',
          reaffirmed: null,
          message: `В документе не подтверждена пометка Reaffirmed ${other.reaffirmed}.`,
        };
    }
    return {
      status: passed ? 'passed' : 'unknown',
      ...(passed && other.reaffirmed ? { reaffirmed: other.reaffirmed } : {}),
      message: passed
        ? 'Обозначение и год издания подтверждены на страницах документа.'
        : 'Не удалось подтвердить обозначение и год издания внутри документа.',
    };
  }
  const wanted = reference(query);
  if (!wanted) return { status: 'passed', message: 'Название соответствует поисковому запросу.' };
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
  const first = snippets
    .map(reference)
    .find(
      (found) =>
        found &&
        sameReference(
          { ...wanted, year: null, supplement: undefined },
          { ...found, supplement: undefined },
        ),
    );
  if (first?.year && wanted.year && first.year !== wanted.year)
    return { status: 'failed', message: 'На обложке указано другое издание ISO.' };
  if (first?.supplement && !wanted.supplement)
    return {
      status: 'failed',
      message: 'На обложке указана поправка, а требуется основной документ.',
    };
  if (/\bISO\s*\/\s*(?:DIS|FDIS)\b|\bDRAFT INTERNATIONAL STANDARD\b/i.test(String(texts[0] || '')))
    return { status: 'failed', message: 'На обложке указан проект стандарта.' };
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
  const publisher = edition?.publisher || 'ISO';
  if (!Number.isSafeInteger(expected) || expected < 1)
    return {
      status: 'unknown',
      pages: pages || null,
      officialPages: null,
      message: `Число страниц в каталоге ${publisher} не получено. Полнота издания не подтверждена; повтори поиск позже.`,
    };
  if (!Number.isSafeInteger(pages) || pages < 1)
    return {
      status: 'unknown',
      pages: null,
      officialPages: expected,
      message: `Каталог ${publisher}: ${expected} стр. Число страниц документа ещё не подтверждено.`,
    };
  return {
    status: pages >= expected ? 'passed' : 'failed',
    pages,
    officialPages: expected,
    message:
      pages >= expected
        ? `В PDF ${pages} стр.; в каталоге ${publisher} — ${expected}. Объём не меньше официального. Обложка и вводные страницы могут увеличивать число страниц PDF.`
        : `Сокращённый документ: ${pages} стр., в каталоге ${publisher} — ${expected}. Этот вариант отклонён.`,
  };
}
function searchQueries(query) {
  const national = designation.parse(query),
    iso = national ? null : reference(query);
  if (national) {
    const exact = designation.format({ ...national, reaffirmed: null });
    const broad = designation.format({
      ...national,
      year: null,
      month: null,
      day: null,
      amendment: null,
      reaffirmed: null,
    });
    return [
      ...new Set([
        ...(national.reaffirmed ? [designation.format(national)] : []),
        exact,
        broad,
        broad.replace(/\s/g, ''),
        broad.replace(/[-.]/g, ' '),
        broad.replace(/[\s.-]/g, ''),
      ]),
    ];
  }
  if (iso) {
    const exact = require('./iso-catalog.cjs').formatReference(iso);
    const broad = require('./iso-catalog.cjs').formatReference({
      ...iso,
      year: null,
      supplement: undefined,
    });
    return [...new Set([exact, broad, broad.replace(/\s/g, ''), broad.replace(/-/g, ' ')])];
  }
  return [query];
}
async function* searchDocumentPages(
  query,
  signal,
  log = () => {},
  {
    fetcher = require('./doc88-network.cjs').fetchDoc88,
    maxPages = Infinity,
    onPhase = () => {},
  } = {},
) {
  const seen = new Set();
  const queries = searchQueries(query);
  // Exhaust precise designation/year matches before trying undated and
  // spacing variants. Yielding stays lazy: a verified exact PDF ends the job
  // before any broader search is requested. Parsed responses can be reused if
  // both phases issue the same request (for example ASME edition numbers).
  const cache = new Map();
  const phases = [
    { name: 'exact', texts: [queries[0]], exact: true },
    { name: 'optimized', texts: queries, exact: false },
  ];
  for (const phase of phases) {
    signal.throwIfAborted();
    onPhase(phase.name);
    log('Search mode: ' + phase.name);
    for (const text of phase.texts) {
      const seenPages = new Set();
      log('Search: ' + text);
      let page = 1;
      for (let count = 0; count < maxPages; count++) {
        signal.throwIfAborted();
        let rows;
        try {
          const key = JSON.stringify([phase.exact ? text : text.replace(/:/g, ' '), page]);
          rows = cache.get(key);
          if (!rows) {
            rows = await searchDocuments(query, signal, fetcher, {
              page,
              searchText: text,
              exact: phase.exact,
            });
            cache.set(key, rows);
          }
        } catch (error) {
          signal.throwIfAborted();
          throw Object.assign(error, { code: 'SEARCH_INCOMPLETE' });
        }
        log(`Search page: ${page}; results: ${rows.rawCount}; candidates: ${rows.length}`);
        if (rows.pagination && rows.pagination.currentPage !== page)
          throw Object.assign(
            Error(
              'Источник вернул другую страницу поиска. Поиск не завершён; попробуйте продолжить.',
            ),
            { code: 'SEARCH_INCOMPLETE' },
          );
        const key = rows.rawKey;
        // Some pages repeat uploads or contain no matching documents. An explicit
        // next-page link still needs to be followed in either case. Without a
        // pager, identical responses protect against sources ignoring page=N.
        if (!rows.pagination && seenPages.has(key)) break;
        seenPages.add(key);
        const added = [];
        for (const row of rows)
          if (
            (phase.exact ? exactTitleMatches(query, row.title) : titleMatches(query, row.title)) &&
            !seen.has(row.url)
          ) {
            seen.add(row.url);
            added.push({ ...row });
          }
        if (added.length) yield added;
        const nextPage = rows.pagination
          ? rows.pagination.nextPage
          : rows.rawCount
            ? page + 1
            : null;
        if (!nextPage) break;
        if (count + 1 === maxPages)
          throw Object.assign(
            Error(
              'Поиск ещё не завершён: достигнут предел страниц источника. Уточните обозначение документа.',
            ),
            { code: 'SEARCH_INCOMPLETE' },
          );
        page = nextPage;
      }
    }
  }
}
async function searchAllDocuments(query, signal, log = () => {}, options = {}) {
  const rows = [];
  for await (const page of searchDocumentPages(query, signal, log, options)) rows.push(...page);
  return rows;
}
async function runSearchJob(job, dataDirectory, options = {}) {
  const timings = options._timings || createTimings(job);
  const previewTotals = options._previewTotals || {
    concurrency: 5,
    total: 0,
    started: 0,
    active: 0,
    peak: 0,
    completed: 0,
    cancelled: 0,
  };
  if (!options._timings)
    job.update({ previewDiagnostics: null, performanceMetrics: timings.snapshot() });
  let status = 'error';
  try {
    await searchWork(job, dataDirectory, {
      ...options,
      _timings: timings,
      _previewTotals: previewTotals,
    });
    status = job.stage === 'done' ? 'done' : 'waiting';
  } finally {
    if (!options._timings) timings.finish(job.controller.signal.aborted ? 'cancelled' : status);
  }
}
async function searchWork(job, dataDirectory, options = {}) {
  const timings = options._timings;
  const assertActive = () => {
    if (job.controller.signal.aborted) throw new Error('Обработка остановлена.');
  };
  let query = validateQuery(job.resolvedQuery || job.query);
  job.update({ ocrLanguage: ocrPolicy.resolve(query, job.ocrLanguage, job.documentLanguage) });
  const other = designation.parse(query);
  const wanted = other ? null : reference(query);
  if (
    other &&
    !(
      job.catalogueEdition?.title &&
      (job.catalogueEdition?.pageCount || job.catalogueEdition?.extentPolicy === 'source') &&
      designation.same(other, designation.parse(job.catalogueEdition.reference))
    )
  ) {
    job.update({
      stage: 'resolving',
      workflowPhase: 'edition',
      message: 'Проверяем официальный каталог издателя…',
    });
    try {
      const edition = await timings.measure('catalogue', () =>
        (options.lookupPublisher || require('./publisher-catalog.cjs').resolvePublisher)(other, {
          chooseEdition: options.chooseEdition,
          signal: job.controller.signal,
          dataDirectory,
        }),
      );
      if (edition.series) {
        job.update({
          stage: 'selecting',
          seriesReference: edition.reference,
          seriesOptions: edition.items,
          message: 'Выберите документы серии.',
          title: edition.reference,
          pdfReady: false,
        });
        return;
      }
      if (options.chooseEdition && !other.year) {
        job.update({
          stage: 'choosing',
          isoChoices: edition.editions || [edition],
          choicePublisher: other.publisher,
          requestedReference: query,
          message: 'Год не указан. Выберите издание документа.',
          pdfReady: false,
        });
        return;
      }
      query = edition.reference;
      job.update({ resolvedQuery: query, catalogueEdition: edition, title: query });
    } catch (error) {
      assertActive();
      if (error.code === 'PUBLISHER_EDITION_CHOICE' && error.editions?.length) {
        job.update({
          stage: 'choosing',
          isoChoices: error.editions,
          choicePublisher: other.publisher,
          requestedReference: error.requestedReference,
          message: error.message,
        });
        return;
      }
      throw error;
    }
  }
  if (wanted && !wanted.year) {
    job.update({
      stage: 'resolving',
      workflowPhase: 'edition',
      isoLookupURL: searchURL(wanted),
      message: options.chooseEdition
        ? 'Получаем список изданий из официального каталога ISO…'
        : 'Уточняем действующее издание в официальном каталоге ISO…',
    });
    const edition = await timings.measure('catalogue', () =>
      (
        options.resolveISO ||
        ((wanted, opts) =>
          require('./iteh-catalog.cjs').withITEHFallback(resolveLatestISO, wanted, opts))
      )(wanted, {
        signal: job.controller.signal,
        dataDirectory,
        detectSeries: !wanted.part,
        chooseEdition: options.chooseEdition,
      }),
    );
    assertActive();
    if (edition.series) {
      job.update({
        stage: 'selecting',
        seriesReference: edition.reference,
        seriesOptions: edition.items,
        message: 'Выберите документы серии.',
        title: edition.reference,
        pdfReady: false,
      });
      return;
    }
    if (options.chooseEdition) {
      job.update({
        stage: 'choosing',
        isoChoices: edition.editions || [edition],
        isoHistoryIncomplete: Boolean(edition.incomplete),
        requestedReference: query,
        message: 'Год не указан. Выберите издание документа.',
        pdfReady: false,
      });
      return;
    }
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
      workflowPhase: 'edition',
      isoLookupURL: searchURL(wanted),
      message: 'Получаем официальное название и число страниц из каталога ISO…',
    });
    try {
      const edition = await timings.measure('catalogue', () =>
        (
          options.lookupISO ||
          ((wanted, opts) =>
            require('./iteh-catalog.cjs').withITEHFallback(resolveISOStandard, wanted, opts))
        )(wanted, {
          signal: job.controller.signal,
          dataDirectory,
          onProgress: (message) => job.update({ message }),
        }),
      );
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
  const languageChoices = ocrPolicy.choices(query, job.catalogueEdition || job.isoEdition);
  if (!job.documentLanguage && job.batchLanguagePreference) {
    if (languageChoices.some((choice) => choice.code === job.batchLanguagePreference))
      job.update({ documentLanguage: job.batchLanguagePreference });
    else {
      job.update({
        stage: 'language',
        languageChoices,
        languageException: 'batch-unavailable',
        title: query,
        message: 'Выбранный для серии язык недоступен. Подтвердите язык этого документа.',
        pdfReady: false,
      });
      return;
    }
  }
  if (
    languageChoices.length > 1 &&
    !languageChoices.some((choice) => choice.code === job.documentLanguage)
  ) {
    job.update({
      stage: 'language',
      languageChoices,
      title: query,
      message: 'Выберите язык документа.',
      pdfReady: false,
    });
    return;
  }
  if (languageChoices.length === 1) job.update({ documentLanguage: languageChoices[0].code });
  job.update({ ocrLanguage: ocrPolicy.resolve(query, job.ocrLanguage, job.documentLanguage) });
  let cachedCandidate;
  const resolvedEdition = job.catalogueEdition || job.isoEdition;
  const selectedExtent = resolvedEdition?.pageCountsByLanguage?.[job.documentLanguage];
  if (selectedExtent)
    job.update({
      [job.catalogueEdition ? 'catalogueEdition' : 'isoEdition']: {
        ...resolvedEdition,
        pageCount: selectedExtent,
      },
    });
  if (!options.candidates && !options._searchIterator && !options._cacheAttempted) {
    options = { ...options, _cacheAttempted: true };
    job.update({ stage: 'checking', workflowPhase: 'checking' });
    try {
      const cached = await timings.measure('cache', () => loadSharedCache(job, dataDirectory));
      if (cached?.ready) return;
      cachedCandidate = cached?.candidate;
    } catch (error) {
      assertActive();
      job.log('Shared cache unavailable: ' + error.message);
    }
  }
  job.update({ stage: 'searching', workflowPhase: 'checking', message: `Ищем документ ${query}…` });
  let iterator = options._searchIterator;
  let initial;
  if (
    !options.candidates &&
    !options.freshDiscovery &&
    options.resume &&
    job.searchVersion === SEARCH_VERSION &&
    job.searchResults?.some((item) => item.status !== 'rejected')
  )
    initial = job.searchResults;
  if (!options.candidates && !options.search) {
    iterator ||= (options.discover || searchDocumentPages)(query, job.controller.signal, job.log, {
      onPhase(searchPhase) {
        job.update({
          searchPhase,
          stage: 'searching',
          message:
            searchPhase === 'exact'
              ? `Ищем точное обозначение ${query}…`
              : 'Расширяем поиск: проверяем другие варианты записи обозначения…',
        });
      },
    });
    initial ||= cachedCandidate
      ? [cachedCandidate]
      : (await timings.measure('search', () => iterator.next())).value || [];
  }
  const candidates = (
    options.candidates ||
    initial ||
    (cachedCandidate
      ? [cachedCandidate]
      : await timings.measure('search', () =>
          options.search(query, job.controller.signal, job.log),
        ))
  ).filter(
    (candidate) =>
      (!options.sourceProviders ||
        options.sourceProviders.includes(candidate.provider || 'doc88')) &&
      (candidate.provider === 'anna'
        ? options.experimentalAnna === true &&
          /^https:\/\/annas-archive\.pk\/md5\/[a-f\d]{32}$/.test(candidate.url)
        : (!candidate.provider || candidate.provider === 'doc88') &&
          titleMatches(query, candidate.title)),
  );
  job.update({ searchResults: candidates, searchVersion: SEARCH_VERSION });
  if (options.candidates && !candidates.length)
    throw new Error(
      `Выбранный вариант не соответствует ${query}. Запусти поиск заново; для старого издания укажи год явно.`,
    );
  if (!candidates.length)
    throw Object.assign(
      new Error(
        'Поиск завершён. В доступных результатах не найден документ, соответствующий запросу.',
      ),
      { code: 'SEARCH_EXHAUSTED' },
    );
  const iso = other ? null : reference(query);
  const catalogue = job.catalogueEdition || job.isoEdition;
  // Reject clearly shortened uploads before spending time or the OCR budget on
  // them. Preserve their source links and the reason in the search results.
  const eligible = [];
  const rejectedByUser = await require('./document-review.cjs').rejectedSources(job, dataDirectory);
  for (const candidate of candidates) {
    if (rejectedByUser.has(candidate.url)) {
      candidate.status = 'rejected';
      candidate.error = 'Документ отклонён по пользовательской оценке.';
      continue;
    }
    if (
      options.resume &&
      (candidate.status === 'rejected' || (options._searchIterator && candidate.status === 'error'))
    )
      continue;
    if (catalogue) {
      const extent = isoExtentCheck(candidate.pageCount, catalogue);
      if (
        (candidate.pageCount && extent.status === 'failed') ||
        (!extent.officialPages && catalogue.extentPolicy !== 'source')
      ) {
        candidate.status = 'rejected';
        candidate.checks = { extent };
        continue;
      }
    }
    eligible.push(candidate);
  }
  job.update({ searchResults: candidates });
  const checks = Math.min(eligible.length, options.maxCandidates ?? eligible.length);
  function childFor(candidate, index, { signal, preview = false } = {}) {
    return {
      directory: path.join(job.directory, 'candidates', digest(candidate.url).slice(0, 24)),
      cacheDirectory: job.cacheDirectory,
      controller: signal ? { signal } : job.controller,
      url: candidate.url,
      provider: candidate.provider || 'doc88',
      title: candidate.title,
      fromPage: 1,
      toPage: null,
      enhanceImages: job.enhanceImages !== false,
      query,
      enforceScript: Boolean(ocrPolicy.policy(query)),
      ocrLanguage: ocrPolicy.resolve(query, job.ocrLanguage, job.documentLanguage),
      documentLanguage: job.documentLanguage,
      processingMode: job.processingMode || 'auto',
      ...(job.catalogueEdition ? { catalogueEdition: job.catalogueEdition } : {}),
      ...(job.isoEdition ? { isoEdition: job.isoEdition } : {}),
      officialPages: catalogue?.pageCount,
      log: job.log,
      update(value) {
        Object.assign(this, value);
        if (preview) return;
        const { stage, message, current, total } = this;
        job.update({
          performanceMetrics: timings.snapshot(),
          stage: stage === 'done' ? 'checking' : stage,
          current: current || 0,
          total: total || 0,
          challengeAvailable: Boolean(this.challengeAvailable),
          ocrDiagnostics: this.ocrDiagnostics,
          message: `Вариант ${index + 1} из ${checks}. ${stage === 'done' ? 'Проверяем язык документа…' : message || ''}`,
        });
      },
    };
  }
  const previewEnabled =
    eligible.some((candidate) => !candidate.provider || candidate.provider === 'doc88') &&
    Boolean(options.preview || (!options.download && !options.convert));
  const previewChildren = new Map();
  let previousPoolState = { total: 0, started: 0, completed: 0, cancelled: 0 };
  const pool =
    previewEnabled && checks
      ? createPreviewPool(
          eligible.slice(0, checks),
          async (candidate, index, signal) => {
            if (candidate.provider === 'anna') return { skipped: true };
            if (candidate.fromSharedCache) return { reused: true };
            const child = childFor(candidate, index, { signal, preview: true });
            previewChildren.set(index, child);
            await fs.mkdir(child.directory, { recursive: true });
            return timings.measure('preview', () =>
              (options.preview || require('./preview-document.cjs').previewCandidate)(
                child,
                dataDirectory,
                catalogue,
                { conversionWorkers: 1 },
              ),
            );
          },
          {
            signal: job.controller.signal,
            concurrency: options.previewConcurrency ?? 5,
            onState(state) {
              const totals = options._previewTotals;
              for (const key of ['total', 'started', 'completed', 'cancelled'])
                totals[key] += state[key] - previousPoolState[key];
              totals.active = state.active;
              totals.concurrency = state.concurrency;
              totals.peak = Math.max(totals.peak, state.peak);
              previousPoolState = state;
              job.update({
                previewDiagnostics: { ...totals },
                performanceMetrics: timings.snapshot(),
              });
            },
          },
        )
      : null;
  try {
    for (let index = 0; index < checks; index++) {
      assertActive();
      const candidate = eligible[index];
      candidate.status = 'checking';
      candidate.error = null;
      candidate.errorCode = null;
      candidate.failureKind = null;
      job.update({
        stage: 'checking',
        workflowPhase: 'checking',
        candidateIndex: index + 1,
        candidateCount: checks,
        searchResults: candidates,
        pdfReady: false,
        archiveReady: false,
        total: 0,
        current: 0,
      });
      const child = childFor(candidate, index);
      try {
        await fs.mkdir(child.directory, { recursive: true });
        if (wanted || catalogue || reference(query)) {
          const edition = catalogue?.title ? catalogue : { reference: query };
          child.officialTitle = officialFullTitle(edition);
          child.officialFilename = officialPDFName(edition);
          child.title = child.officialTitle;
        }
        if (candidate.provider && candidate.provider !== 'doc88') {
          await (options.downloadPDF || require('./pdf-sources.cjs').downloadSourcePDF)(child);
          await (options.importPDF || require('./pdf-input.cjs').importPDF)(child);
        } else {
          if (pool) {
            try {
              const result = await pool.take(index);
              if (!result.ok) throw result.error;
              candidate.preview = result.value;
            } catch (error) {
              candidate.preview = previewChildren.get(index)?.previewVerification;
              if (
                job.controller.signal.aborted ||
                [
                  'FOREIGN_SCRIPT',
                  'FOREIGN_LANGUAGE',
                  'DOCUMENT_MISMATCH',
                  'INCOMPLETE_DOCUMENT',
                ].includes(error.code)
              )
                throw error;
              job.log(
                'Предварительная проверка недоступна: ' +
                  error.message +
                  '. Выполняем полную проверку.',
              );
            }
          }
          job.update({ workflowPhase: 'pdf' });
          await timings.observeJob(child, () => processDocument(child, dataDirectory, options));
        }
        candidate.processingEngine = child.processingEngine;
        candidate.engineFallback = child.engineFallback;
        assertActive();
        job.update({
          stage: 'checking',
          message: 'Проверяем язык, издание и доступность всех страниц…',
        });
        const { texts, language } = await timings.measure('verification', async () => {
          const texts = await Promise.all(
            Array.from({ length: child.total }, (_, i) =>
              fs.readFile(
                path.join(child.directory, 'ocr', `page${String(i + 1).padStart(5, '0')}.txt`),
                'utf8',
              ),
            ),
          );
          const language = await analyseTextPages(texts, child.ocrLanguage);
          return { texts, language };
        });
        if (
          child.scriptVerification?.status === 'failed' ||
          (language.status === 'unknown' &&
            (child.scriptVerification?.status === 'unknown' || language.bodyChars >= 250))
        ) {
          language.status = 'failed';
          language.message = 'Язык документа не подтверждён проверкой текста и изображений.';
        }
        language.scriptVerification = child.scriptVerification;
        assertActive();
        const identity = child.identityVerification || identityCheck(query, texts);
        const complete =
          child.total > 0 && (!candidate.pageCount || child.total === candidate.pageCount);
        const completeness = {
          status: complete ? 'passed' : 'failed',
          pages: child.total,
          declaredPages: candidate.pageCount || child.total,
          message: complete
            ? `Загружено страниц: ${child.total} из ${child.total}, указанных в карточке документа. Каждый лист сохранён и включён в PDF.`
            : `В поиске заявлено ${candidate.pageCount} страниц, получено ${child.total}. Полнота не подтверждена.`,
        };
        const extent = catalogue ? isoExtentCheck(child.total, catalogue) : null;
        const pageIntegrity = child.pageIntegrity || inspectPages(texts, [], catalogue?.pageCount);
        candidate.checks = {
          language,
          completeness,
          identity,
          ...(extent ? { extent } : {}),
          pageIntegrity,
        };
        candidate.status =
          [
            completeness,
            identity,
            ...(extent && catalogue?.extentPolicy !== 'source' ? [extent] : []),
          ].every((check) => check.status === 'passed') &&
          language.status !== 'failed' &&
          pageIntegrity.status !== 'failed'
            ? 'passed'
            : 'rejected';
        job.update({ searchResults: candidates });
        if (candidate.status !== 'passed') continue;
        await pool?.close();
        if (child.archiveReady)
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
        try {
          await fs.copyFile(
            path.join(child.directory, 'copy-text.txt'),
            path.join(job.directory, 'copy-text.txt'),
          );
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        job.update({
          stage: 'done',
          title: child.officialTitle || candidate.title,
          sourceTitle: candidate.title,
          url: candidate.url,
          total: child.total,
          current: child.total,
          pdfReady: true,
          archiveReady: Boolean(child.archiveReady),
          pdfFilename: child.pdfFilename,
          archiveFilename: child.archiveFilename,
          bytes: child.bytes,
          textChars: child.textChars,
          blankPages: child.blankPages,
          textlessPages: child.textlessPages,
          ocrQuality: child.ocrQuality,
          pdfOptimization: child.pdfOptimization,
          ocrDiagnostics: child.ocrDiagnostics,
          verification: candidate.checks,
          catalogueExtentUnknown: catalogue?.extentPolicy === 'source' && !catalogue.pageCount,
          scriptVerification: child.scriptVerification,
          pageIntegrity,
          documentStructure: child.documentStructure,
          normativeReferences: child.normativeReferences,
          copyTextReady: Boolean(child.copyTextReady),
          imageEnhancement: child.imageEnhancement,
          reusedDownloadPages: child.reusedDownloadPages || 0,
          reusedOCRPages: child.reusedOCRPages || 0,
          processingEngine: child.processingEngine,
          processingMs: child.processingMs,
          engineFallback: child.engineFallback,
          nativeTextPages: child.nativeTextPages || 0,
          repairedOCRPages: child.repairedOCRPages || 0,
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
                ? 'PDF готов: английский текст, объём по ISO и загрузка всех страниц проверены.'
                : 'Документ найден: выбранный язык и все страницы проверены. PDF готов.',
          finishedAt: new Date().toISOString(),
        });
        try {
          await timings.measure('cache_write', () => saveSharedCache(job, child, dataDirectory));
        } catch (error) {
          job.log('Shared cache write skipped: ' + error.message);
        }
        return;
      } catch (error) {
        if (job.controller.signal.aborted) {
          candidate.status = 'cancelled';
          candidate.error = 'Проверка остановлена.';
          job.update({ searchResults: candidates });
        }
        assertActive();
        candidate.status = [
          'FOREIGN_SCRIPT',
          'FOREIGN_LANGUAGE',
          'DOCUMENT_MISMATCH',
          'INCOMPLETE_DOCUMENT',
        ].includes(error.code)
          ? 'rejected'
          : 'error';
        if (error.code === 'FOREIGN_SCRIPT')
          candidate.checks = {
            ...candidate.checks,
            language: {
              status: 'failed',
              message: error.message,
              scriptVerification: error.verification,
            },
          };
        if (error.code === 'FOREIGN_LANGUAGE')
          candidate.checks = {
            ...candidate.checks,
            language: { status: 'failed', message: error.message },
          };
        if (error.code === 'DOCUMENT_MISMATCH')
          candidate.checks = {
            ...candidate.checks,
            identity: { status: 'failed', message: error.message },
          };
        if (error.code === 'INCOMPLETE_DOCUMENT')
          candidate.checks = {
            ...candidate.checks,
            completeness: { status: 'failed', message: error.message },
          };
        candidate.error = error.message;
        candidate.errorCode = error.code || null;
        candidate.failureKind = require('./dist/job-feedback.js').failureKind(error);
        job.update({ searchResults: candidates });
      }
    }
  } finally {
    await pool?.close();
  }
  if (iterator) {
    job.update({
      stage: 'searching',
      workflowPhase: 'checking',
      message: 'Продолжаем поиск подходящего документа…',
      current: 0,
      total: 0,
    });
    while (true) {
      const next = await timings.measure('search', () => iterator.next());
      if (next.done) break;
      const fresh = next.value.filter((item) => !candidates.some((old) => old.url === item.url));
      if (fresh.length)
        return runSearchJob(job, dataDirectory, {
          ...options,
          candidates: [...candidates, ...fresh],
          resume: true,
          _searchIterator: iterator,
        });
    }
  }
  const incomplete = candidates.some((candidate) => !['rejected'].includes(candidate.status));
  throw Object.assign(
    new Error(
      incomplete
        ? 'Не удалось проверить часть вариантов. Поиск можно продолжить.'
        : 'Поиск завершён. В доступных результатах не найден документ нужного издания и языка со всеми страницами.',
    ),
    { code: incomplete ? 'SEARCH_INCOMPLETE' : 'SEARCH_EXHAUSTED' },
  );
}
module.exports = {
  validateQuery,
  reference,
  titleMatches,
  exactTitleMatches,
  parseResults,
  searchDocuments,
  searchAllDocuments,
  searchDocumentPages,
  searchQueries,
  analyseTextPages,
  identityCheck,
  normalizeReferenceGlyphs,
  isoExtentCheck,
  runSearchJob,
};
