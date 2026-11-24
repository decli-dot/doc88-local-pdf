const test = require('node:test'),
  assert = require('node:assert/strict');
const { publicJob } = require('../dev-access.cjs');
const feedback = require('../dist/job-feedback.js');
const { confidenceFromTSV, qualityPage, mergeOCRQuality } = require('../ocr-quality.cjs');
test('automatic access verification does not ask for a human action or reveal the provider', () => {
  const value = publicJob({
    id: 'captcha',
    stage: 'waiting',
    captchaSolving: true,
    captchaDiagnostics: { provider: 'rucaptcha' },
  });
  assert.equal(value.progress.label, 'Проверяем доступ');
  assert.equal(value.challengeAvailable, undefined);
  assert.doesNotMatch(JSON.stringify(value), /rucaptcha|captchaDiagnostics|Нужно действие/);
});

test('ordinary progress follows three phases and never displays internal messages', () => {
  for (const [stage, workflowPhase, step, label] of [
    ['resolving', null, 0, 'Уточняем издание'],
    ['searching', null, 1, 'Проверяем документ'],
    ['checking', 'checking', 1, 'Проверяем документ'],
    ['downloading', 'pdf', 2, 'Готовим PDF'],
    ['ocr', 'pdf', 2, 'Готовим PDF'],
    ['checking', 'pdf', 2, 'Готовим PDF'],
  ]) {
    const value = publicJob({
      stage,
      workflowPhase,
      message: 'PRIVATE https://www.doc88.com/p-1.html',
    });
    assert.equal(value.progress.step, step);
    assert.equal(value.progress.label, label);
    assert.doesNotMatch(JSON.stringify(value), /PRIVATE|doc88|workflowPhase/);
  }
});

test('exhausted search distinguishes no match, wrong language, shortened uploads and wrong editions', () => {
  const base = {
    kind: 'search',
    stage: 'error',
    query: 'ISO 5458:2018',
    errorCode: 'SEARCH_EXHAUSTED',
    pdfReady: false,
  };
  const item = (checks) => ({ status: 'rejected', checks });
  const cases = [
    [[], 'not_found'],
    [[item({ language: { status: 'failed' } })], 'language'],
    [[item({ extent: { status: 'failed' } })], 'incomplete'],
    [[item({ identity: { status: 'failed' } })], 'edition'],
    [
      [item({ language: { status: 'failed' } }), item({ extent: { status: 'failed' } })],
      'not_found',
    ],
  ];
  for (const [searchResults, type] of cases) {
    const value = publicJob({ ...base, searchResults });
    assert.equal(value.problem.type, type);
    assert.doesNotMatch(JSON.stringify(value), /searchResults|errorCode/);
    assert.equal(value.query, base.query);
    assert.ok(value.problem.actions.every((action) => action.type !== 'edition'));
  }
  const access = publicJob({ ...base, errorCode: 'SEARCH_INCOMPLETE', failureKind: 'access' });
  assert.equal(access.problem.type, 'access');
  assert.equal(access.problem.actions[0].label, 'Повторить попытку');
  assert.equal(feedback.failureKind(Error('HTTP 429: private hostname')), 'access');
  const catalogue = publicJob({ ...base, errorCode: 'UNKNOWN_METADATA', failureKind: 'catalogue' });
  assert.equal(catalogue.problem.type, 'catalogue');
  assert.ok(catalogue.problem.actions.some((action) => action.type === 'edit'));
});

test('language recovery is offered only when the same publisher and edition allow another language', () => {
  const base = {
    stage: 'error',
    errorCode: 'SEARCH_EXHAUSTED',
    documentLanguage: 'eng',
    searchResults: [{ status: 'rejected', checks: { language: { status: 'failed' } } }],
  };
  assert.ok(
    !publicJob({ ...base, query: 'ISO 5458:2018' }).problem.actions.some(
      (action) => action.type === 'language',
    ),
  );
  const din = publicJob({
    ...base,
    query: 'DIN 5008:2020-03',
    catalogueEdition: { languages: ['eng', 'deu'] },
  });
  assert.ok(din.problem.actions.some((action) => action.type === 'language'));
  assert.equal(din.query, 'DIN 5008:2020-03');
  assert.ok(
    !publicJob({
      ...base,
      query: 'DIN 5008:2020-03',
      catalogueEdition: { languages: ['eng'] },
    }).problem.actions.some((action) => action.type === 'language'),
  );
});

test('ready-PDF notes expose valid evidence pages but no source data or invented page locations', () => {
  const job = {
    id: 'sample',
    stage: 'done',
    pdfReady: true,
    total: 5,
    logs: ['PRIVATE'],
    pageIntegrity: { status: 'unknown', uncertainPages: [-1, 2, 2, 99], message: 'PRIVATE' },
    verification: {
      language: {
        status: 'unknown',
        evidence: [
          { page: 5, matched: false },
          { page: 88, matched: false },
        ],
      },
    },
    ocrQuality: { uncertainPages: [3, 0, 7] },
    textlessPages: [4],
    blankPages: 1,
  };
  const value = publicJob(job);
  assert.deepEqual(
    value.qualityNotes.map((note) => [note.type, note.pages]),
    [
      ['numbering', [2]],
      ['language', [5]],
      ['ocr', [3]],
      ['textless', [4]],
    ],
  );
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE|pageIntegrity|ocrQuality|evidence/);
  const unknown = publicJob({
    ...job,
    pageIntegrity: { status: 'unknown' },
    verification: null,
    ocrQuality: null,
    textlessPages: [],
    blankPages: 0,
  });
  assert.deepEqual(unknown.qualityNotes[0].pages, []);
  assert.deepEqual(publicJob({ ...job, stage: 'error', pdfReady: false }).qualityNotes, []);
});

test('OCR confidence uses real word evidence, preserves unknown caches, and supports original page numbers', () => {
  const tsv =
    'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n' +
    '5\t1\t1\t1\t1\t1\t0\t0\t20\t10\t40\tword\n' +
    '5\t1\t1\t1\t1\t2\t0\t0\t20\t10\t80\tword\n';
  assert.equal(confidenceFromTSV(tsv), 60);
  assert.equal(confidenceFromTSV(''), null);
  const prose =
    'This document defines the requirements for measurement and inspection of manufactured parts.';
  const result = mergeOCRQuality({ pages: [qualityPage(1, prose, null)] }, [
    qualityPage(7, prose, 50),
    qualityPage(8, 'x y z', 20),
  ]);
  assert.deepEqual(result.uncertainPages, [7]);
  assert.equal(result.pages[0].confidence, null);
});
