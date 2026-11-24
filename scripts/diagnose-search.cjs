'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path');
const {
  searchDocuments,
  searchQueries,
  searchAllDocuments,
  exactTitleMatches,
} = require('../search.cjs');
(async () => {
  const query = process.argv.slice(2).find((value) => !value.startsWith('--')) || 'ISO 129-1:2018',
    root = path.resolve(__dirname, '../.data/search-review');
  await fs.mkdir(root, { recursive: true });
  if (process.argv.includes('--probe-phases')) {
    const report = [];
    for (const exact of [true, false]) {
      let sentQuery;
      const rows = await searchDocuments(
        query,
        new AbortController().signal,
        async (url, options) => {
          sentQuery = new URL(url).searchParams.get('q');
          return fetch(url, options);
        },
        { exact },
      );
      const item = {
        phase: exact ? 'exact' : 'optimized',
        sentQuery,
        raw: rows.rawCount,
        candidates: rows
          .filter((row) => !exact || exactTitleMatches(query, row.title))
          .map(({ title, pageCount }) => ({ title, pageCount })),
        pagination: rows.pagination || null,
      };
      report.push(item);
      console.log(JSON.stringify(item));
    }
    await fs.writeFile(path.join(root, 'phase-probe.json'), JSON.stringify(report, null, 2));
    return;
  }
  if (process.argv.includes('--scan')) {
    const pages = [];
    const candidates = await searchAllDocuments(query, new AbortController().signal, console.log, {
      fetcher: async (url, options) => {
        const response = await fetch(url, options),
          html = await response.clone().text();
        const address = new URL(url),
          text = address.searchParams.get('q'),
          page = Number(address.searchParams.get('p'));
        await fs.writeFile(
          path.join(root, text.replace(/[^a-z\d]/gi, '_') + '-p' + page + '.html'),
          html,
        );
        pages.push({ query: text, page });
        return response;
      },
    });
    await fs.writeFile(
      path.join(root, 'scan.json'),
      JSON.stringify({ query, pages, candidates }, null, 2),
    );
    console.log(
      JSON.stringify({
        pages: pages.length,
        candidates: candidates.map((row) => ({
          title: row.title,
          pages: row.pageCount,
          url: row.url,
        })),
      }),
    );
    return;
  }
  const variants = searchQueries(query);
  const queries = process.argv.includes('--wide')
    ? [
        ...variants,
        variants[0].replace(/\s/g, '').replace(/:/g, '-'),
        variants[0].replace(/-/g, ' '),
      ]
    : variants.slice(0, 2);
  const report = [];
  for (const text of [...new Set(queries)])
    for (const page of process.argv.includes('--wide') ? [1] : [1, 2]) {
      let html = '';
      const name = text.replace(/[^a-z\d]/gi, '_') + '-p' + page + '.html';
      const rows = await searchDocuments(
        query,
        new AbortController().signal,
        async (url, options) => {
          const response = await fetch(url, options);
          html = await response.clone().text();
          await fs.writeFile(path.join(root, name), html);
          return response;
        },
        { page, searchText: text },
      );
      const anchors = [
        ...html.matchAll(/<a\b[^>]*class=["'][^"']*sd-title[^"']*["'][^>]*>[\s\S]*?<\/a>/gi),
      ].map((m) => ({
        title: m[0].match(/\btitle=["']([^"']*)["']/i)?.[1],
        url: m[0].match(/\bhref=["']([^"']+)["']/i)?.[1],
      }));
      const details = {
        query: text,
        page,
        raw: rows.rawCount,
        matched: rows.map((row) => ({ title: row.title, pages: row.pageCount, url: row.url })),
        titles: anchors,
        pagination: rows.pagination || null,
      };
      report.push(details);
      console.log(JSON.stringify(details));
    }
  await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
})().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
