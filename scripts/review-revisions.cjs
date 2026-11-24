'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path');
const { requestPublic } = require('../public-http.cjs');
const root = path.resolve(__dirname, '../.data/revision-review');
(async () => {
  await fs.mkdir(root, { recursive: true });
  if (process.argv.includes('--din-preview')) {
    const edition = await require('../publisher-catalog.cjs').resolvePublisher(
      require('../dist/standard-reference.js').parse('DIN 129-1'),
    );
    await fs.writeFile(
      path.join(root, 'din129-catalog-live.json'),
      JSON.stringify(edition, null, 2),
    );
    console.log(
      JSON.stringify({
        reference: edition.reference,
        languages: require('../dist/ocr-language.js').choices(edition.reference, edition),
      }),
    );
    const saved = JSON.parse(
      await fs.readFile(
        path.resolve(__dirname, '../.data/engine-validation/din-276/auto/job.json'),
        'utf8',
      ),
    );
    const results = [];
    for (const language of ['eng', 'deu']) {
      const job = {
        ...saved,
        query: saved.resolvedQuery,
        url: saved.url,
        directory: path.join(root, 'din-preview'),
        documentLanguage: language,
        ocrLanguage: language,
        controller: new AbortController(),
        update(value) {
          Object.assign(this, value);
        },
        log: console.log,
      };
      try {
        const proof = await require('../preview-document.cjs').previewCandidate(
          job,
          path.resolve(__dirname, '../.data'),
          saved.catalogueEdition,
        );
        results.push({ language, status: 'passed', proof });
      } catch (error) {
        results.push({ language, status: 'rejected', code: error.code, message: error.message });
        if (!['FOREIGN_LANGUAGE', 'FOREIGN_SCRIPT', 'DOCUMENT_MISMATCH'].includes(error.code))
          throw error;
      }
      console.log(JSON.stringify(results.at(-1)));
    }
    await fs.writeFile(
      path.join(root, 'din-preview-results.json'),
      JSON.stringify(results, null, 2),
    );
    if (results[0].code !== 'FOREIGN_LANGUAGE' || results[1].status !== 'passed')
      throw Error('Unexpected DIN language verification');
    return;
  }
  if (process.argv.includes('--qa')) {
    const job = JSON.parse(await fs.readFile(path.join(root, 'iso17450-live/job.json'), 'utf8'));
    const report = await require('../experimental/quality.cjs').inspectPDF(
      path.join(root, 'iso17450-live/result.pdf'),
      path.join(root, 'iso17450-qa'),
      job.isoEdition,
      {
        samples: [1, 9, 15],
        language: 'eng',
        recognizedPages: Array.from({ length: 22 }, (_, i) => i + 1),
      },
    );
    console.log(
      JSON.stringify({
        pages: report.pages,
        language: report.language.status,
        identity: report.identity.status,
        extent: report.extent.status,
        ready: report.ready,
      }),
    );
    return;
  }
  if (process.argv.includes('--validate')) {
    const en = await require('../en-catalog.cjs').resolveEN(
      require('../dist/standard-reference.js').parse('EN 14420'),
      {
        request: async (url, options) => {
          console.log('Catalogue request: ' + new URL(url).hostname);
          return requestPublic(url, { ...options, timeoutMs: 60000 });
        },
      },
    );
    await fs.writeFile(path.join(root, 'en-catalog-live.json'), JSON.stringify(en, null, 2));
    console.log(JSON.stringify({ series: en.reference, parts: en.items.map((x) => x.reference) }));
    const search = require('../search.cjs'),
      rows = await search.searchAllDocuments(
        'ISO 17450-4:2017',
        new AbortController().signal,
        console.log,
        {
          fetcher: async (url, options) => {
            const response = await fetch(url, options);
            await fs.writeFile(
              path.join(
                root,
                'source-search-' +
                  new URL(url).searchParams.get('q').replace(/[^a-z\d]/gi, '_') +
                  '.html',
              ),
              await response.clone().text(),
            );
            return response;
          },
        },
      );
    await fs.writeFile(path.join(root, 'iso17450-candidates.json'), JSON.stringify(rows, null, 2));
    console.log(
      JSON.stringify({ candidates: rows.map((x) => ({ title: x.title, pages: x.pageCount })) }),
    );
    return;
  }
  if (process.argv.includes('--process-iso')) {
    const { runSearchJob } = require('../search.cjs');
    const directory = path.join(root, 'iso17450-live');
    await fs.mkdir(directory, { recursive: true });
    const job = {
      query: 'ISO 17450-4:2017',
      directory,
      cacheDirectory: path.resolve(__dirname, '../.data/models'),
      controller: new AbortController(),
      log: console.log,
      update(value) {
        Object.assign(this, value);
        console.log(
          JSON.stringify({
            stage: this.stage,
            message: this.message,
            current: this.current,
            total: this.total,
          }),
        );
      },
    };
    try {
      await runSearchJob(job, path.resolve(__dirname, '../.data'), {
        candidates: JSON.parse(
          await fs.readFile(path.join(root, 'iso17450-candidates.json'), 'utf8'),
        ),
      });
    } finally {
      const { controller, update, log, ...record } = job;
      await fs.writeFile(path.join(directory, 'job.json'), JSON.stringify(record, null, 2));
    }
    console.log(
      JSON.stringify({
        stage: job.stage,
        pages: job.total,
        engine: job.processingEngine,
        verification: job.verification,
      }),
    );
    return;
  }
  if (process.argv.includes('--download-logos')) {
    const assets = {
      asme: ['svg', 'https://www.asme.org/assets/images/asme-logo-white.svg'],
      bs: ['svg', 'https://www.bsigroup.com/Areas/v1/UI/images/logos/bsi-logo.svg'],
      din: [
        'png',
        'https://www.din.de/resource/blob/71122/89768d0b6c059ffc48a4e0e839798df9/logo-small-data.png',
      ],
      en: ['svg', 'https://www.cencenelec.eu/dist/images/public/logo-cen-cenelec.svg'],
      iso: ['svg', 'https://cdn.iso.org/resources/wood/3.3.7/img/iso/iso-logo.svg'],
      nf: ['webp', 'https://www.afnor.org/logoAfnor.webp'],
    };
    for (const [name, [extension, url]] of Object.entries(assets)) {
      const { bytes } = await requestPublic(url);
      if (
        extension === 'svg' &&
        (!bytes.toString().includes('<svg') ||
          /<script|foreignObject|onload\s*=/i.test(bytes.toString()))
      )
        throw Error('Invalid SVG ' + name);
      await fs.writeFile(path.resolve(__dirname, '../dist', `logo-${name}.${extension}`), bytes);
      console.log(name + ': ' + bytes.length);
    }
    return;
  }
  if (process.argv.includes('--cen')) {
    const { chromium } = require('playwright');
    const browser = await chromium.launch({ headless: true, channel: 'msedge' });
    try {
      const page = await browser.newPage();
      await page.goto('https://standards.cencenelec.eu/ords/f?p=CEN:105', {
        waitUntil: 'domcontentloaded',
      });
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
        page.getByLabel('Published', { exact: true }).check(),
      ]);
      for (const query of ['14420', 'EN 14420', 'EN 14420%']) {
        await page.locator('#STAND_REF').fill(query);
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
          page.locator('#tformsub1').click(),
        ]);
        await page.waitForTimeout(1500);
        const links = await page
          .locator('a')
          .evaluateAll((a) =>
            a
              .filter((x) => /14420/.test(x.textContent))
              .map((x) => ({ text: x.textContent.trim().slice(0, 160), href: x.href })),
          );
        console.log(
          JSON.stringify({ query, count: await page.locator('.list-num').inputValue(), links }),
        );
        await fs.writeFile(path.join(root, 'cen-results.html'), await page.content());
        if (links.length) {
          await page.goto(links[0].href, { waitUntil: 'domcontentloaded' });
          await fs.writeFile(path.join(root, 'cen-detail.html'), await page.content());
          console.log(
            JSON.stringify({ detail: (await page.locator('body').innerText()).slice(-10000) }),
          );
          break;
        }
      }
    } finally {
      await browser.close();
    }
    return;
  }
  if (process.argv.includes('--logos')) {
    const sites = [
      ['asme', 'https://www.asme.org/'],
      ['bs', 'https://www.bsigroup.com/'],
      ['din', 'https://www.din.de/en'],
      ['nf', 'https://www.afnor.org/'],
      ['en', 'https://www.cencenelec.eu/'],
    ];
    await Promise.all(
      sites.map(async ([name, url]) => {
        try {
          const r = await requestPublic(url);
          const html = r.bytes.toString();
          await fs.writeFile(path.join(root, name + '-site.html'), html);
          console.log(
            JSON.stringify({
              name,
              assets: [
                ...html.matchAll(
                  /(?:src|href|data-src)=["']([^"']*(?:logo|brand)[^"']*\.(?:svg|png|webp)[^"']*)["']/gi,
                ),
              ]
                .slice(0, 12)
                .map((m) => new URL(m[1], url).href),
            }),
          );
        } catch (error) {
          console.log(JSON.stringify({ name, error: error.message }));
        }
      }),
    );
    return;
  }
  const home = (await requestPublic('https://www.dinmedia.de/en')).bytes.toString();
  const cfg = (home.match(/<[^>]+data-app-id=[^>]+>/g) || []).find((t) =>
    /data-suggestion-index=/.test(t),
  );
  const app = cfg.match(/data-app-id="([A-Z\d]+)"/)[1],
    key = cfg.match(/data-api-key="([a-f\d]+)"/)[1],
    index = home.match(/data-index-name="([^"<>]+)"/)[1];
  const r = await requestPublic(
    `https://${app.toLowerCase()}-dsn.algolia.net/1/indexes/${index}/query`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Algolia-Application-Id': app,
        'X-Algolia-API-Key': key,
      },
      body: JSON.stringify({ query: 'EN 14420', hitsPerPage: 100 }),
    },
  );
  const hits = JSON.parse(r.bytes).hits || [];
  await fs.writeFile(path.join(root, 'en-series-hits.json'), r.bytes);
  console.log(
    JSON.stringify({
      count: hits.length,
      hits: hits
        .map((h) => ({
          id: h.objectID,
          title: h.titel_DOK || h.titel,
          keys: Object.keys(h).filter((k) =>
            /status|type|language|sprache|datum|title|titel/i.test(k),
          ),
        }))
        .slice(0, 30),
    }),
  );
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
