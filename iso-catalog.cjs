'use strict';
const path = require('node:path');
const { dependency, browserChannel } = require('./runtime.cjs');

function reference(value) {
  const normalized = String(value)
    .toUpperCase()
    .replace(/[‐‑–—]/g, '-')
    .replace(/\bIS0(?=\s*\d)/g, 'ISO');
  const match = normalized.match(
    /\bISO\s*(\/\s*IEC\s*)?(\d{3,6})(?:\s*-\s*(\d{1,3})(?!\d))?(?:(?:\s*[:\-]\s*|\s+)((?:19|20)\d{2})(?!\d))?/,
  );
  if (!match) return null;
  const result = {
    organization: match[1] ? 'ISO/IEC' : 'ISO',
    number: match[2],
    part: match[3] || null,
    year: match[4] || null,
  };
  const supplement = normalized
    .slice(match.index + match[0].length)
    .match(
      /^\s*[\/+]?\s*(AMD|AMENDMENT|COR|CORRIGENDUM)\.?\s*(\d+)\s*[:\- ]\s*((?:19|20)\d{2})(?!\d)/,
    );
  if (supplement)
    result.supplement = {
      type: /^AMD|AMENDMENT$/.test(supplement[1]) ? 'Amd' : 'Cor',
      number: supplement[2],
      year: supplement[3],
    };
  return result;
}
function sameReference(wanted, found) {
  return (
    found &&
    wanted.organization === found.organization &&
    wanted.number === found.number &&
    wanted.part === found.part &&
    (!wanted.year || wanted.year === found.year) &&
    Boolean(wanted.supplement) === Boolean(found.supplement) &&
    (!wanted.supplement ||
      (wanted.supplement.type === found.supplement.type &&
        wanted.supplement.number === found.supplement.number &&
        wanted.supplement.year === found.supplement.year))
  );
}
function formatReference(value) {
  return `${value.organization} ${value.number}${value.part ? '-' + value.part : ''}${value.year ? ':' + value.year : ''}${value.supplement ? '/' + value.supplement.type + ' ' + value.supplement.number + ':' + value.supplement.year : ''}`;
}
function internationalISOName(value) {
  const text = String(value).normalize('NFKC');
  const marker = /\bISO(?=\s*(?:\/\s*IEC\s*)?\d)/i.exec(text);
  if (!marker) return false;
  const prefix = text.slice(0, marker.index);
  const decorations = new Set([
    'PDF',
    'OCR',
    'HQ',
    'HD',
    'ORIGINAL',
    'FULL',
    'TEXT',
    'ENGLISH',
    'VERSION',
  ]);
  const tokens = prefix.toUpperCase().match(/[A-Z]+/g) || [];
  return (
    !/[А-ЯЁа-яё]/.test(prefix) &&
    tokens.every((token) => decorations.has(token)) &&
    !/\b(?:BS|DIN|EN|NF|NEN|SIST|EVS|UNE|ABNT|NBR|JIS|ГОСТ)(?:\s+(?:EN|ISO))?\s+ISO\b/i.test(text)
  );
}
function normalizeOfficialTitle(value) {
  let title = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  const part = /Part\s+\d+(?:-\d+)*\s*:/i.exec(title);
  if (part && part.index > 0) {
    const before = title.slice(0, part.index).trim();
    title = before + (/[—–-]$/.test(before) ? ' ' : ' — ') + title.slice(part.index);
  }
  return title;
}
function officialFullTitle(edition) {
  const title = normalizeOfficialTitle(edition?.title);
  return edition.reference + (title ? ' — ' + title : '');
}
function officialPDFName(edition) {
  const wanted = reference(edition?.reference);
  if (!wanted?.year) throw new Error('Нужно обозначение ISO с годом для имени PDF.');
  const name = (
    formatReference(wanted).replace(/:(\d{4})/g, ' $1') +
    ' ' +
    normalizeOfficialTitle(edition.title)
  )
    .normalize('NFC')
    .replace(/:\s*/g, ' - ')
    .replace(/[<>"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  let result = '',
    bytes = 0;
  for (const character of name) {
    const length = Buffer.byteLength(character, 'utf8');
    if (bytes + length > 240) break;
    result += character;
    bytes += length;
  }
  return result.replace(/[. ]+$/, '') + '.pdf';
}
function searchURL(wanted) {
  const url = new URL('https://www.iso.org/search.html');
  url.searchParams.set('q', formatReference({ ...wanted, year: null, supplement: undefined }));
  return url.href;
}
function officialURL(value) {
  try {
    const url = new URL(value, 'https://www.iso.org');
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'www.iso.org' ||
      url.port ||
      url.username ||
      url.password ||
      !/^\/(?:[a-z]{2}\/)?standard\/[a-z\d-]+(?:\.html)?$/i.test(url.pathname)
    )
      return null;
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}
function chooseISOEdition(hits, wanted) {
  const candidates = [];
  for (const hit of hits) {
    const found = reference(hit.reference);
    const url = officialURL(hit.url);
    if (
      !url ||
      !found?.year ||
      !sameReference(wanted, found) ||
      !(wanted.year ? /^(Published|Withdrawn)$/i : /^Published$/i).test(
        String(hit.status).trim(),
      ) ||
      /\b(?:DIS|FDIS|DRAFT)\b/i.test(hit.reference) ||
      (!wanted.supplement && /\b(?:AMD|COR|AMENDMENT|CORRIGENDUM)\b/i.test(hit.reference))
    )
      continue;
    candidates.push({
      reference: formatReference(found),
      year: Number(found.year),
      sourceURL: url,
      status: String(hit.status).trim(),
      title: normalizeOfficialTitle(hit.title),
    });
  }
  candidates.sort((a, b) => b.year - a.year);
  return candidates[0] || null;
}
function chooseCurrentISO(hits, wanted) {
  return chooseISOEdition(hits, { ...wanted, year: null });
}
function cataloguePageCount(text) {
  const count = Number(String(text || '').match(/\bNumber of pages\s*:?\s*(\d+)\b/i)?.[1]);
  return Number.isSafeInteger(count) && count > 0 && count <= 10000 ? count : null;
}
function catalogueSupplements(links, edition) {
  const base = reference(edition.reference);
  if (!base) return [];
  const items = new Map();
  for (const link of links || []) {
    const found = reference(link.reference),
      sourceURL = officialURL(link.url);
    if (
      !found?.supplement ||
      !sourceURL ||
      !sameReference({ ...base, supplement: undefined }, { ...found, supplement: undefined }) ||
      !/^(Published|Withdrawn)$/i.test(link.status)
    )
      continue;
    const label = formatReference(found);
    items.set(label, {
      reference: label,
      sourceURL,
      status: link.status,
      year: Number(found.year),
      type: found.supplement.type,
      number: Number(found.supplement.number),
      supplementYear: Number(found.supplement.year),
    });
  }
  return [...items.values()];
}
class ISOEditionNotFoundError extends Error {
  constructor(wanted, editions, incomplete = false) {
    const label = formatReference(wanted);
    super(
      incomplete
        ? `Не удалось подтвердить издание ${label}. Выбери одно из найденных в каталоге ISO.`
        : `Издание ${label} не найдено в истории стандарта на ISO. Выбери существующее издание.`,
    );
    this.code = 'ISO_EDITION_NOT_FOUND';
    this.requestedReference = label;
    this.editions = editions;
    this.incomplete = incomplete;
  }
}
function historyEdition(hit) {
  const found = reference(hit.reference);
  return found?.year ? chooseISOEdition([hit], found) : null;
}
async function collectISOHistory(seeds, wanted, readRecord, signal) {
  const queue = [...seeds];
  const visited = new Set();
  const editions = [];
  let incomplete = false;
  while (queue.length && visited.size < 24) {
    signal?.throwIfAborted();
    const seed = queue.shift();
    if (visited.has(seed.sourceURL)) continue;
    visited.add(seed.sourceURL);
    try {
      const record = await readRecord(seed);
      const { previous = [], next = [], ...edition } = record;
      edition.relation = sameReference({ ...wanted, year: null }, reference(edition.reference))
        ? 'edition'
        : 'predecessor';
      editions.push(edition);
      // Follow the actual lifecycle graph, never citations in the abstract.
      const family = { ...wanted, year: null };
      const sameFamilySuccessors = next.filter((link) =>
        sameReference(family, reference(link.reference)),
      );
      for (const link of [...previous, ...sameFamilySuccessors]) {
        const related = historyEdition(link);
        if (related && !reference(related.reference)?.supplement && !visited.has(related.sourceURL))
          queue.push(related);
      }
    } catch (error) {
      signal?.throwIfAborted();
      incomplete = true;
    }
  }
  if (queue.some((seed) => !visited.has(seed.sourceURL))) incomplete = true;
  const unique = [...new Map(editions.map((edition) => [edition.reference, edition])).values()];
  unique.sort(
    (a, b) =>
      Number(b.status === 'Published') - Number(a.status === 'Published') || b.year - a.year,
  );
  return { editions: unique, incomplete };
}
async function resolveISOStandard(
  wanted,
  { signal, dataDirectory, launchContext, onProgress } = {},
) {
  if (!wanted) throw new Error('Нужно обозначение ISO.');
  signal?.throwIfAborted();
  const url = searchURL(wanted);
  const launch =
    launchContext ||
    ((profile, options) =>
      dependency('playwright').chromium.launchPersistentContext(profile, options));
  const context = await launch(path.join(dataDirectory, 'iso-browser-profile'), {
    headless: false,
    channel: browserChannel(),
    viewport: { width: 1280, height: 900 },
  });
  const stop = () => {
    void context.close().catch(() => {});
  };
  signal?.addEventListener('abort', stop, { once: true });
  try {
    signal?.throwIfAborted();
    const page = context.pages()[0] || (await context.newPage());
    // ISO's public catalogue needs a regular browser session. Keep our own
    // temporary window minimized; no user browser profile or security settings change.
    try {
      const cdp = await context.newCDPSession(page);
      const { windowId } = await cdp.send('Browser.getWindowForTarget');
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    } catch {
      /* Some platforms do not expose native window bounds. */
    }
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForFunction(
      () =>
        document.querySelector('#search-results .card') ||
        /\b0\s*results\s*found/i.test(document.getElementById('stats-container')?.innerText || ''),
      null,
      { timeout: 45000 },
    );
    const hits = await page.evaluate(() =>
      [...document.querySelectorAll('#search-results .card')].map((card) => {
        const link = card.querySelector('.card-title a');
        return {
          reference: link?.innerText.trim() || '',
          url: link?.href || '',
          status: card.querySelector('.card-footer')?.innerText.trim() || '',
          title: (card.querySelector('.card-title')?.innerText || '')
            .replace(link?.innerText.trim() || '', '')
            .trim(),
        };
      }),
    );
    signal?.throwIfAborted();
    const checkedAt = new Date().toISOString();
    const readRecord = async (seed) => {
      signal?.throwIfAborted();
      onProgress?.(`Проверяем данные и историю ${seed.reference} в каталоге ISO…`);
      await page.goto(seed.sourceURL, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForFunction(() => document.querySelector('#content h1'), null, {
        timeout: 20000,
      });
      const detail = await page.evaluate(() => {
        const links = [...document.querySelectorAll('#lifecycle h4 a[href]')]
          .filter((a) => !a.closest('.sub-step'))
          .map((a) => ({
            reference: a.innerText.trim(),
            url: a.href,
            status:
              (a.closest('.step-item') || a.closest('.step'))
                ?.querySelector('.section-head')
                ?.innerText.trim() || '',
            phase: a.closest('.time-step')?.querySelector('h3')?.innerText.trim() || '',
          }));
        return {
          heading: document.querySelector('#content h1')?.innerText || '',
          title: document.title,
          text: document.querySelector('#content')?.innerText || '',
          status: document
            .querySelector('#lifecycle .step.active > .section-head')
            ?.innerText.trim(),
          previous: links.filter((link) => /^Previously$/i.test(link.phase)),
          next: links.filter((link) =>
            /^(?:Revised by|Replaced by|Will be replaced by)/i.test(link.phase),
          ),
          supplements: [...document.querySelectorAll('#lifecycle .sub-step h4 a[href]')].map(
            (a) => ({
              reference: a.innerText.trim(),
              url: a.href,
              status:
                (a.closest('.step-item') || a.closest('.step'))
                  ?.querySelector('.section-head')
                  ?.innerText.trim() || '',
            }),
          ),
        };
      });
      if (!sameReference(reference(seed.reference), reference(detail.heading)))
        throw new Error('Не удалось подтвердить данные указанного издания ISO.');
      const label = seed.reference;
      const title =
        sameReference(reference(label), reference(detail.title)) && /^ISO\b/i.test(detail.title)
          ? normalizeOfficialTitle(
              detail.title
                .replace(
                  /^ISO\s*(?:\/\s*IEC\s*)?\d{3,6}(?:\s*-\s*\d{1,3})?\s*:\s*\d{4}(?:\s*\/\s*(?:Amd|Cor|Amendment|Corrigendum)\.?\s*\d+\s*:\s*\d{4})?/i,
                  '',
                )
                .replace(/^\s*[-—:]\s*/, '')
                .replace(/\s*[-|]\s*ISO\s*$/, ''),
            )
          : seed.title || normalizeOfficialTitle(detail.heading.replace(label, ''));
      return {
        ...seed,
        title,
        pageCount: cataloguePageCount(detail.text),
        status: detail.status || seed.status,
        checkedAt,
        lookupURL: url,
        previous: detail.previous,
        next: detail.next,
        supplements: catalogueSupplements(detail.supplements, seed),
      };
    };
    let current = chooseISOEdition(hits, wanted);
    if (!current && wanted.supplement) {
      const baseWanted = { ...wanted, supplement: undefined };
      const base = chooseISOEdition(hits, baseWanted);
      let record;
      if (base) record = await readRecord(base);
      else {
        const seeds = hits
          .map(historyEdition)
          .filter(
            (edition) =>
              edition && sameReference({ ...baseWanted, year: null }, reference(edition.reference)),
          );
        const history = await collectISOHistory(seeds, baseWanted, readRecord, signal);
        record = history.editions.find((edition) =>
          sameReference(baseWanted, reference(edition.reference)),
        );
      }
      current = record?.supplements?.find((item) =>
        sameReference(wanted, reference(item.reference)),
      );
      if (!current) {
        const error = new Error(
          'Указанная поправка не найдена в карточке этого издания ISO. Проверь обозначение поправки.',
        );
        error.code = 'ISO_SUPPLEMENT_NOT_FOUND';
        throw error;
      }
    }
    if (!current && wanted.year) {
      const seeds = hits
        .map(historyEdition)
        .filter(
          (edition) =>
            edition && sameReference({ ...wanted, year: null }, reference(edition.reference)),
        );
      seeds.sort(
        (a, b) =>
          Number(b.status === 'Published') - Number(a.status === 'Published') || b.year - a.year,
      );
      const history = await collectISOHistory(seeds, wanted, readRecord, signal);
      current = history.editions.find((edition) =>
        sameReference(wanted, reference(edition.reference)),
      );
      if (current) return current;
      if (history.editions.length) {
        throw new ISOEditionNotFoundError(wanted, history.editions, history.incomplete);
      }
    }
    if (!current)
      throw new Error(
        `В поиске ISO не найдено ${wanted.year ? 'указанного' : 'действующего опубликованного'} издания ${formatReference(wanted)}. Уточни обозначение или год.`,
      );
    const { previous, next, ...edition } = await readRecord(current);
    return edition;
  } catch (error) {
    signal?.throwIfAborted();
    if (
      ['ISO_EDITION_NOT_FOUND', 'ISO_SUPPLEMENT_NOT_FOUND'].includes(error.code) ||
      error.message.startsWith('В поиске ISO')
    )
      throw error;
    throw new Error('Не удалось получить данные издания из каталога ISO. Повтори поиск позже.');
  } finally {
    signal?.removeEventListener('abort', stop);
    await context.close().catch(() => {});
  }
}
async function resolveLatestISO(wanted, options) {
  if (!wanted || wanted.year) throw new Error('Для уточнения ISO нужно обозначение без года.');
  return resolveISOStandard(wanted, options);
}
module.exports = {
  reference,
  sameReference,
  formatReference,
  searchURL,
  officialURL,
  chooseCurrentISO,
  chooseISOEdition,
  resolveLatestISO,
  resolveISOStandard,
  internationalISOName,
  normalizeOfficialTitle,
  officialFullTitle,
  officialPDFName,
  cataloguePageCount,
  ISOEditionNotFoundError,
  collectISOHistory,
  catalogueSupplements,
};
