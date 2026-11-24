'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs/promises'),
  os = require('node:os'),
  path = require('node:path');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const search = require('../experimental/anna-search.cjs');
const { runSearchJob } = require('../search.cjs');
const { importPDF } = require('../pdf-input.cjs');
const query = 'ISO 129-1:2018';
const card = (hash, title = query, metadata = '') => ({
  url: 'https://annas-archive.pk/md5/' + hash,
  title,
  metadata,
  details: title + '\nEnglish [en] · PDF',
});
test('Anna card discovery keeps exact publisher/part/language identities and reads padded filenames', () => {
  const cards = [
    card(
      'a'.repeat(32),
      'Technical product documentation',
      'upload/standards/ISO/ISO 00129-1-2018.pdf',
    ),
    card('b'.repeat(32), 'BS EN ISO 129-1:2018'),
    card('c'.repeat(32), 'ISO 129-2:2018'),
    { ...card('d'.repeat(32)), details: 'Chinese [zh] · PDF' },
    card('e'.repeat(32), 'ISO 129-1:2004'),
    card('f'.repeat(32), 'ISO 129-1:2018/Amd 1:2020'),
    card('1'.repeat(32), 'ISO/DIS 129-1:2018'),
    card(
      '3'.repeat(32),
      'Technical drawings [Withdrawn: replaced with ISO 129-1 and ISO 14405-2]',
      'ISO 406:1987',
    ),
    { ...card('2'.repeat(32)), url: 'https://annas-archive.pk.evil.test/md5/' + '2'.repeat(32) },
  ];
  assert.deepEqual(
    search.parseSearchResults({ cards }, query, { exact: true }).map((c) => c.url),
    [cards[0].url],
  );
  assert.deepEqual(
    search.parseSearchResults({ cards }, query).map((c) => c.url),
    [cards[0].url, cards[4].url],
  );
  const expected = search.searchURL(query);
  assert.equal(search.allowedSearchPage(expected + '&check=1', expected), true);
  assert.equal(search.allowedSearchPage(expected.replace('page=1', ''), expected), true);
  for (const url of [
    expected.replace('page=1', 'page=2'),
    expected.replace('lang=en', 'lang=zh'),
    expected.replace('ISO', 'BS'),
    'http://127.0.0.1/search?q=x',
  ])
    assert.equal(search.allowedSearchPage(url, expected), false);
});
test('exact-first discovery follows source pagination and stops lazily before optimized requests', async () => {
  const a = card('a'.repeat(32)),
    b = card('b'.repeat(32)),
    calls = [],
    phases = [];
  const job = { controller: new AbortController(), log() {} };
  const iterator = search.searchAnnaPages(job, '.', query, {
    onPhase: (phase) => phases.push(phase),
    async readPage(job, directory, url) {
      calls.push(url);
      return new URL(url).searchParams.get('page') === '1'
        ? { cards: [a], pagination: [search.searchURL(query, 2)] }
        : { cards: [b], pagination: [] };
    },
  });
  assert.equal((await iterator.next()).value[0].url, a.url);
  assert.equal(calls.length, 1);
  assert.equal((await iterator.next()).value[0].url, b.url);
  await iterator.return();
  assert.equal(calls.length, 2);
  assert.deepEqual(phases, ['exact']);
});

test('national and ASME searches retain the requested publisher and document language', () => {
  for (const [query, language, label] of [
    ['DIN EN ISO 129-1:2022-02', 'deu', 'German [de]'],
    ['BS EN ISO 129-1:2019', 'eng', 'English [en]'],
    ['NF EN ISO 1101:2017-04', 'fra', 'French [fr]'],
    ['ASME Y14.6-2001 (R2025)', 'eng', 'English [en]'],
  ]) {
    const row = { ...card('a'.repeat(32), query), details: label + ' · PDF' };
    assert.equal(
      search.parseSearchResults({ cards: [row] }, query, { exact: true, language }).length,
      1,
    );
    assert.equal(
      search.parseSearchResults({ cards: [row] }, query, {
        language: language === 'eng' ? 'deu' : 'eng',
      }).length,
      0,
    );
    const url = search.searchURL(query, 1, language);
    assert.equal(search.allowedSearchPage(url, url), true);
    assert.equal(
      new URL(url).searchParams.get('lang'),
      { eng: 'en', deu: 'de', fra: 'fr' }[language],
    );
  }
});
test('empty exact searches expand spelling only after exact exhaustion; repeated pages remain incomplete', async () => {
  const job = { controller: new AbortController(), log() {} },
    calls = [],
    phases = [];
  const iterator = search.searchAnnaPages(job, '.', query, {
    onPhase: (phase) => phases.push(phase),
    async readPage(job, directory, url) {
      const text = new URL(url).searchParams.get('q');
      calls.push(text);
      return {
        cards: text === 'ISO 129-1' ? [card('a'.repeat(32), 'ISO 129-1')] : [],
        pagination: [],
      };
    },
  });
  assert.equal((await iterator.next()).value[0].title, 'ISO 129-1');
  assert.deepEqual(phases, ['exact', 'optimized']);
  assert.deepEqual(calls, [query, 'ISO 129-1']);
  await iterator.return();
  const repeated = search.searchAnnaPages(job, '.', query, {
    readPage: async (job, directory, url) => ({
      cards: [card('b'.repeat(32), 'Unrelated title')],
      pagination: [search.searchURL(query, Number(new URL(url).searchParams.get('page')) + 1)],
    }),
  });
  await assert.rejects(repeated.next(), { code: 'SEARCH_INCOMPLETE' });
});
test('source browser extracts filename metadata without using normative references in abstracts', async (t) => {
  const browser = await chromium.launch({
    channel: require('../runtime.cjs').browserChannel(),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`<header><a href="https://annas-archive.pk/md5/${'c'.repeat(32)}">ISO 129-1:2018 recent download</a></header><main><p>RESULTS 1-2 (2 TOTAL)</p>
    <article><div>upload/ISO/ISO 00129-1-2018.pdf</div><a href="https://annas-archive.pk/md5/${'a'.repeat(32)}"><h3>Technical product documentation</h3></a><p>English [en] · PDF</p></article>
    <article><a href="https://annas-archive.pk/md5/${'b'.repeat(32)}"><h3>Another document</h3></a><p>Its normative references include ISO 129-1:2018.</p><p>ISO 129-1:2018 provides the general principles.</p><p>English [en] · PDF</p></article>
    <a rel="next" href="${search.searchURL(query, 2).replaceAll('&', '&amp;')}">Next</a></main>`);
  const state = await page.evaluate(
    `(${search.inspectSearchResults.toString()})(${require('../experimental/anna-source.cjs').inspectPage.toString()})`,
  );
  assert.equal(state.cards.length, 2);
  assert.equal(state.ready, true);
  assert.equal(search.parseSearchResults(state, query, { exact: true }).length, 1);
  assert.equal(search.nextPage(state, search.searchURL(query)), 2);
  await page.setContent(
    `<header><a href="https://annas-archive.pk/md5/${'c'.repeat(32)}">ISO 129-1:2018 recent download</a></header><main>Loading search results…</main>`,
  );
  const pending = await page.evaluate(
    `(${search.inspectSearchResults.toString()})(${require('../experimental/anna-source.cjs').inspectPage.toString()})`,
  );
  assert.equal(pending.ready, false);
  assert.equal(pending.cards.length, 0);
});
test('an incorrect downloaded edition is rejected before the next exact card can pass', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'declipdf-anna-search-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  async function pdf(reference) {
    const result = await PDFDocument.create(),
      font = await result.embedFont(StandardFonts.Helvetica);
    for (let index = 0; index < 4; index++) {
      const page = result.addPage([600, 800]);
      page.drawText(
        reference +
          '\nSection ' +
          (index + 1) +
          '\n' +
          [
            'This document specifies the requirements for the measurement of manufactured parts.',
            'Each feature is measured independently and the results are recorded in the report.',
            'The operator should check that the equipment is suitable for the measurement.',
            'A surface can be evaluated by more than one method and the selected method shall be stated.',
          ].join('\n'),
        { x: 30, y: 730, size: 10, font },
      );
    }
    return Buffer.from(await result.save());
  }
  const old = await pdf('ISO 129-1:2004'),
    valid = await pdf(query);
  const hash = (bytes) => createHash('md5').update(bytes).digest('hex');
  const cards = [card(hash(old)), card(hash(valid))],
    downloads = [],
    phases = [];
  const job = {
    directory,
    query,
    title: query,
    ocrLanguage: 'eng',
    documentLanguage: 'eng',
    processingMode: 'auto',
    controller: new AbortController(),
    isoEdition: {
      reference: query,
      title: 'Technical product documentation',
      pageCount: 4,
      status: 'Published',
    },
    update(value) {
      Object.assign(this, value);
    },
    log() {},
  };
  await runSearchJob(job, directory, {
    experimentalAnna: true,
    _cacheAttempted: true,
    discover: (query, signal, log, options) =>
      search.searchAnnaPages(job, directory, query, {
        ...options,
        onPhase: (phase) => phases.push(phase),
        readPage: async (job, directory, url) =>
          new URL(url).searchParams.get('page') === '1'
            ? { cards: [cards[0]], pagination: [search.searchURL(query, 2)] }
            : { cards: [cards[1]], pagination: [] },
      }),
    downloadPDF: async (child) => {
      downloads.push(child.url);
      await fs.writeFile(
        path.join(child.directory, 'source.pdf'),
        child.url === cards[0].url ? old : valid,
      );
    },
    importPDF,
  });
  assert.equal(job.stage, 'done');
  assert.deepEqual(
    job.searchResults.map((c) => c.status),
    ['rejected', 'passed'],
  );
  assert.deepEqual(
    downloads,
    cards.map((c) => c.url),
  );
  assert.deepEqual(phases, ['exact']);
  assert.equal(job.verification.identity.status, 'passed');
});
test('a search confirmation is relayed to a human and cancellation closes the waiting browser', async (t) => {
  // This is an owned local HTML fixture; no real site challenge is interacted with.
  const browser = await chromium.launch({
    channel: require('../runtime.cjs').browserChannel(),
    headless: true,
  });
  t.after(() => browser.close());
  let context, page, currentView;
  const launchContext = async () => {
    context = await browser.newContext({ viewport: { width: 960, height: 720 } });
    context.on('page', (value) => (page = value));
    await context.route('https://annas-archive.pk/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<title>DDOS-GUARD</title><input autofocus id="answer"><button id="continue">Continue</button><script>document.getElementById("continue").onclick=()=>{if(document.getElementById("answer").value==="LOCAL"){document.title="Search";document.body.innerHTML="No results found";}};</script>',
      }),
    );
    return context;
  };
  const job = {
    controller: new AbortController(),
    update(value) {
      Object.assign(this, value);
    },
  };
  const result = search.readSearchPage(job, '.', search.searchURL(query), {
    launchContext,
    pollMs: 10,
    onBrowserView(view) {
      currentView = view;
    },
  });
  for (let n = 0; !currentView && n < 500; n++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(currentView);
  const frame = await currentView.frame();
  assert.equal(frame.keyboard, true);
  await page.locator('#answer').focus();
  await currentView.input({ token: frame.token, type: 'text', text: 'LOCAL' });
  await page.locator('#continue').click();
  assert.equal((await result).ready, true);
  assert.equal(job.challengeAvailable, false);
  assert.equal(context.pages().length, 0);
  currentView = null;
  const cancelled = search.readSearchPage(job, '.', search.searchURL(query), {
    launchContext,
    pollMs: 10,
    onBrowserView(view) {
      currentView = view;
    },
  });
  for (let n = 0; !currentView && n < 500; n++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(currentView);
  job.controller.abort();
  await assert.rejects(cancelled);
  assert.equal(context.pages().length, 0);
  assert.equal(job.challengeAvailable, false);
});

test('one browser session spans discovery and downloads, releases each tab and drains cancellation', async () => {
  const { createAnnaBrowser } = require('../experimental/anna-browser.cjs');
  const controller = new AbortController();
  let launches = 0,
    closed = 0,
    tabs = 0;
  const owner = createAnnaBrowser('.', controller.signal, {
    launchContext: async () => {
      launches++;
      return {
        newPage: async () => {
          tabs++;
          return {
            async close() {
              tabs--;
            },
          };
        },
        async close() {
          await new Promise((resolve) => setTimeout(resolve, 20));
          closed++;
        },
      };
    },
  });
  const searchTab = await owner.lease();
  await searchTab.newPage();
  await searchTab.close();
  const downloadTab = await owner.lease();
  await downloadTab.newPage();
  assert.equal(launches, 1);
  assert.equal(tabs, 1);
  await downloadTab.close();
  controller.abort();
  await owner.close();
  await owner.close();
  assert.equal(closed, 1);
  assert.equal(tabs, 0);
  await assert.rejects(owner.lease());
});
