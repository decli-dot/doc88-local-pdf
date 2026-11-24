'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');
const { PDFDocument } = require('pdf-lib');
const root = path.resolve(__dirname, '..');
let child, browser, directory;
(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'declipdf-interface-'));
  const output = path.join(root, '.data/interface-check');
  await fs.mkdir(output, { recursive: true });
  const done = '11111111-1111-4111-8111-111111111111';
  const failed = '22222222-2222-4222-8222-222222222222';
  const choices = '33333333-3333-4333-8333-333333333333';
  const series = '44444444-4444-4444-8444-444444444444';
  const asme = '55555555-5555-4555-8555-555555555555';
  const language = '66666666-6666-4666-8666-666666666666';
  const wrongLanguage = '77777777-7777-4777-8777-777777777777';
  const shortened = '88888888-8888-4888-8888-888888888888';
  const unavailable = '99999999-9999-4999-8999-999999999999';
  const dinSeries = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const pdf = await PDFDocument.create();
  for (let index = 0; index < 5; index++) pdf.addPage();
  const bytes = Buffer.from(await pdf.save());
  for (const id of [
    done,
    failed,
    choices,
    series,
    asme,
    language,
    wrongLanguage,
    shortened,
    unavailable,
    dinSeries,
  ])
    await fs.mkdir(path.join(directory, 'jobs', id), { recursive: true });
  const edition = {
    reference: 'ISO 5458:2018',
    title: 'Geometrical product specifications (GPS)',
    status: 'Published',
    sourceURL: 'https://www.iso.org/standard/65559.html',
    pageCount: 44,
    checkedAt: '2026-11-07T10:00:00Z',
    supplements: [],
  };
  const diagnostic = [
    {
      title: 'ISO 5458:2018',
      url: 'https://www.doc88.com/p-1.html',
      pageCount: 44,
      status: 'passed',
      checks: { extent: { status: 'passed', message: 'PRIVATE_DETAILS' } },
    },
  ];
  await fs.writeFile(path.join(directory, 'fixture.pdf'), bytes);
  await fs.writeFile(path.join(directory, 'jobs', done, 'result.pdf'), bytes);
  await fs.writeFile(
    path.join(directory, 'jobs', done, 'job.json'),
    JSON.stringify({
      id: done,
      kind: 'search',
      query: edition.reference,
      title: edition.reference + ' — Geometrical product specifications (GPS)',
      stage: 'done',
      createdAt: '2026-11-07T09:00:00Z',
      finishedAt: '2026-11-07T09:00:10Z',
      total: 5,
      bytes: bytes.length,
      pdfReady: true,
      archiveReady: true,
      pdfFilename: 'ISO 5458 2018.pdf',
      copyTextReady: true,
      isoEdition: edition,
      searchResults: diagnostic,
      verification: { extent: { status: 'passed' } },
      pageIntegrity: { status: 'unknown', uncertainPages: [2, 5] },
      ocrQuality: { uncertainPages: [3] },
      textlessPages: [4],
      blankPages: 1,
      performanceMetrics: {
        version: 1,
        status: 'done',
        elapsedMs: 12340,
        stages: [
          { key: 'catalogue', wallMs: 500, workMs: 500, calls: 1, active: 0 },
          { key: 'preview', wallMs: 4000, workMs: 7000, calls: 2, active: 0 },
          { key: 'ocr', wallMs: 6000, workMs: 6000, calls: 1, active: 0 },
        ],
      },
      previewDiagnostics: { completed: 2, total: 2, peak: 2 },
      message: 'PRIVATE_DETAILS',
      documentStructure: {
        count: 1,
        nodes: [{ label: '1', title: 'Scope', page: 1, children: [] }],
        message:
          'Структура восстановлена по распознанным заголовкам. Проверь неоднозначные названия и переходы.',
      },
      normativeReferences: {
        items: [{ query: 'ISO 1101', label: 'ISO 1101', searchable: true }],
        message:
          'Ссылки извлечены только из раздела Normative references; обозначения могут содержать ошибки OCR.',
      },
    }),
  );
  await fs.writeFile(
    path.join(directory, 'jobs', failed, 'job.json'),
    JSON.stringify({
      id: failed,
      kind: 'search',
      query: 'ISO 129-1',
      title: 'ISO 129-1',
      stage: 'error',
      errorCode: 'SEARCH_EXHAUSTED',
      createdAt: '2026-11-07T11:00:00Z',
      message: 'PRIVATE_DETAILS https://www.doc88.com/p-2.html',
      searchResults: diagnostic,
    }),
  );
  for (const [id, type, checks] of [
    [wrongLanguage, 'language', { language: { status: 'failed' } }],
    [shortened, 'incomplete', { extent: { status: 'failed', officialPages: 44, pages: 9 } }],
    [unavailable, 'access', null],
  ]) {
    await fs.writeFile(
      path.join(directory, 'jobs', id, 'job.json'),
      JSON.stringify({
        id,
        kind: 'search',
        query: type === 'language' ? 'DIN 5008:2020-03' : 'ISO 5458:2018',
        title: type === 'language' ? 'DIN 5008:2020-03' : 'ISO 5458:2018',
        stage: 'error',
        createdAt: '2026-11-07T12:00:00Z',
        pdfReady: false,
        errorCode: type === 'access' ? 'SEARCH_INCOMPLETE' : 'SEARCH_EXHAUSTED',
        failureKind: type === 'access' ? 'access' : undefined,
        catalogueEdition:
          type === 'language'
            ? {
                publisher: 'DIN',
                reference: 'DIN 5008:2020-03',
                title: 'Fixture',
                pageCount: 10,
                languages: ['eng', 'deu'],
              }
            : undefined,
        searchResults: checks
          ? [
              {
                status: 'rejected',
                title: 'PRIVATE_DETAILS',
                url: 'https://www.doc88.com/p-999.html',
                checks,
              },
            ]
          : [],
        message: 'PRIVATE_DETAILS',
      }),
    );
  }
  await fs.writeFile(
    path.join(directory, 'jobs', choices, 'job.json'),
    JSON.stringify({
      id: choices,
      kind: 'search',
      query: 'ISO 5458:2013',
      title: 'ISO 5458:2013',
      stage: 'choosing',
      createdAt: '2026-11-07T10:00:00Z',
      message: 'PRIVATE_DETAILS',
      isoChoices: [edition, { ...edition, reference: 'ISO 5458:1998', status: 'Withdrawn' }],
    }),
  );
  await fs.writeFile(
    path.join(directory, 'jobs', done, 'copy-text.txt'),
    'Clean text for copying.',
  );
  await fs.writeFile(
    path.join(directory, 'jobs', series, 'job.json'),
    JSON.stringify({
      id: series,
      kind: 'search',
      query: 'ISO 17450',
      title: 'ISO 17450',
      seriesReference: 'ISO 17450',
      stage: 'selecting',
      createdAt: '2026-11-07T09:30:00Z',
      seriesOptions: [1, 2, 3].map((part) => ({
        reference: `ISO 17450-${part}:2020`,
        title: 'Synthetic part ' + part,
        status: 'Published',
        sourceURL: `https://www.iso.org/standard/${part}.html`,
      })),
    }),
  );
  await fs.writeFile(
    path.join(directory, 'jobs', asme, 'job.json'),
    JSON.stringify({
      id: asme,
      kind: 'search',
      query: 'ASME Y14.6',
      resolvedQuery: 'ASME Y14.6-2001 (R2025)',
      title: 'ASME Y14.6-2001 (R2025)',
      stage: 'done',
      pdfReady: true,
      total: 1,
      bytes: bytes.length,
      createdAt: '2026-11-07T08:00:00Z',
      finishedAt: '2026-11-07T08:00:10Z',
      catalogueEdition: {
        publisher: 'ASME',
        reference: 'ASME Y14.6-2001 (R2025)',
        status: 'Published',
        pageCount: 24,
        sourceURL:
          'https://www.asme.org/codes-standards/find-codes-standards/y14-6-screw-thread-representation',
        checkedAt: new Date().toISOString(),
      },
      verification: { extent: { status: 'passed' } },
    }),
  );
  const dinEditions = [1, 2].map((part) => ({
    publisher: 'DIN',
    reference: `DIN EN ISO 17450-${part}:2024-02`,
    title: 'Fixture part ' + part,
    pageCount: 5,
    languages: part === 2 ? ['deu'] : ['eng', 'deu'],
    status: 'Published',
    sourceURL: 'https://www.dinmedia.de/en/standard/fixture',
  }));
  await fs.writeFile(
    path.join(directory, 'jobs', dinSeries, 'job.json'),
    JSON.stringify({
      id: dinSeries,
      kind: 'search',
      query: 'DIN 17450',
      title: 'DIN 17450',
      stage: 'selecting',
      seriesReference: 'DIN 17450',
      seriesOptions: dinEditions,
      createdAt: '2026-11-07T06:00:00Z',
    }),
  );
  const preload = path.join(directory, 'worker.cjs');
  await fs.writeFile(
    path.join(directory, 'jobs', language, 'job.json'),
    JSON.stringify({
      id: language,
      kind: 'search',
      query: 'DIN EN ISO 129-1:2022-02',
      resolvedQuery: 'DIN EN ISO 129-1:2022-02',
      title: 'DIN EN ISO 129-1:2022-02',
      stage: 'language',
      createdAt: '2026-11-07T07:00:00Z',
      languageChoices: [
        { code: 'eng', label: 'Английский' },
        { code: 'deu', label: 'Немецкий' },
      ],
    }),
  );
  await fs.writeFile(
    preload,
    `const filename=${JSON.stringify(path.join(root, 'search.cjs'))};const original=require(filename);require.cache[filename].exports={...original,runSearchJob:async(job,data)=>{if(job.batchLanguagePreference&&job.query.startsWith('DIN')){try{await original.runSearchJob(job,data,{search:async()=>[]});if(job.stage==='language')return;}catch(error){if(error.code!=='SEARCH_EXHAUSTED')throw error;}}for(const stage of ['resolving','searching','ocr']){job.update({stage,workflowPhase:stage==='ocr'?'pdf':'checking',message:'PRIVATE_DETAILS page 1 of 99',searchResults:${JSON.stringify(diagnostic)}});await new Promise(r=>setTimeout(r,1800));if(job.controller.signal.aborted)throw Error('Cancelled');}await require('node:fs/promises').copyFile(require('node:path').join(process.env.DOC88_DATA_DIR,'fixture.pdf'),require('node:path').join(job.directory,'result.pdf'));job.update({stage:'done',pdfReady:true,total:5,bytes:${bytes.length},finishedAt:new Date().toISOString(),message:'PRIVATE_DETAILS'});}};`,
  );
  const origin = 'http://127.0.0.1:18978';
  child = spawn(process.execPath, ['--require', preload, path.join(root, 'server.cjs')], {
    cwd: root,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DOC88_DATA_DIR: directory,
      DOC88_PORT: '18978',
      DECLIPDF_DEV_PASSWORD: 'interface-fixture',
    },
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Preview did not start')), 15000);
    child.stdout.on('data', (bytes) => {
      if (bytes.toString().includes('DOC88_READY')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('error', reject);
  });
  browser = await chromium.launch({
    channel: process.env.DECLIPDF_TEST_BROWSER || 'msedge',
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = [];
  async function selectFixture(id) {
    await page.evaluate((id) => localStorage.setItem('doc88-selected', id), id);
    await page.reload();
    await page.locator('#job-state').waitFor();
  }
  let searchPayload;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/search'))
      searchPayload = request.postDataJSON();
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin + '/?advanced=1');
  await page.locator('#history-list .history-item').first().waitFor({ state: 'attached' });
  assert.equal(await page.locator('#url-tab').isVisible(), false);
  assert.equal(await page.locator('#zip-tab').isVisible(), false);
  assert.equal(await page.locator('#history-section').isVisible(), false);
  assert.deepEqual(
    await page.locator('.publisher-logo img').evaluateAll((images) => images.map((x) => x.alt)),
    ['ASME', 'BS', 'DIN', 'EN', 'ISO', 'NF'],
  );
  assert.equal(
    await page
      .locator('.publisher-logo img')
      .evaluateAll((images) => images.every((x) => x.complete && x.naturalWidth > 0)),
    true,
  );
  assert.equal(await page.locator('#processing-mode').isVisible(), false);
  assert.equal(await page.locator('#source-policy').isVisible(), false);
  assert.equal(await page.locator('#captcha-settings').isVisible(), false);
  assert.equal(await page.locator('#ocr-language').isVisible(), false);
  assert.equal(await page.locator('#enhance-images').isVisible(), false);
  assert.equal(await page.locator('#anna-experiment').isVisible(), false);
  assert.equal(await page.locator('h1').innerText(), 'Поиск стандартов');
  assert.equal(await page.locator('label[for=search-query]').innerText(), 'Обозначение документа');
  await page.locator('#search-query').fill('DIN 1234');
  assert.equal(await page.locator('#ocr-language').inputValue(), 'eng+deu');
  assert.equal(await page.locator('#ocr-language').isDisabled(), true);
  await page.locator('#search-query').fill('iso5458');
  assert.equal(await page.locator('#ocr-language').inputValue(), 'eng');
  assert.equal(
    await page.locator('#document-language-summary').innerText(),
    'Язык документа: английский',
  );
  await page.locator('#search-query').fill('NF EN ISO 129-1');
  assert.equal(await page.locator('#ocr-language').inputValue(), 'eng+fra');
  await page.locator('#search-query').fill('BS EN ISO 129-1');
  assert.equal(await page.locator('#ocr-language').inputValue(), 'eng');
  await page.locator('#search-query').fill('ASME Y14.6');
  assert.equal(await page.locator('#ocr-language').inputValue(), 'eng');
  await page.locator('[data-locale=en]').click();
  await page.waitForFunction(() => document.documentElement.lang === 'en');
  assert.equal(await page.locator('h1').innerText(), 'Standards search');
  assert.equal(await page.locator('#ocr-language option[value=rus]').innerText(), 'Russian');
  await selectFixture(asme);
  await page.waitForFunction(
    () => document.getElementById('iso-edition-label').textContent === 'ASME edition',
  );
  assert.doesNotMatch(await page.locator('#iso-edition').innerText(), /ISO/);
  await selectFixture(done);
  await page.locator('#result-actions').waitFor();
  await page.waitForFunction(
    () => document.querySelector('#job-message').textContent === 'Your document is ready.',
  );
  assert.equal(await page.locator('#search-results-section').isVisible(), false);
  assert.equal(await page.locator('#performance-panel').isVisible(), false);
  await page.locator('#quality-notes').waitFor();
  assert.equal(await page.locator('#quality-notes .quality-note').count(), 3);
  assert.match(
    await page.locator('#quality-notes a').filter({ hasText: 'Page 3' }).getAttribute('href'),
    /#page=3$/,
  );
  const [pdfTab] = await Promise.all([
    page.waitForEvent('popup'),
    page.locator('#quality-notes a').filter({ hasText: 'Page 3' }).click(),
  ]);
  await pdfTab.waitForURL(/#page=3$/);
  await pdfTab.close();
  assert.doesNotMatch(await page.locator('#quality-notes').innerText(), /[А-Яа-яЁё]/);
  assert.equal(await page.locator('#status-pill').innerText(), 'Ready with notes');
  assert.doesNotMatch(
    await page.locator('body').innerText(),
    /PRIVATE_DETAILS|doc88|ТВОЙ|Проверим содержимое|Можно писать/i,
  );
  assert.equal((await page.request.get(origin + '/api/jobs/' + done + '/pdf')).status(), 200);
  await page.locator('#show-copy-text').click();
  await page.locator('#copy-dialog').waitFor();
  assert.equal(await page.locator('#copy-content').inputValue(), 'Clean text for copying.');
  await page.locator('#copy-close').click();
  await page.screenshot({ path: path.join(output, 'desktop-en.png'), fullPage: true });
  const english = await page.locator('body').innerText();
  await fs.writeFile(path.join(output, 'visible-en.txt'), english);
  assert.doesNotMatch(english.replaceAll('ГОСТ', ''), /[А-Яа-яЁё]/);
  await page.locator('[data-locale=ru]').click();
  await page.waitForFunction(() => document.querySelector('h1').textContent === 'Поиск стандартов');
  await page.screenshot({ path: path.join(output, 'desktop-ru.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: path.join(output, 'mobile-ru.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await selectFixture(failed);
  await page.locator('[data-locale=en]').click();
  await page.waitForFunction(
    () => document.querySelector('#status-pill').textContent === 'Document not found',
  );
  assert.equal(await page.locator('#resume').innerText(), 'Search again');
  await page.locator('#problem-actions button').filter({ hasText: 'Check designation' }).click();
  assert.equal(await page.locator('#search-query').inputValue(), 'ISO 129-1');
  await selectFixture(shortened);
  await page.waitForFunction(
    () => document.querySelector('#status-pill').textContent === 'Incomplete document',
  );
  assert.match(await page.locator('#job-message').innerText(), /all required pages/);
  await selectFixture(unavailable);
  await page.waitForFunction(
    () => document.querySelector('#status-pill').textContent === 'Access unavailable',
  );
  assert.equal(await page.locator('#resume').innerText(), 'Try again');
  await selectFixture(wrongLanguage);
  await page.waitForFunction(
    () => document.querySelector('#status-pill').textContent === 'Requested language not found',
  );
  await page.locator('#problem-actions button').filter({ hasText: 'Select language' }).click();
  await page.locator('#language-dialog').waitFor();
  assert.equal(await page.locator('#language-options input').count(), 2);
  const languageState = await (
    await page.request.get(origin + '/api/jobs/' + wrongLanguage)
  ).json();
  assert.equal(languageState.query, 'DIN 5008:2020-03');
  const badLanguage = await page.request.post(origin + '/api/jobs/' + wrongLanguage + '/language', {
    headers: { Origin: origin, 'x-doc88-request': '1' },
    data: { code: 'fra' },
  });
  assert.equal(badLanguage.status(), 400);
  await page.locator('#language-cancel').click();
  await page.locator('#language-dialog').waitFor({ state: 'hidden' });
  assert.doesNotMatch(await page.locator('body').innerText(), /PRIVATE_DETAILS|doc88/);
  await selectFixture(choices);
  await page.locator('#edition-dialog').waitFor();
  await page.locator('[data-locale=en]').evaluate((button) => button.click());
  assert.equal(await page.locator('#edition-heading').innerText(), 'Choose an edition');
  assert.match(await page.locator('#edition-options').innerText(), /Current edition/);
  assert.match(await page.locator('#edition-options').innerText(), /Withdrawn/);
  await page.locator('#edition-cancel').click();
  await page.locator('#edition-dialog').waitFor({ state: 'hidden' });
  await selectFixture(language);
  await page.locator('#language-dialog').waitFor();
  assert.equal(await page.locator('#language-options input').count(), 2);
  assert.equal(await page.locator('#language-heading').innerText(), 'Document language');
  assert.equal(await page.locator('#language-all').innerText(), 'Select all');
  await page.locator('#language-all').click();
  assert.equal(await page.locator('#language-options input:checked').count(), 2);
  assert.equal(await page.locator('#language-submit').isDisabled(), false);
  await page.screenshot({ path: path.join(output, 'language-all-en.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: path.join(output, 'language-all-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.locator('#language-none').click();
  assert.equal(await page.locator('#language-options input:checked').count(), 0);
  assert.equal(await page.locator('#language-submit').isDisabled(), true);
  await page.locator('#language-options input[value=deu]').check();
  await page.screenshot({ path: path.join(output, 'language-selection-en.png'), fullPage: true });
  await page.locator('#language-submit').click();
  await page.locator('#language-dialog').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.getElementById('status-pill').textContent === 'Ready');
  assert.equal(
    (await (await page.request.get(origin + '/api/jobs/' + language)).json()).documentLanguage,
    'deu',
  );
  await page.keyboard.press('Control+Shift+D');
  await page.locator('#dev-dialog').waitFor();
  await page.locator('#dev-password').fill('wrong');
  await page.locator('#dev-submit').click();
  await page.waitForFunction(
    () => document.querySelector('#dev-error').textContent === 'Incorrect password.',
  );
  await page.locator('#dev-password').fill('interface-fixture');
  await page.locator('#dev-submit').click();
  await page.locator('#dev-dialog').waitFor({ state: 'hidden' });
  await page.locator('#history-section').waitFor();
  await selectFixture(done);
  await page.locator('#performance-panel').waitFor();
  await page.locator('#performance-panel summary').click();
  assert.equal(await page.locator('#performance-stages tr').count(), 3);
  await page.waitForFunction(
    () => document.querySelector('#performance-panel summary').textContent === 'Processing time',
  );
  assert.match(await page.locator('#performance-parallel').innerText(), /peak concurrency: 2/);
  assert.doesNotMatch(await page.locator('#performance-panel').innerText(), /[А-Яа-яЁё]/);
  await page.screenshot({ path: path.join(output, 'performance-en.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: path.join(output, 'performance-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1100 });
  assert.equal(await page.locator('#url-tab').isVisible(), false);
  assert.equal(await page.locator('#zip-tab').isVisible(), false);
  assert.equal(await page.locator('#processing-mode').isVisible(), true);
  assert.equal(await page.locator('#source-policy').isVisible(), true);
  assert.equal(await page.locator('#captcha-settings').isVisible(), true);
  await page.locator('#captcha-settings > summary').click();
  await page.waitForFunction(
    () => document.getElementById('captcha-key-status').textContent === 'Key not configured',
  );
  await page.locator('#captcha-key').fill('0123456789abcdef0123456789abcdef');
  await page.locator('#captcha-enabled').check();
  await page.locator('#captcha-job-limit').fill('1');
  await page.locator('#captcha-day-limit').fill('3');
  await page.locator('#captcha-save').click();
  await page.waitForFunction(
    () => document.getElementById('captcha-key-status').textContent === 'Key saved',
  );
  assert.equal(await page.locator('#captcha-key').inputValue(), '');
  assert.equal(await page.locator('#captcha-usage').innerText(), '0 / 3');
  assert.doesNotMatch(await page.locator('#captcha-settings').innerText(), /[А-Яа-яЁё]/);
  await page.locator('#captcha-settings').screenshot({ path: path.join(output, 'captcha-en.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page
    .locator('#captcha-settings')
    .screenshot({ path: path.join(output, 'captcha-mobile.png') });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.locator('#captcha-remove').click();
  await page.waitForFunction(
    () => document.getElementById('captcha-key-status').textContent === 'Key not configured',
  );
  await page.locator('#captcha-settings > summary').click();
  assert.equal(await page.locator('#source-policy option').count(), 4);
  await page.locator('#source-policy').selectOption('anna-first');
  await selectFixture(done);
  assert.equal(await page.locator('#source-policy').inputValue(), 'anna-first');
  await page.route('**/api/search', (route) =>
    route.fulfill({ status: 202, json: { id: done, query: 'ISO 5458:2018' } }),
  );
  for (const policy of ['doc88-first', 'anna-first', 'doc88-only', 'anna-only']) {
    await page.locator('#source-policy').selectOption(policy);
    await page.locator('#search-query').fill('ISO 5458:2018');
    await page.locator('#start-search').click();
    await page.waitForFunction(() => !document.getElementById('start-search').disabled);
    assert.equal(searchPayload.sourcePolicy, policy);
  }
  await page.locator('.input-card').screenshot({ path: path.join(output, 'source-policy-en.png') });
  await page.unroute('**/api/search');
  assert.equal(await page.locator('#ocr-language').isVisible(), true);
  assert.equal(await page.locator('#enhance-images').isVisible(), true);
  assert.equal(await page.locator('#anna-experiment').isVisible(), true);
  await page.locator('#anna-experiment > summary').click();
  await page.locator('#anna-query').fill('ISO 129-1:2018');
  await page.locator('#anna-manual summary').click();
  await page.locator('#anna-card').fill('https://annas-archive.pk/md5/' + 'a'.repeat(32));
  let annaPayload;
  await page.route('**/api/experiments/anna', async (route) => {
    annaPayload = route.request().postDataJSON();
    await route.fulfill({ json: { id: done }, status: 202 });
  });
  await page.locator('#anna-submit').click();
  await page.waitForFunction(() => !document.getElementById('anna-submit').disabled);
  assert.deepEqual(annaPayload, {
    query: 'ISO 129-1:2018',
    cardURL: 'https://annas-archive.pk/md5/' + 'a'.repeat(32),
    slowURL: '',
  });
  await page.locator('#anna-card').fill('');
  await page.locator('#anna-manual summary').click();
  await page.locator('#anna-submit').click();
  await page.waitForFunction(() => !document.getElementById('anna-submit').disabled);
  assert.deepEqual(annaPayload, { query: 'ISO 129-1:2018', cardURL: '', slowURL: '' });
  await page
    .locator('#anna-experiment')
    .screenshot({ path: path.join(output, 'anna-search-en.png') });
  await page.unroute('**/api/experiments/anna');
  assert.equal(await page.locator('label[for=processing-mode]').innerText(), 'Processing method');
  await page.locator('#processing-mode').selectOption('direct');
  assert.equal(
    await page.evaluate(() => localStorage.getItem('declipdf-processing-mode')),
    'direct',
  );
  await selectFixture(asme);
  await page.waitForFunction(
    () => document.getElementById('iso-edition-label').textContent === 'ASME edition',
  );
  await page.waitForFunction(() =>
    document.getElementById('iso-page-count').textContent.includes('ASME catalogue: 24 pages'),
  );
  assert.doesNotMatch(await page.locator('#iso-edition').innerText(), /ISO|undefined/);
  await selectFixture(done);
  await page.locator('#search-results-section').waitFor();
  await page.locator('#search-results-section details summary').first().click();
  assert.match(await page.locator('#search-results-section').innerText(), /PRIVATE_DETAILS/);
  await page.locator('#dev-logout').click();
  await page.locator('#dev-logout').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#url-panel').isVisible(), false);
  assert.equal(await page.locator('#history-section').isVisible(), false);
  assert.equal(await page.locator('#processing-mode').isVisible(), false);
  assert.equal(await page.locator('#anna-experiment').isVisible(), false);
  assert.equal(await page.locator('#search-results-section').isVisible(), false);
  assert.equal(await page.locator('#source-policy').isVisible(), false);
  await page.locator('#search-query').fill('DIN 1234');
  assert.equal(await page.locator('#ocr-language').inputValue(), 'eng+deu');
  await page.locator('#start-search').click();
  await page.waitForFunction(
    () => document.querySelector('#status-pill').textContent === 'Resolving edition',
  );
  assert.equal(searchPayload.processingMode, 'auto');
  assert.equal(searchPayload.sourcePolicy, 'doc88-first');
  assert.equal(searchPayload.enhanceImages, true);
  await page.waitForFunction(
    () => document.querySelector('#status-pill').textContent === 'Checking the document',
  );
  await page.waitForFunction(
    () => document.querySelector('#status-pill').textContent === 'Preparing PDF',
  );
  assert.equal(await page.locator('#clear-workspace').isDisabled(), true);
  assert.doesNotMatch(await page.locator('body').innerText(), /PRIVATE_DETAILS|page 1 of 99/);
  await page.waitForFunction(
    () => document.querySelector('#job-message').textContent === 'Your document is ready.',
  );
  await selectFixture(series);
  await page.locator('#series-dialog').waitFor();
  assert.equal(await page.locator('#series-options input').count(), 3);
  assert.equal(await page.locator('#series-submit').isDisabled(), true);
  await page.locator('#series-all').click();
  assert.equal(await page.locator('#series-options input:checked').count(), 3);
  await page.locator('#series-none').click();
  assert.equal(await page.locator('#series-options input:checked').count(), 0);
  await page.locator('#series-options input').nth(0).check();
  await page.locator('#series-options input').nth(2).check();
  await page.screenshot({ path: path.join(output, 'series-selection-en.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: path.join(output, 'series-selection-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.locator('#series-submit').click();
  await page.locator('#series-dialog').waitFor({ state: 'hidden' });
  await page.waitForFunction(
    () => document.querySelectorAll('#batch-list .batch-row').length === 2,
  );
  assert.match(await page.locator('#batch-list').innerText(), /ISO 17450-1:2020/);
  assert.match(await page.locator('#batch-list').innerText(), /ISO 17450-3:2020/);
  await page.waitForFunction(() => !document.getElementById('clear-workspace').disabled);
  assert.equal(await page.locator('#clear-queue').isVisible(), true);
  const oldBatch = (await (await page.request.get(origin + '/api/status')).json()).batches[0];
  const oldPDF = oldBatch.items[0].id;
  await page.locator('#clear-queue').click();
  for (const id of [
    'result-section',
    'batch-section',
    'document-details',
    'search-results-section',
    'history-section',
  ])
    assert.equal(await page.locator('#' + id).isVisible(), false, id);
  assert.equal(await page.locator('#search-query').inputValue(), '');
  assert.equal(await page.locator('#batch-queries').inputValue(), '');
  assert.equal(await page.locator('#batch-list .batch-card').count(), 0);
  await page.reload();
  await page.waitForFunction(() => !document.getElementById('clear-workspace').disabled);
  for (const id of ['result-section', 'batch-section', 'document-details'])
    assert.equal(await page.locator('#' + id).isVisible(), false, 'After reload: ' + id);
  assert.equal((await page.request.get(origin + '/api/jobs/' + oldPDF + '/pdf')).status(), 200);
  await page.screenshot({ path: path.join(output, 'cleared-workspace-en.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({
    path: path.join(output, 'cleared-workspace-mobile.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.locator('#batch-tab').click();
  await page.locator('#batch-queries').fill('ISO 5458:2018');
  await page.locator('#start-batch').click();
  await page.locator('#result-section').waitFor();
  await page.locator('#batch-section').waitFor();
  await page.waitForFunction(
    () => document.querySelectorAll('#batch-list .batch-row').length === 1,
  );
  assert.equal(await page.locator('#batch-list .batch-card').count(), 1);
  assert.match(await page.locator('#batch-list').innerText(), /ISO 5458:2018/);
  assert.doesNotMatch(await page.locator('#batch-list').innerText(), /ISO 17450/);
  await page.waitForFunction(() => !document.getElementById('clear-workspace').disabled);
  await page.locator('#clear-workspace').click();
  assert.equal(await page.locator('#batch-section').isVisible(), false);
  await page.locator('#search-query').fill('ISO 5458:2018');
  await page.locator('#start-search').click();
  await page.locator('#result-section').waitFor();
  await page.waitForFunction(() => !document.getElementById('clear-workspace').disabled);
  assert.equal(await page.locator('#batch-section').isVisible(), false);
  assert.equal(await page.locator('#document-details').isVisible(), false);
  await selectFixture(dinSeries);
  await page.locator('#series-dialog').waitFor();
  await page.locator('#series-all').click();
  await page.locator('#series-submit').click();
  await page.locator('#series-dialog').waitFor({ state: 'hidden' });
  await page.locator('#language-dialog').waitFor();
  assert.equal(await page.locator('#language-heading').innerText(), 'Series language');
  assert.equal(await page.locator('#language-options input').count(), 2);
  assert.equal(await page.locator('#language-reference').innerText(), 'DIN 17450');
  await page.locator('#language-options input[value=eng]').check();
  await page.screenshot({ path: path.join(output, 'series-language-en.png'), fullPage: true });
  await page.locator('[data-locale=ru]').evaluate((button) => button.click());
  await page.waitForFunction(
    () => document.querySelector('#language-heading').textContent === 'Язык серии',
  );
  assert.equal(
    await page.locator('#language-question').innerText(),
    'Выберите один или несколько языков для выбранных документов.',
  );
  await page.screenshot({ path: path.join(output, 'series-language-ru.png'), fullPage: true });
  await page.locator('[data-locale=en]').evaluate((button) => button.click());
  await page.locator('#language-submit').click();
  await page.waitForFunction(
    () =>
      document.querySelector('#language-heading').textContent === 'Document language' &&
      document
        .querySelector('#language-question')
        .textContent.includes('series language is unavailable'),
  );
  assert.equal(await page.locator('#language-options input').count(), 1);
  assert.equal(await page.locator('#language-reference').innerText(), dinEditions[1].reference);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({
    path: path.join(output, 'series-language-exception-mobile.png'),
    fullPage: true,
  });
  await page.locator('#language-options input[value=deu]').check();
  await page.locator('#language-submit').click();
  await page.locator('#language-dialog').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => !document.getElementById('clear-workspace').disabled);
  const dinBatch = (await (await page.request.get(origin + '/api/status')).json()).batches.find(
    (batch) => batch.items[0].query === dinEditions[0].reference,
  );
  assert.equal(dinBatch.total, 2);
  const dinJobs = await Promise.all(
    dinBatch.items.map(async (item) =>
      (await page.request.get(origin + '/api/jobs/' + item.id)).json(),
    ),
  );
  assert.deepEqual(
    dinJobs.map((job) => job.documentLanguage),
    ['eng', 'deu'],
  );
  // Only local fixtures are interacted with here; no external verification is automated.
  const confirmation = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  confirmation.on('pageerror', (error) => errors.push(error.message));
  await confirmation.addInitScript((id) => localStorage.setItem('doc88-selected', id), failed);
  const waiting = {
    id: done,
    kind: 'search',
    query: 'ISO 129-1:2018',
    title: 'ISO 129-1:2018',
    stage: 'waiting',
    challengeAvailable: true,
    createdAt: new Date().toISOString(),
  };
  const { createCanvas } = require('@napi-rs/canvas');
  const canvas = createCanvas(960, 720),
    ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, 960, 720);
  ctx.fillStyle = '#254e7c';
  ctx.font = '28px sans-serif';
  ctx.fillText('Local interface fixture', 40, 70);
  const frame = {
    token: 'local-test-token',
    keyboard: true,
    image: 'data:image/png;base64,' + canvas.toBuffer('image/png').toString('base64'),
  };
  const inputs = [];
  await confirmation.route('**/api/status', (route) =>
    route.fulfill({
      json: {
        devMode: false,
        devConfigured: true,
        ocr: 'ready',
        activeId: failed,
        jobs: [
          waiting,
          { ...waiting, id: failed, title: 'Other active job', challengeAvailable: false },
        ],
        batches: [],
      },
    }),
  );
  await confirmation.route('**/challenge/frame', (route) => route.fulfill({ json: frame }));
  await confirmation.route('**/challenge/input', (route) => {
    inputs.push(route.request().postDataJSON());
    return route.fulfill({ json: { ok: true } });
  });
  await confirmation.goto(origin + '/?job=' + done);
  await confirmation.locator('#challenge-image').waitFor();
  assert.equal(await confirmation.locator('#job-title').innerText(), 'ISO 129-1:2018');
  assert.equal(await confirmation.locator('#anna-experiment').isVisible(), false);
  await confirmation.locator('#challenge-image').click({ position: { x: 50, y: 40 } });
  await confirmation.locator('#challenge-answer').fill('LOCAL');
  await confirmation.locator('#challenge-keyboard button[type=submit]').click();
  await confirmation.waitForFunction(() => !document.getElementById('challenge-answer').value);
  const enterResponse = confirmation.waitForResponse(
    (response) =>
      response.url().endsWith('/challenge/input') &&
      response.request().postDataJSON()?.key === 'Enter',
  );
  await confirmation.locator('#challenge-enter').click();
  await enterResponse;
  assert.ok(inputs.some((input) => input.type === 'down' && input.token === frame.token));
  assert.ok(inputs.some((input) => input.type === 'up'));
  assert.ok(inputs.some((input) => input.type === 'text' && input.text === 'LOCAL'));
  assert.ok(inputs.some((input) => input.type === 'key' && input.key === 'Enter'));
  await confirmation.locator('#challenge-expand').click();
  assert.ok(
    await confirmation
      .locator('#challenge-panel')
      .evaluate((el) => el.classList.contains('expanded')),
  );
  assert.ok((await confirmation.locator('#challenge-image').boundingBox()).width > 800);
  await confirmation.screenshot({ path: path.join(output, 'confirmation-expanded-ru.png') });
  await confirmation.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await confirmation.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
  );
  await confirmation.locator('#challenge-expand').click();
  await confirmation.locator('[data-locale=en]').click();
  await confirmation.waitForFunction(
    () => document.getElementById('challenge-expand').textContent === 'Enlarge verification',
  );
  assert.doesNotMatch(await confirmation.locator('#challenge-panel').innerText(), /[А-Яа-яЁё]/);
  await confirmation.close();
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.evaluate(() => localStorage.removeItem('declipdf-cleared-workspace'));
  await page.goto(origin + '/?job=' + done);
  await page.locator('#document-review').waitFor();
  await page.locator('[name="review-rating"][value="bad"]').check();
  await page.locator('#review-comment').fill('<img src=x onerror=alert(1)> Wrong edition');
  await page.locator('#review-save').click();
  await page.waitForFunction(
    () => document.getElementById('review-status').textContent === 'Review saved',
  );
  await page.waitForTimeout(1300);
  assert.equal(
    await page.locator('#review-comment').inputValue(),
    '<img src=x onerror=alert(1)> Wrong edition',
  );
  await page.keyboard.press('Control+Shift+D');
  await page.locator('#dev-dialog').waitFor();
  await page.locator('#dev-password').fill('interface-fixture');
  await page.locator('#dev-submit').click();
  await page.locator('#document-cache').waitFor();
  await page.locator('#document-cache > summary').click();
  await page.locator('#cache-filter').fill('ISO 5458');
  try {
    await page.waitForFunction(
      () => document.getElementById('review-log').textContent.includes('Wrong edition'),
      {},
      { timeout: 5000 },
    );
  } catch (e) {
    console.log(
      JSON.stringify({
        cache: await (await page.request.get(origin + '/api/dev/cache')).json(),
        text: await page.locator('#document-cache').innerText(),
      }),
    );
    await page.screenshot({ path: path.join(output, 'cache-failure.png'), fullPage: true });
    throw e;
  }
  const tableRows = await page.locator('#cache-items tbody tr').allTextContents();
  assert.equal(tableRows.length, 1, 'repeat ISO edition runs must share one table row');
  assert.equal(await page.locator('#cache-items img').count(), 0);
  assert.doesNotMatch(await page.locator('#document-cache').innerText(), /[А-Яа-яЁё]/);
  await page
    .locator('#document-cache')
    .screenshot({ path: path.join(output, 'cache-reviews-en.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page
    .locator('#document-cache')
    .screenshot({ path: path.join(output, 'cache-reviews-mobile.png') });
  await page.locator('[data-locale=ru]').click();
  await page.locator('#document-review').screenshot({ path: path.join(output, 'review-ru.png') });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      interface: 'RU/EN',
      ocr: ['eng', 'deu', 'rus'],
      isoForcesEnglish: true,
      passwordGate: true,
      diagnosticsHidden: true,
      editionChoice: true,
      pdfDownload: true,
      mobileOverflow: false,
      workspaceReset: true,
      resetPersistsAfterReload: true,
      newWorkReappears: true,
      seriesLanguageOnce: true,
      seriesLanguageException: true,
      experimentalPDFGate: true,
      linkedJobSelection: true,
      manualVerificationInput: true,
      screenshots: output,
    }),
  );
})()
  .catch((error) => {
    console.error(error.stack);
    process.exitCode = 1;
  })
  .finally(async () => {
    await browser?.close();
    if (child && child.exitCode === null) {
      const ended = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await ended;
    }
    if (directory) {
      assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith('declipdf-interface-'));
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
