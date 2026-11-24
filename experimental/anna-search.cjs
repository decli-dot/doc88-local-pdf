'use strict';
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { createHash } = require('node:crypto');
const { webURL } = require('../public-http.cjs');
const { createChallengeView } = require('../challenge-view.cjs');
const { inspectPage, references } = require('./anna-source.cjs');
const { titleMatches, exactTitleMatches, searchQueries } = require('../search.cjs');

function languageCode(value) {
  return { eng: 'en', deu: 'de', fra: 'fr', rus: 'ru' }[value] || 'en';
}
function searchURL(query, page = 1, language = 'eng') {
  const url = new URL('https://annas-archive.pk/search');
  url.search = new URLSearchParams({
    q: query,
    ext: 'pdf',
    lang: languageCode(language),
    page: String(page),
  });
  return url.href;
}
function allowedSearchPage(value, expected) {
  try {
    const url = webURL(value, ['annas-archive.pk']),
      target = new URL(expected);
    return (
      url.hostname === target.hostname &&
      url.pathname.replace(/\/$/, '') === '/search' &&
      url.searchParams.get('q') === target.searchParams.get('q') &&
      (url.searchParams.get('ext') || 'pdf') === 'pdf' &&
      (url.searchParams.get('lang') || target.searchParams.get('lang')) ===
        target.searchParams.get('lang') &&
      (url.searchParams.get('page') || '1') === (target.searchParams.get('page') || '1')
    );
  } catch {
    return false;
  }
}
// Executed only inside the source browser. Descriptions are kept separate from
// short metadata lines so a normative reference in an abstract cannot qualify a card.
function inspectSearchResults(inspect) {
  const state = inspect();
  if (state.blocked) return state;
  const root = document.querySelector('main') || document.body;
  const anchors = [...root.querySelectorAll('a[href*="/md5/"]')];
  const cards = anchors.flatMap((anchor) => {
    if (!anchor.getClientRects().length || !anchor.innerText.trim()) return [];
    let container = anchor;
    for (
      let parent = anchor.parentElement;
      parent && parent !== root && parent !== document.body;
      parent = parent.parentElement
    ) {
      const identities = new Set(
        [...parent.querySelectorAll('a[href*="/md5/"]')].map((a) => a.href.split(/[?#]/)[0]),
      );
      if (identities.size !== 1) break;
      container = parent;
    }
    const heading = anchor.querySelector('h2,h3,[class*="font-bold"],[class*="font-semibold"]');
    const lines = container.innerText
      .split(/\n+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const title = (
      heading?.innerText ||
      anchor.getAttribute('title') ||
      anchor.innerText.split('\n').find((s) => s.trim()) ||
      ''
    ).trim();
    return [
      {
        url: anchor.href,
        title: title.slice(0, 1500),
        metadata: lines
          .filter(
            (line) =>
              /\.pdf(?:\s|$)/i.test(line) ||
              (line.length < 250 &&
                /^(?:(?:BS|DIN|NF|EN|NEN|SIST|EVS|UNE|JIS)[ _/-]+)*ISO(?:[ /]+IEC)?[ _/-]*[\d _.:/-]+(?:\([EF]\))?$/i.test(
                  line,
                )),
          )
          .join('\n')
          .slice(0, 10000),
        details: container.innerText.slice(0, 20000),
      },
    ];
  });
  return {
    ...state,
    cards,
    ready:
      (cards.length > 0 &&
        /\bRESULTS\s+\d+\s*[-–]\s*\d+|Showing\s+\d+\s+(?:to|of)\s+\d+/i.test(root.innerText)) ||
      /No(?: exact)? (?:files|results|matches)(?: were)? found|Nothing found|0 results|RESULTS\s+0\s*[-–]\s*0/i.test(
        root.innerText,
      ),
    pagination: [...document.querySelectorAll('a[href]')]
      .filter((a) => a.rel === 'next' || /[?&]page=\d+/.test(a.href))
      .map((a) => a.href),
  };
}
const searchExpression = `(${inspectSearchResults.toString()})(${inspectPage.toString()})`;
const locateChallenge = `(()=>{const state=(${inspectPage.toString()})();return state.blocked?{id:null,x:0,y:0,width:innerWidth,height:innerHeight,viewportWidth:innerWidth,viewportHeight:innerHeight,scrollX,scrollY}:null;})()`;

async function readSearchPage(
  job,
  dataDirectory,
  url,
  {
    launchContext,
    onBrowserView = () => {},
    tryCaptcha,
    timeoutMs = 10 * 60 * 1000,
    pollMs = 700,
  } = {},
) {
  const signal = job.controller.signal;
  signal.throwIfAborted();
  const context = launchContext
    ? await launchContext()
    : await require('playwright').chromium.launchPersistentContext(
        path.join(dataDirectory, 'anna-experiment-profile'),
        {
          channel: require('../runtime.cjs').browserChannel(),
          headless: true,
          viewport: { width: 960, height: 720 },
        },
      );
  let view,
    showing = false,
    closing;
  const close = () => (closing ||= context.close().catch(() => {}));
  const stop = () => {
    void close();
  };
  signal.addEventListener('abort', stop, { once: true });
  try {
    signal.throwIfAborted();
    const page = await context.newPage(),
      cdp = await context.newCDPSession(page);
    view = createChallengeView({
      page,
      cdp,
      evaluate: (expression) => page.evaluate(expression),
      allowed: (value) => allowedSearchPage(value, url),
      locate: locateChallenge,
      maxWidth: 960,
      maxHeight: 720,
      allowKeyboard: true,
    });
    await require('../browser-navigation.cjs').gotoSourcePage(page, url, {
      signal,
      allowed: (value) => allowedSearchPage(value, url),
      onRetry: (info) => job.log?.(`Anna: повтор открытия поиска ${info.attempt}; ${info.code}`),
    });
    const started = Date.now();
    let readySince = Date.now();
    while (Date.now() - started < timeoutMs) {
      signal.throwIfAborted();
      if (!allowedSearchPage(page.url(), url))
        throw Object.assign(Error('Источник открыл другую страницу поиска.'), {
          code: 'SOURCE_ACCESS_PENDING',
        });
      let state;
      try {
        state = await page.evaluate(searchExpression);
      } catch (error) {
        signal.throwIfAborted();
        if (
          !/Execution context was destroyed|Cannot find context with specified id/i.test(
            error.message,
          )
        )
          throw error;
        await delay(pollMs, undefined, { signal });
        continue;
      }
      if (state.blocked) {
        readySince = Date.now();
        if (
          tryCaptcha &&
          !showing &&
          (await tryCaptcha({ page, allowed: (value) => allowedSearchPage(value, url) }))
        ) {
          await delay(pollMs, undefined, { signal });
          continue;
        }
        if (!showing) {
          showing = true;
          onBrowserView(view);
          job.update({
            stage: 'waiting',
            challengeAvailable: true,
            message: 'Подтвердите доступ в окне проверки.',
          });
        }
      } else {
        if (showing) {
          showing = false;
          onBrowserView(null);
          await view.reset();
          job.update({
            stage: 'searching',
            challengeAvailable: false,
            message: 'Продолжаем поиск документа…',
          });
        }
        if (state.ready) return state;
        if (Date.now() - readySince > 15000)
          throw Object.assign(
            Error('Источник ещё не показал результаты поиска. Повторите попытку.'),
            { code: 'SEARCH_INCOMPLETE' },
          );
      }
      await delay(pollMs, undefined, { signal });
    }
    throw Object.assign(
      Error('Ожидание подтверждения доступа не завершено. Можно повторить попытку.'),
      { code: 'SOURCE_ACCESS_PENDING' },
    );
  } finally {
    signal.removeEventListener('abort', stop);
    onBrowserView(null);
    job.update({ challengeAvailable: false });
    await view?.close();
    await close();
  }
}
function matchText(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[‐‑–—−]/g, '-')
    .replace(/\bISO[ _/-]*0*(\d+)[ _.-]+(\d{1,3})[ _.:/-]+((?:19|20)\d{2})\b/gi, 'ISO $1-$2:$3')
    .replace(/\bISO[ _/-]*0*(\d+)[ _.:/-]+((?:19|20)\d{2})\b/gi, 'ISO $1:$2');
}
function parseSearchResults(state, query, { exact = false, language = 'eng' } = {}) {
  const national = require('../dist/standard-reference.js').parse(query);
  const iso = national ? null : require('../iso-catalog.cjs').reference(query);
  const seen = new Set(),
    results = [];
  for (const card of state.cards || []) {
    let ref;
    try {
      ref = references(card.url);
    } catch {
      continue;
    }
    if (seen.has(ref.card)) continue;
    const title = matchText(
        String(card.title || '').replace(/\[(?:Withdrawn|replaced|superseded)[^\]]*\]/gi, ''),
      ),
      metadata = matchText(card.metadata);
    // A national adoption never becomes a plain ISO candidate, even if the
    // filename also quotes the underlying international designation.
    if (
      iso &&
      /\b(?:BS|DIN|NF|EN|NEN|SIST|EVS|UNE|JIS|ГОСТ)(?:[ _/-]+EN)?[ _/-]+ISO\b/i.test(
        title + '\n' + metadata,
      )
    )
      continue;
    if (/\bISO\s*\d/i.test(title) && !titleMatches(query, title)) continue;
    if (
      !(national?.amendment || iso?.supplement) &&
      /\b(?:AMD|AMENDMENT|COR|CORRIGENDUM)\b/i.test(title + '\n' + metadata)
    )
      continue;
    if (/\b(?:EPUB|DJVU|MOBI)\b/i.test(card.details) && !/\bPDF\b/i.test(card.details)) continue;
    const languages = [
      ...String(card.details || '').matchAll(
        /\b(?:English|German|French|Chinese|Russian|Spanish)\s*\[([a-z]{2,3})\]/gi,
      ),
    ].map((m) => m[1]);
    if (languages.length && !languages.includes(languageCode(language))) continue;
    if (!(exact ? exactTitleMatches : titleMatches)(query, title + '\n' + metadata)) continue;
    if (/\b(?:DIS|FDIS|DRAFT|AWI|WD)\b/i.test(title)) continue;
    seen.add(ref.card);
    results.push({
      provider: 'anna',
      url: ref.card,
      title: card.title,
      format: 'PDF',
      pageCount: null,
      status: 'unverified',
    });
  }
  return results;
}
function nextPage(state, currentURL) {
  const current = new URL(currentURL),
    page = Number(current.searchParams.get('page'));
  for (const value of state.pagination || []) {
    try {
      const target = new URL(value, currentURL),
        expected = new URL(currentURL);
      expected.searchParams.set('page', String(page + 1));
      if (allowedSearchPage(target.href, expected.href)) return page + 1;
    } catch {
      /* Ignore unrelated navigation. */
    }
  }
  return null;
}
async function* searchAnnaPages(
  job,
  dataDirectory,
  query,
  { readPage = readSearchPage, maxPages = 40, onPhase = () => {}, ...options } = {},
) {
  const queries = searchQueries(query),
    seen = new Set(),
    cache = new Map();
  const language = job.documentLanguage || job.ocrLanguage || 'eng';
  for (const phase of [
    { name: 'exact', texts: [queries[0]], exact: true },
    { name: 'optimized', texts: queries, exact: false },
  ]) {
    job.controller.signal.throwIfAborted();
    onPhase(phase.name);
    for (const text of phase.texts) {
      const fingerprints = new Set();
      for (let page = 1, count = 0; count < maxPages; count++) {
        job.controller.signal.throwIfAborted();
        const url = searchURL(text, page, language);
        let state = cache.get(url);
        if (!state) {
          state = await readPage(job, dataDirectory, url, options);
          cache.set(url, state);
        }
        const fingerprint = createHash('sha256')
          .update(JSON.stringify((state.cards || []).map((c) => c.url)))
          .digest('hex');
        if (fingerprints.has(fingerprint))
          throw Object.assign(Error('Источник повторил страницу поиска. Поиск не завершён.'), {
            code: 'SEARCH_INCOMPLETE',
          });
        fingerprints.add(fingerprint);
        const candidates = parseSearchResults(state, query, { ...phase, language }).filter(
          (card) => !seen.has(card.url),
        );
        job.update?.({
          annaSearchDiagnostics: {
            query: text,
            page,
            rawCards: (state.cards || []).length,
            candidates: candidates.length,
            sample: (state.cards || [])
              .slice(0, 5)
              .map(({ title, metadata }) => ({ title, metadata })),
          },
        });
        for (const candidate of candidates) seen.add(candidate.url);
        job.log(
          `Anna search: ${text}; page ${page}; cards ${(state.cards || []).length}; candidates ${candidates.length}`,
        );
        if (candidates.length) yield candidates;
        const next = nextPage(state, url);
        if (!next) break;
        if (count + 1 === maxPages)
          throw Object.assign(Error('Поиск не завершён: достигнут предел страниц источника.'), {
            code: 'SEARCH_INCOMPLETE',
          });
        page = next;
      }
    }
  }
}
module.exports = {
  searchURL,
  allowedSearchPage,
  inspectSearchResults,
  readSearchPage,
  matchText,
  parseSearchResults,
  nextPage,
  searchAnnaPages,
};
