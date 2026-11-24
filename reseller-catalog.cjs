'use strict';
const { requestPublic } = require('./public-http.cjs');
const { plain, anchors } = require('./pdf-sources.cjs');
const designation = require('./dist/standard-reference.js');
function catalogueURL(value) {
  try {
    const url = new URL(value, 'https://www.en-standard.eu');
    return url.protocol === 'https:' &&
      url.hostname === 'www.en-standard.eu' &&
      !url.port &&
      !url.username &&
      !url.password &&
      /^\/(?:din|bs|nf|asme)[a-z\d-]+\/?$/i.test(url.pathname)
      ? url.href
      : null;
  } catch {
    return null;
  }
}
function parseReseller(html, url) {
  const label = plain(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1]);
  const heading = designation.parse(label),
    sourceURL = catalogueURL(url);
  if (!heading || !sourceURL) throw Error('В карточке отсутствует подтверждённое обозначение.');
  const fields = new Map(
    [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) => {
      const cells = [...match[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) =>
        plain(cell[1]),
      );
      return [
        String(cells[0] || '')
          .replace(/:$/, '')
          .toLowerCase(),
        cells[1] || '',
      ];
    }),
  );
  const published = fields.get('released');
  const table = designation.parse(fields.get('standard number') || label);
  if (!designation.same({ ...heading, year: null, month: null, day: null, amendment: null }, table))
    throw Error('Обозначения в карточке каталога расходятся.');
  let found = table;
  if (!found.year && ['DIN', 'BS', 'NF'].includes(found.publisher)) {
    const date = published?.match(
      /^((?:19|20)\d{2})(?:-(0[1-9]|1[0-2]))?(?:-(0[1-9]|[12]\d|3[01]))?$/,
    );
    if (date) found = { ...found, year: date[1], month: date[2] || null, day: date[3] || null };
  }
  if (!found.year) throw Error('В карточке не подтверждён год издания.');
  const pageCount = Number(fields.get('pages'));
  if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > 10000)
    throw Error('В каталоге не указан объём документа.');
  const state = fields.get('status') || '';
  return {
    publisher: found.publisher,
    reference: designation.format(found),
    year: Number(found.year),
    month: found.month,
    day: found.day,
    title: plain(html.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i)?.[1]),
    pageCount,
    status: /withdrawn|superseded/i.test(state) ? 'Withdrawn' : 'Published',
    currentConfirmed: /current|valid/i.test(state),
    publicationDate: published || null,
    catalogueSource: 'EN Standards',
    sourceURL,
    checkedAt: new Date().toISOString(),
  };
}
async function resellerEditions(wanted, { signal, request = requestPublic } = {}) {
  const base = wanted.prefix + ' ' + wanted.number;
  const variants =
    wanted.prefix === wanted.publisher
      ? [
          base,
          wanted.publisher + ' EN ISO ' + wanted.number,
          wanted.publisher + ' EN ' + wanted.number,
          wanted.publisher + ' ISO ' + wanted.number,
        ]
      : [base];
  const urls = new Set();
  for (const query of variants) {
    signal?.throwIfAborted();
    const result = await request('https://www.en-standard.eu/search/', {
      signal,
      hosts: ['en-standard.eu'],
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        send: '1',
        listpos: '0',
        advs: '1',
        as_search: query,
      }).toString(),
    });
    for (const link of anchors(
      result.bytes.toString('utf8'),
      result.url || 'https://www.en-standard.eu/search/',
    )) {
      const url = catalogueURL(link.url);
      if (!url) continue;
      const found = designation
        .references(link.title + ' ' + link.text, wanted.publisher)
        .find((item) => designation.catalogueFamily(wanted, item));
      if (found) urls.add(url);
    }
    if (urls.size) break;
  }
  const editions = [];
  for (const url of [...urls].slice(0, 10)) {
    signal?.throwIfAborted();
    try {
      const response = await request(url, { signal, hosts: ['en-standard.eu'] });
      const record = parseReseller(response.bytes.toString('utf8'), url);
      if (designation.catalogueFamily(wanted, designation.parse(record.reference)))
        editions.push(record);
    } catch (error) {
      if (signal?.aborted) throw error;
    }
  }
  return editions;
}
module.exports = { catalogueURL, parseReseller, resellerEditions };
