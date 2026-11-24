'use strict';
const designation = require('./dist/standard-reference.js');
const { requestPublic } = require('./public-http.cjs');

// DIN Media is a CEN member catalogue. Read the European reference explicitly
// printed in its description; the national adoption date is not the EN date.
function recordsFromHits(hits, wanted) {
  const result = new Map();
  for (const hit of hits) {
    if (hit['dokument-typ'] !== 'N' || !/^\d+$/.test(String(hit.objectID))) continue;
    const subtitle = String(hit.untertitel_en || '').normalize('NFKC');
    for (const match of subtitle.matchAll(
      /\bEN\s+(?:ISO\s+)?\d+(?:-\d+)*:\d{4}(?:\+(?:A\d+|AC):\d{4})?/g,
    )) {
      const reference = match[0].replace(/\s+/g, ' '),
        found = designation.parse(reference);
      if (
        !found ||
        (found.number !== wanted.number &&
          !(!wanted.number.includes('-') && found.number.startsWith(wanted.number + '-')))
      )
        continue;
      if (wanted.prefix !== 'EN' && wanted.prefix !== found.prefix) continue;
      const record = {
        publisher: 'EN',
        reference,
        title: subtitle.split(/;\s*(?:German|English|French|Trilingual)/i)[0].trim(),
        year: Number(found.year),
        status: hit['ist-zurueckgezogen'] ? 'Withdrawn' : 'Published',
        pageCount: null,
        extentPolicy: 'source',
        sourceURL:
          'https://www.dinmedia.de/en/standard/' +
          String(hit.titel_DOK || hit.titel)
            .split(':')[0]
            .toLowerCase()
            .replace(/[^a-z\d]+/g, '-') +
          '/' +
          hit.objectID,
        checkedAt: new Date().toISOString(),
        languages: ['eng', 'deu', 'fra'],
        catalogue: 'DIN Media / CEN',
      };
      const old = result.get(reference);
      if (!old || record.status === 'Published') result.set(reference, record);
    }
  }
  return [...result.values()];
}
function chooseEN(wanted, records, { chooseEdition = false } = {}) {
  const current = records.filter((item) => item.status === 'Published');
  if (!wanted.year && !wanted.number.includes('-')) {
    const parts = current.filter((item) =>
      designation.parse(item.reference).number.startsWith(wanted.number + '-'),
    );
    if (parts.length) {
      const latest = new Map();
      for (const item of parts.sort((a, b) => b.year - a.year)) {
        const n = designation.parse(item.reference).number;
        if (!latest.has(n)) latest.set(n, item);
      }
      return {
        series: true,
        reference: designation.format(wanted),
        items: [...latest.values()].sort((a, b) =>
          a.reference.localeCompare(b.reference, 'en', { numeric: true }),
        ),
      };
    }
  }
  const family = records
    .filter((item) => designation.parse(item.reference).number === wanted.number)
    .sort((a, b) => b.reference.localeCompare(a.reference, 'en', { numeric: true }));
  if (chooseEdition && !wanted.year && family.length)
    throw Object.assign(Error('Год не указан. Выберите издание документа.'), {
      code: 'PUBLISHER_EDITION_CHOICE',
      editions: family,
      requestedReference: designation.format(wanted),
    });
  const found = family.find(
    (item) =>
      designation.same(wanted, designation.parse(item.reference)) &&
      (wanted.year || item.status === 'Published'),
  );
  if (found) return found;
  if (family.length && wanted.year)
    throw Object.assign(Error('Выберите существующее издание документа.'), {
      code: 'PUBLISHER_EDITION_CHOICE',
      editions: family,
      requestedReference: designation.format(wanted),
    });
  throw Error('Обозначение EN не найдено в каталоге издателя.');
}
async function resolveEN(wanted, { signal, request = requestPublic, chooseEdition = false } = {}) {
  const home = (
    await request('https://www.dinmedia.de/en', { signal, hosts: ['dinmedia.de'] })
  ).bytes.toString();
  const config = (home.match(/<[^>]+data-app-id=[^>]+>/g) || []).find((tag) =>
    /data-suggestion-index=/.test(tag),
  );
  const app = config?.match(/data-app-id="([A-Z\d]+)"/)?.[1],
    key = config?.match(/data-api-key="([a-f\d]+)"/)?.[1],
    index = home.match(/data-index-name="([^"<>]+)"/)?.[1];
  if (!app || !key || !/^[\w-]+$/.test(index || '')) throw Error('Каталог EN временно недоступен.');
  const hits = [];
  for (let page = 0; page < 30; page++) {
    signal?.throwIfAborted();
    const response = await request(
      `https://${app.toLowerCase()}-dsn.algolia.net/1/indexes/${index}/query`,
      {
        signal,
        hosts: ['algolia.net'],
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Algolia-Application-Id': app,
          'X-Algolia-API-Key': key,
        },
        body: JSON.stringify({
          query: wanted.prefix + ' ' + wanted.number,
          hitsPerPage: 100,
          page,
        }),
      },
    );
    const data = JSON.parse(response.bytes.toString());
    hits.push(...(data.hits || []));
    if (page + 1 >= data.nbPages || (data.hits || []).length < 100)
      return chooseEN(wanted, recordsFromHits(hits, wanted), { chooseEdition });
  }
  throw Error('Каталог вернул слишком много вариантов. Уточните обозначение EN.');
}
module.exports = { recordsFromHits, chooseEN, resolveEN };
