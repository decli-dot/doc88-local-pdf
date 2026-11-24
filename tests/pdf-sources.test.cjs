const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { parseSourceResults, searchPDFSources, downloadSourcePDF } = require('../pdf-sources.cjs');
const { webURL, publicAddress } = require('../public-http.cjs');
const { titleMatches } = require('../search.cjs');
const hash = 'a'.repeat(32);
const html = `<table><tr><td><a href="book/index.php?md5=${hash}">ISO 17450-1:2011</a></td><td>PDF 32 pages</td></tr><tr><td><a href="book/index.php?md5=${'b'.repeat(32)}">DIN EN ISO 17450-1:2011</a></td><td>PDF</td></tr></table>`;
test('PDF providers require exact document identities and fail independently', async () => {
  assert.equal(parseSourceResults(html, 'libgen', 'ISO 17450-1:2011', titleMatches).length, 1);
  const anna = `<a href="/md5/${hash}"><div>ISO 17450-1:2011</div></a><div>English PDF 32 pages</div>`;
  assert.equal(parseSourceResults(anna, 'anna', 'ISO 17450-1:2011', titleMatches)[0].pageCount, 32);
  assert.equal(
    parseSourceResults(
      anna + '<footer>FAQ: what is a captcha?</footer>',
      'anna',
      'ISO 17450-1:2011',
      titleMatches,
    ).length,
    1,
  );
  assert.throws(() =>
    parseSourceResults('<h1>Welcome to nginx!</h1>', 'libgen', 'ISO 17450', titleMatches),
  );
  const logs = [];
  const results = await searchPDFSources(
    'ISO 17450-1:2011',
    new AbortController().signal,
    titleMatches,
    {
      request: async (url) => {
        if (url.includes('annas-archive')) throw Error('Timeout');
        return { bytes: Buffer.from(html) };
      },
      log: (line) => logs.push(line),
    },
  );
  assert.equal(results.length, 1);
  assert.match(logs[0], /anna/);
});
test('untrusted source links cannot target local networks and downloaded files must actually be PDF', async (t) => {
  for (const url of [
    'http://libgen.bz/book/1',
    'https://127.0.0.1/test.pdf',
    'https://user:pass@libgen.bz/',
    'https://libgen.bz:8000/',
    'https://libgen.bz.evil.test/',
  ])
    assert.throws(() => webURL(url, ['libgen.bz']));
  for (const ip of [
    '127.0.0.1',
    '10.0.0.2',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '::1',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
  ])
    assert.equal(publicAddress(ip), false);
  assert.equal(publicAddress('1.1.1.1'), true);
  assert.equal(publicAddress('2606:4700:4700::1111'), true);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'declipdf-source-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('declipdf-source-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const job = {
    provider: 'libgen',
    url: `https://libgen.bz/book/index.php?md5=${hash}`,
    directory,
    controller: new AbortController(),
    update() {},
  };
  let requests = 0;
  await downloadSourcePDF(job, {
    request: async (url) => {
      requests++;
      return requests === 1
        ? { bytes: Buffer.from('<a href="https://library.lol/get/file.pdf">GET</a>'), url }
        : { bytes: Buffer.from('%PDF-1.7\nSynthetic fixture'), url };
    },
  });
  assert.equal(requests, 2);
  assert.match(await fs.readFile(path.join(directory, 'source.pdf'), 'utf8'), /^%PDF/);
  const annaJob = { ...job, provider: 'anna', url: 'https://annas-archive.pk/md5/' + hash };
  await downloadSourcePDF(annaJob, {
    request: async (url) =>
      url.includes('/md5/')
        ? {
            bytes: Buffer.from(
              '<a href="/slow_download/id/0">Slow download</a><a href="https://library.lol/main/' +
                hash +
                '">Libgen mirror</a><footer>FAQ: captcha</footer>',
            ),
            url,
          }
        : { bytes: Buffer.from('%PDF-1.7\nSynthetic fixture'), url },
  });
  await assert.rejects(
    downloadSourcePDF(job, {
      request: async (url) => ({ bytes: Buffer.from('<html>Not a document</html>'), url }),
    }),
    /ссылка/,
  );
});
