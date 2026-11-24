'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { requestPublic, webURL } = require('./public-http.cjs');
const { atomicWrite } = require('./checkpoints.cjs');
const SOURCES = { libgen: 'https://libgen.bz', anna: 'https://annas-archive.pk' };
function plain(html) {
  return String(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(
      /&(?:nbsp|amp|quot|lt|gt);/g,
      (s) => ({ '&nbsp;': ' ', '&amp;': '&', '&quot;': '"', '&lt;': '<', '&gt;': '>' })[s],
    )
    .replace(/&#(\d+);/g, (_, n) => (Number(n) <= 0x10ffff ? String.fromCodePoint(Number(n)) : ''))
    .replace(/\s+/g, ' ')
    .trim();
}
function anchors(html, base) {
  return [
    ...String(html).matchAll(/<a\b([^>]*?)href\s*=\s*["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi),
  ].flatMap((match) => {
    try {
      return [
        {
          url: new URL(match[2].replace(/&amp;/g, '&'), base).href,
          text: plain(match[4]),
          title: plain((match[1] + match[3]).match(/title=["']([^"']+)/i)?.[1] || ''),
        },
      ];
    } catch {
      return [];
    }
  });
}
function parseSourceResults(html, provider, query, matches) {
  if (blockedHTML(html)) throw Error('Источник сейчас недоступен или требует проверки доступа.');
  const base = SOURCES[provider],
    seen = new Set(),
    results = [];
  const blocks =
    provider === 'libgen' ? html.split(/<tr\b/i) : html.split(/(?=<a\b[^>]*href=["']\/md5\/)/i);
  for (const block of blocks) {
    const links = anchors(block, base);
    const entry = links.find((item) =>
      provider === 'anna'
        ? /\/md5\/[a-f\d]{32}(?:[?#]|$)/i.test(item.url)
        : /(?:book\/index\.php\?md5=|ads\.php\?md5=|main\/[^/?]+|book\/[a-f\d]{32})/i.test(
            item.url,
          ),
    );
    if (!entry) continue;
    const title = entry.title || entry.text;
    if (!title || !matches(query, title) || seen.has(entry.url)) continue;
    try {
      webURL(entry.url, [new URL(base).hostname]);
    } catch {
      continue;
    }
    const text = plain(block);
    if (/\b(?:EPUB|DJVU|MOBI)\b/i.test(text) && !/\bPDF\b/i.test(text)) continue;
    seen.add(entry.url);
    const pageCount = Number(text.match(/\b(\d{1,4})\s+(?:pages|pp\.)/i)?.[1]) || null;
    results.push({
      provider,
      url: entry.url,
      title,
      pageCount,
      format: 'PDF',
      status: 'unverified',
      checks: null,
    });
  }
  return results.slice(0, 8);
}
async function searchPDFSources(
  query,
  signal,
  matches,
  { request = requestPublic, log = () => {} } = {},
) {
  const results = await Promise.all(
    Object.entries(SOURCES).map(async ([provider, base]) => {
      const url = new URL(provider === 'libgen' ? '/index.php' : '/search', base);
      url.search = new URLSearchParams(
        provider === 'libgen'
          ? { req: query, res: '100', column: 'title', phrase: '1' }
          : { q: query, ext: 'pdf', sort: 'relevance' },
      ).toString();
      try {
        const response = await request(url.href, { signal, hosts: [new URL(base).hostname] });
        return parseSourceResults(response.bytes.toString('utf8'), provider, query, matches);
      } catch (error) {
        if (signal.aborted) throw error;
        log(`${provider}: ${error.message}`);
        return [];
      }
    }),
  );
  return results.flat();
}
async function downloadSourcePDF(job, { request = requestPublic } = {}) {
  if (!SOURCES[job.provider]) throw Error('Неизвестный источник PDF.');
  const filename = path.join(job.directory, 'source.pdf');
  job.update({ stage: 'downloading', message: 'Получаем исходный PDF…' });
  let url = webURL(job.url, [new URL(SOURCES[job.provider]).hostname]).href;
  const visited = new Set();
  for (let depth = 0; depth < 5; depth++) {
    job.controller.signal.throwIfAborted();
    if (visited.has(url)) throw Error('Источник вернул повторяющуюся ссылку скачивания.');
    visited.add(url);
    const response = await request(url, {
      signal: job.controller.signal,
      maxBytes: 250 * 1024 * 1024,
      timeoutMs: 120000,
    });
    if (response.bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) {
      await fs.mkdir(job.directory, { recursive: true });
      await atomicWrite(filename, response.bytes);
      return filename;
    }
    const html = response.bytes.toString('utf8');
    if (
      blockedHTML(html) ||
      (/\/slow_download\//i.test(url) && /wait\s+\d+\s+seconds/i.test(plain(html)))
    )
      throw Error(
        'Источник требует ручного подтверждения или ожидания. Автоматическое скачивание недоступно.',
      );
    const links = anchors(html, response.url || url);
    const next =
      links.find(
        (item) =>
          /\.pdf(?:[?#]|$)|\/get\.php\?|\/get\/[a-f\d]|\/main\/[a-f\d]|\/ads\.php\?/i.test(
            item.url,
          ) && /(?:GET|PDF|download|скачать|mirror|libgen)/i.test(item.text + ' ' + item.title),
      ) ||
      links.find((item) => /^\s*(?:GET|Download|Download now|Скачать)\s*$/i.test(item.text)) ||
      links.find(
        (item) =>
          item.url.startsWith(SOURCES.anna + '/slow_download/') && /download/i.test(item.text),
      );
    if (!next) throw Error('Прямая ссылка на PDF не найдена.');
    url = webURL(next.url).href;
  }
  throw Error('Не удалось получить PDF из источника.');
}
function blockedHTML(html) {
  return /Welcome to nginx!|<title[^>]*>\s*Just a moment|Checking your browser|cf-chl-|class=["'][^"']*(?:g-recaptcha|cf-turnstile)/i.test(
    html,
  );
}
module.exports = {
  SOURCES,
  plain,
  anchors,
  parseSourceResults,
  searchPDFSources,
  downloadSourcePDF,
};
