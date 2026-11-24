'use strict';
const { requestPublic } = require('./public-http.cjs');
const designation = require('./dist/standard-reference.js');
const iso = require('./iso-catalog.cjs');
function parseITEH(payload, wanted, language = 'eng') {
  const target = wanted.publisher ? designation.format(wanted) : iso.formatReference(wanted);
  const languages = { en: 'eng', de: 'deu', fr: 'fra', ru: 'rus' };
  const records = [];
  for (const item of payload.data || []) {
    const ref = String(item.projectReference || '').trim();
    const parsed = wanted.publisher ? designation.parse(ref) : iso.reference(ref);
    if (
      !parsed ||
      (wanted.publisher
        ? !designation.catalogueFamily(wanted, parsed)
        : !iso.internationalISOName(ref) || !iso.sameReference({ ...wanted, year: null }, parsed))
    )
      continue;
    const docs = (item.projectDocuments || []).filter(
      (d) =>
        d.type?.value === 'Standard' &&
        Number.isSafeInteger(d.numberOfPages) &&
        d.numberOfPages > 0 &&
        d.numberOfPages < 10000 &&
        languages[d.language?.externalCode] === language,
    );
    if (!docs.length || !item.title || !/^[a-f\d-]{36}$/.test(item.id || '')) continue;
    const counts = new Set(docs.map((d) => d.numberOfPages));
    if (counts.size !== 1) continue;
    const prefix = String(
      item.organization?.externalCode || parsed.publisher || parsed.organization || '',
    ).toLowerCase();
    if (!/^[a-z]+$/.test(prefix)) continue;
    records.push({
      publisher: parsed.publisher || 'ISO',
      reference: ref,
      title: item.title,
      year: Number(parsed.year),
      pageCount: docs[0].numberOfPages,
      languages: [
        ...new Set(
          (item.projectDocuments || [])
            .map((d) => languages[d.language?.externalCode])
            .filter(Boolean),
        ),
      ],
      pageCountsByLanguage: Object.fromEntries(
        (item.projectDocuments || [])
          .filter(
            (d) =>
              d.type?.value === 'Standard' &&
              languages[d.language?.externalCode] &&
              Number.isSafeInteger(d.numberOfPages) &&
              d.numberOfPages > 0,
          )
          .map((d) => [languages[d.language.externalCode], d.numberOfPages]),
      ),
      status:
        item.standardStatus?.value === 'Published'
          ? 'Published'
          : item.standardStatus?.value === 'Withdrawn'
            ? 'Withdrawn'
            : 'Unknown',
      currentConfirmed: item.standardStatus?.value === 'Published',
      catalogueSource: 'iTeh',
      sourceURL:
        'https://standards.iteh.ai/catalog/standards/' +
        prefix +
        '/' +
        item.id +
        '/' +
        ref.toLowerCase().replace(/[^a-z\d]+/g, '-'),
      checkedAt: new Date().toISOString(),
    });
  }
  return records;
}
async function iteHRecords(wanted, { signal, request = requestPublic, language = 'eng' } = {}) {
  const term = wanted.publisher ? designation.format(wanted) : iso.formatReference(wanted);
  const records = [];
  for (let page = 1; ; page++) {
    signal?.throwIfAborted();
    let response;
    try {
      response = await request('https://standards.iteh.ai/api/catalog/search', {
        signal,
        hosts: ['iteh.ai'],
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ term, page, pageSize: 100, statusesFilter: ['P', 'W'], sortBy: 1 }),
      });
    } catch (error) {
      if (request !== requestPublic || !/HTTP 403/.test(error.message)) throw error;
      return browserRecords(wanted, { signal, language });
    }
    const payload = JSON.parse(response.bytes.toString('utf8'));
    if (!Array.isArray(payload.data)) throw Error('Не удалось прочитать резервный каталог iTeh.');
    records.push(...parseITEH(payload, wanted, language));
    if (!payload.data.length || page * 100 >= Number(payload.total || 0)) break;
  }
  return records;
}
async function browserRecords(wanted, { signal, language }) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({
    headless: true,
    channel: require('./runtime.cjs').browserChannel(),
  });
  const context = await browser.newContext();
  const stop = () => {
    void context.close().catch(() => {});
  };
  signal?.addEventListener('abort', stop, { once: true });
  try {
    signal?.throwIfAborted();
    const page = await context.newPage();
    await page.goto('https://standards.iteh.ai/catalog/search', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    const term = wanted.publisher
      ? designation.format({ ...wanted, year: null, month: null, day: null, reaffirmed: null })
      : iso.formatReference({ ...wanted, year: null });
    await page.locator('[name=searchTerm]').fill(term);
    const response = page.waitForResponse(
      (r) => {
        if (!r.url().endsWith('/api/catalog/search') || r.request().method() !== 'POST')
          return false;
        try {
          return JSON.parse(r.request().postData()).term === term;
        } catch {
          return false;
        }
      },
      { timeout: 30000 },
    );
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    const result = await response;
    if (!result.ok()) throw Error('Резервный каталог iTeh недоступен.');
    return parseITEH(await result.json(), wanted, language);
  } finally {
    signal?.removeEventListener('abort', stop);
    await context.close().catch(() => {});
    await browser.close();
  }
}
async function resolveITEH(wanted, options = {}) {
  const records = await iteHRecords(wanted, options);
  if (wanted.publisher)
    return require('./publisher-catalog.cjs').choosePublisherEdition(wanted, records, options);
  if (options.chooseEdition && !wanted.year) {
    const editions = [
      ...new Map(
        records
          .filter((record) => /^(Published|Withdrawn)$/.test(record.status))
          .map((record) => [record.reference, record]),
      ).values(),
    ].sort(
      (a, b) =>
        Number(b.status === 'Published') - Number(a.status === 'Published') || b.year - a.year,
    );
    if (editions.length)
      return { choice: true, reference: iso.formatReference(wanted), editions, incomplete: false };
  }
  const found = records
    .filter(
      (r) =>
        iso.sameReference(wanted, iso.reference(r.reference)) &&
        (wanted.year || r.status === 'Published'),
    )
    .sort((a, b) => b.year - a.year)[0];
  if (!found) throw Error('В резервном каталоге iTeh не подтверждено нужное издание и его объём.');
  return found;
}
async function withITEHFallback(primary, wanted, options) {
  try {
    return await primary(wanted, options);
  } catch (error) {
    options.signal?.throwIfAborted();
    if (/EDITION_(?:NOT_FOUND|CHOICE)|SUPPLEMENT_NOT_FOUND/.test(error.code || '')) throw error;
    try {
      return await resolveITEH(wanted, options);
    } catch (fallbackError) {
      options.signal?.throwIfAborted();
      if (/EDITION_(?:NOT_FOUND|CHOICE)|SUPPLEMENT_NOT_FOUND/.test(fallbackError.code || ''))
        throw fallbackError;
      throw error;
    }
  }
}
module.exports = { parseITEH, iteHRecords, resolveITEH, withITEHFallback };
