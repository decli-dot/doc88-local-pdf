'use strict';
const { requestPublic } = require('./public-http.cjs');
const { plain, anchors } = require('./pdf-sources.cjs');
const designation = require('./dist/standard-reference.js');
function officialURL(value, publisher) {
  try {
    const url = new URL(
      value,
      publisher === 'ASME' ? 'https://www.asme.org' : 'https://www.dinmedia.de',
    );
    if (url.protocol !== 'https:' || url.port || url.username || url.password) return null;
    if (
      publisher !== 'ASME'
        ? url.hostname !== 'www.dinmedia.de' || !/^\/en\/standard\/[^/]+\/\d+$/.test(url.pathname)
        : url.hostname !== 'www.asme.org' ||
          !/^\/codes-standards\/find-codes-standards\/[^/]+(?:\/.*)?$/.test(url.pathname)
    )
      return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}
function pageCount(text) {
  const n = Number(text);
  return Number.isSafeInteger(n) && n > 0 && n <= 10000 ? n : null;
}
function jsonAssignment(html, name) {
  const assignment = html.indexOf('var ' + name + ' =');
  if (assignment < 0) return null;
  const property = html.indexOf('"products"', assignment);
  if (property < 0) return null;
  const start = html.indexOf('[', property);
  let depth = 0,
    quoted = false,
    escaped = false,
    text = '';
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (quoted) {
      text += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') quoted = true;
    if (c === '[') depth++;
    if (c === ']') depth--;
    if (c === ',' && /^[\s]*[}\]]/.test(html.slice(i + 1))) continue;
    text += c;
    if (!depth && c === ']') return { products: JSON.parse(text) };
  }
  return null;
}
function parseDIN(html, url) {
  const heading = plain(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1]);
  const found = designation.parse(heading),
    sourceURL = officialURL(url, found?.publisher);
  if (!found || !sourceURL || !found.year)
    throw Error('Карточка DIN не содержит подтверждённого обозначения издания.');
  const text = plain(html);
  const title = plain(
    html.match(/<h2\b[^>]*bwr-section-hero__subtitle[^>]*>([\s\S]*?)<\/h2>/i)?.[1],
  );
  return {
    publisher: found.publisher,
    catalogueSource: 'DIN Media',
    currentConfirmed: /\[\s*CURRENT\s*\]/i.test(text),
    reference: designation.format(found),
    title,
    year: Number(found.year),
    month: found.month,
    pageCount: pageCount(text.match(/\bPages\s+(\d+)/i)?.[1]),
    status: /\[\s*WITHDRAWN\s*\]/i.test(text)
      ? 'Withdrawn'
      : /\[\s*CURRENT\s*\]/i.test(text)
        ? 'Published'
        : 'Unknown',
    sourceURL,
    checkedAt: new Date().toISOString(),
    languages: [
      ...new Set(
        [
          ...text.matchAll(
            /(?:Language|translation|Original language)\s*:?\s*(English|German|French)\b/gi,
          ),
        ].map((m) => ({ english: 'eng', german: 'deu', french: 'fra' })[m[1].toLowerCase()]),
      ),
    ],
    related: anchors(html, sourceURL).filter(
      (item) =>
        officialURL(item.url, 'DIN') &&
        designation.same({ ...found, year: null, month: null }, designation.parse(item.text)),
    ),
  };
}
function parseASME(html, url) {
  const data = jsonAssignment(html, 'product_VWJS');
  if (!Array.isArray(data?.products)) throw Error('Карточка ASME не содержит данных изданий.');
  const records = data.products.flatMap((product) => {
    const label = 'ASME ' + String(product.Subtitle || '').replace(/\s+-\s+/g, '-');
    const found = designation.parse(label),
      sourceURL = officialURL(product.ProductURL || url, 'ASME');
    if (!found?.year || !sourceURL || product.IsPreOrder) return [];
    return [
      {
        publisher: 'ASME',
        reference: designation.format(found),
        year: Number(found.year),
        reaffirmed: found.reaffirmed,
        title: plain(product.TitleOverride || product.Title || '').replace(
          new RegExp('^' + found.number.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[-—]\\s*'),
          '',
        ),
        pageCount: pageCount(product.Pages),
        sourceURL,
        checkedAt: new Date().toISOString(),
        format: product.Format || product.FormatName || product.ProductType || '',
      },
    ];
  });
  const latest = Math.max(0, ...records.map((item) => item.year));
  for (const record of records) record.status = record.year === latest ? 'Published' : 'Historical';
  const unique = new Map();
  for (const item of records) {
    const key = item.reference;
    if (!unique.has(key) || /pdf|digital/i.test(item.format)) unique.set(key, item);
  }
  return [...unique.values()].sort((a, b) => b.year - a.year);
}
function strings(value) {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(strings);
}
class PublisherEditionChoice extends Error {
  constructor(wanted, editions) {
    super('Выберите существующее издание документа.');
    this.code = 'PUBLISHER_EDITION_CHOICE';
    this.editions = editions;
    this.requestedReference = designation.format(wanted);
  }
}
async function primaryEditions(
  wanted,
  { signal, request = requestPublic, chooseEdition = false } = {},
) {
  if (!['DIN', 'BS', 'NF', 'ASME'].includes(wanted?.publisher))
    throw Error('Неизвестный каталог издателя.');
  signal?.throwIfAborted();
  let urls = [];
  if (wanted.publisher !== 'ASME') {
    const home = (
      await request('https://www.dinmedia.de/en', { signal, hosts: ['dinmedia.de'] })
    ).bytes.toString('utf8');
    const tags = home.match(/<[^>]+data-app-id=[^>]+>/g) || [];
    const config = tags.find((tag) => /data-suggestion-index=/.test(tag));
    const app = config?.match(/data-app-id="([A-Z\d]+)"/)?.[1],
      key = config?.match(/data-api-key="([a-f\d]+)"/)?.[1];
    const index = home.match(/data-index-name="([^"<>]+)"/)?.[1];
    if (!app || !key || !/^[\w-]+$/.test(index || ''))
      throw Error('Поиск каталога DIN временно недоступен.');
    let hits = [];
    // A broad prefix query puts DIN 127xx and references in abstracts ahead of
    // the withdrawn DIN 127. Search the designation first, then national adoptions.
    const queries = [
      '"' + wanted.prefix + ' ' + wanted.number + '"',
      wanted.publisher + ' ' + wanted.number,
    ];
    for (const query of queries) {
      let pages = 1;
      const candidates = [];
      for (let page = 0; page < pages; page++) {
        signal?.throwIfAborted();
        const result = await request(
          `https://${app.toLowerCase()}-dsn.algolia.net/1/indexes/${index}/query`,
          {
            signal,
            method: 'POST',
            hosts: ['algolia.net'],
            headers: {
              'Content-Type': 'application/json',
              'X-Algolia-Application-Id': app,
              'X-Algolia-API-Key': key,
            },
            body: JSON.stringify({
              query,
              advancedSyntax: true,
              restrictSearchableAttributes: ['titel'],
              typoTolerance: false,
              queryType: 'prefixNone',
              removeWordsIfNoResults: 'none',
              hitsPerPage: 100,
              page,
            }),
          },
        );
        const data = JSON.parse(result.bytes.toString('utf8'));
        if (!Array.isArray(data.hits)) throw Error('Не удалось прочитать каталог DIN.');
        if (Number.isSafeInteger(data.nbPages) && data.nbPages > 0) pages = data.nbPages;
        candidates.push(...data.hits);
      }
      hits = candidates.filter(
        (hit) =>
          (!hit['dokument-typ'] || hit['dokument-typ'] === 'N') &&
          designation.catalogueFamily(wanted, designation.parse(hit.titel_DOK || hit.titel)),
      );
      const exact = hits.filter(
        (hit) => designation.parse(hit.titel_DOK || hit.titel).prefix === wanted.prefix,
      );
      if (exact.length) hits = exact;
      if (hits.length) break;
    }
    if (!wanted.year && !wanted.number.includes('-')) {
      const parts = hits.filter((hit) =>
        designation.parse(hit.titel_DOK || hit.titel).number.startsWith(wanted.number + '-'),
      );
      if (parts.length) {
        const latest = new Map();
        for (const hit of parts.sort(
          (a, b) =>
            Number(a['ist-zurueckgezogen'] || 0) - Number(b['ist-zurueckgezogen'] || 0) ||
            String(b.titel_DOK || b.titel).localeCompare(String(a.titel_DOK || a.titel), 'en', {
              numeric: true,
            }),
        )) {
          const found = designation.parse(hit.titel_DOK || hit.titel),
            key = found.prefix + ' ' + found.number;
          if (!latest.has(key)) latest.set(key, hit);
        }
        hits = [...latest.values()];
      }
    }
    if (wanted.year) {
      const dated = hits.filter((hit) => {
        const found = designation.parse(hit.titel_DOK || hit.titel);
        return designation.same({ ...wanted, prefix: found.prefix }, found);
      });
      if (dated.length) hits = dated;
    }
    urls = hits.flatMap((hit) => {
      const found = designation.parse(hit.titel_DOK || hit.titel);
      if (!designation.catalogueFamily(wanted, found) || !/^\d+$/.test(String(hit.objectID)))
        return [];
      const slug = (found.prefix + ' ' + found.number).toLowerCase().replace(/[^a-z\d]+/g, '-');
      return ['https://www.dinmedia.de/en/standard/' + slug + '/' + hit.objectID];
    });
    if (!urls.length)
      urls.push(
        ...strings(hits).flatMap((value) => {
          const url = officialURL(value, 'DIN');
          return url ? [url] : [];
        }),
      );
  } else {
    const home = (
      await request('https://www.asme.org/', { signal, hosts: ['asme.org'] })
    ).bytes.toString('utf8');
    const key = home.match(/var\s+searchEngineKey\s*=\s*"([^"<>]+)"/)?.[1];
    if (!key) throw Error('Поиск каталога ASME временно недоступен.');
    const result = await request(
      'https://search-api.swiftype.com/api/v1/public/engines/search.json',
      {
        signal,
        method: 'POST',
        hosts: ['swiftype.com'],
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ engine_key: key, q: wanted.number, page: 1, per_page: 100 }),
      },
    );
    urls = strings(JSON.parse(result.bytes.toString('utf8'))).flatMap((value) => {
      const url = officialURL(value, 'ASME');
      return url ? [url] : [];
    });
  }
  urls = [...new Set(urls)];
  if (wanted.publisher === 'ASME') urls = urls.slice(0, 10);
  const editions = [];
  const visited = new Set();
  while (urls.length && (wanted.publisher !== 'ASME' || visited.size < 16)) {
    signal?.throwIfAborted();
    const url = urls.shift();
    if (visited.has(url)) continue;
    visited.add(url);
    let records;
    try {
      const html = (
        await request(url, {
          signal,
          hosts: [wanted.publisher === 'ASME' ? 'asme.org' : 'dinmedia.de'],
        })
      ).bytes.toString('utf8');
      records = wanted.publisher === 'ASME' ? parseASME(html, url) : [parseDIN(html, url)];
    } catch (error) {
      if (signal?.aborted) throw error;
      continue;
    }
    for (const record of records) {
      if (!designation.catalogueFamily(wanted, designation.parse(record.reference))) continue;
      editions.push(record);
      if (
        wanted.year &&
        record.title &&
        record.pageCount &&
        record.status !== 'Unknown' &&
        designation.same(
          { ...wanted, prefix: designation.parse(record.reference).prefix },
          designation.parse(record.reference),
        )
      )
        return editions;
      if (
        !wanted.year &&
        !chooseEdition &&
        record.status === 'Published' &&
        designation.family(wanted, designation.parse(record.reference)) &&
        designation.parse(record.reference).prefix === wanted.prefix
      )
        urls = [];
      if (wanted.publisher === 'ASME') urls = [];
      if (
        (wanted.year || chooseEdition) &&
        wanted.publisher !== 'ASME' &&
        designation.family(wanted, designation.parse(record.reference))
      )
        urls.push(...(record.related || []).map((item) => item.url));
    }
  }
  return editions;
}
function choosePublisherEdition(wanted, editions, { chooseEdition = false } = {}) {
  if (
    ['DIN', 'BS', 'NF'].includes(wanted.publisher) &&
    !wanted.year &&
    !wanted.number.includes('-')
  ) {
    const parts = editions.filter((edition) => {
      const found = designation.parse(edition.reference);
      return (
        designation.catalogueFamily(wanted, found) &&
        found.number !== wanted.number &&
        /^(Published|Withdrawn|Historical)$/.test(edition.status)
      );
    });
    if (parts.length) {
      const latest = new Map();
      for (const { related, format, ...edition } of parts.sort(
        (a, b) =>
          Number(b.status === 'Published') - Number(a.status === 'Published') ||
          b.reference.localeCompare(a.reference, 'en', { numeric: true }),
      )) {
        const found = designation.parse(edition.reference),
          key = found.prefix + ' ' + found.number;
        if (!latest.has(key)) latest.set(key, edition);
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
  let unique = [
    ...new Map(
      editions
        .filter((record) => designation.family(wanted, designation.parse(record.reference)))
        .map(({ related, format, ...item }) => [item.reference, item]),
    ).values(),
  ].sort((a, b) => b.reference.localeCompare(a.reference, 'en', { numeric: true }));
  const exact = unique.filter((item) => designation.parse(item.reference).prefix === wanted.prefix);
  if (exact.some((item) => wanted.year || chooseEdition || item.status === 'Published'))
    unique = exact;
  if (chooseEdition && !wanted.year) {
    const choices = unique.filter((item) => /^(Published|Withdrawn|Historical)$/.test(item.status));
    if (choices.length) {
      const choice = new PublisherEditionChoice(wanted, choices);
      choice.message = 'Год не указан. Выберите издание документа.';
      throw choice;
    }
  }
  const matching = unique.filter(
    (item) =>
      designation.same(
        { ...wanted, prefix: designation.parse(item.reference).prefix },
        designation.parse(item.reference),
      ) &&
      (wanted.year || item.status === 'Published'),
  );
  const prefixes = new Set(matching.map((item) => designation.parse(item.reference).prefix));
  if (prefixes.size > 1) throw new PublisherEditionChoice(wanted, matching);
  const found = matching[0];
  if (found?.title && found.pageCount && found.status !== 'Unknown') return found;
  if (unique.length && wanted.year) throw new PublisherEditionChoice(wanted, unique);
  throw Error('Не удалось подтвердить издание и число страниц в каталоге.');
}
async function resolvePrimaryPublisher(wanted, options = {}) {
  if (wanted.publisher === 'EN') return require('./en-catalog.cjs').resolveEN(wanted, options);
  options = {
    ...options,
    signal: AbortSignal.any([
      ...(options.signal ? [options.signal] : []),
      AbortSignal.timeout(60000),
    ]),
  };
  let records = [],
    failure;
  try {
    records = await primaryEditions(wanted, options);
    return choosePublisherEdition(wanted, records, options);
  } catch (error) {
    if (options.signal?.aborted || error.code === 'PUBLISHER_EDITION_CHOICE') throw error;
    failure = error;
  }
  try {
    const extra = await require('./reseller-catalog.cjs').resellerEditions(wanted, options);
    return choosePublisherEdition(wanted, [...records, ...extra], options);
  } catch (error) {
    if (options.signal?.aborted || error.code === 'PUBLISHER_EDITION_CHOICE') throw error;
    throw failure || error;
  }
}
async function resolvePublisher(wanted, options = {}) {
  return require('./iteh-catalog.cjs').withITEHFallback(resolvePrimaryPublisher, wanted, options);
}
module.exports = {
  officialURL,
  parseDIN,
  parseASME,
  jsonAssignment,
  resolvePublisher,
  primaryEditions,
  choosePublisherEdition,
  PublisherEditionChoice,
};
