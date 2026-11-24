const test = require('node:test'),
  assert = require('node:assert/strict');
const { recordsFromHits, chooseEN, resolveEN } = require('../en-catalog.cjs');
const designation = require('../dist/standard-reference.js');
const { runSearchJob } = require('../search.cjs');
const policy = require('../dist/ocr-language.js');
const hit = (part, year = 2022, extra = {}) => ({
  objectID: String(100 + part),
  titel_DOK: `DIN EN 14420-${part}:2024-06`,
  untertitel_en: `Official part ${part}; German version EN 14420-${part}:${year}`,
  'dokument-typ': 'N',
  'ist-zurueckgezogen': 0,
  ...extra,
});
test('EN series derives European dates from explicit CEN-member metadata, excludes drafts and never invents EN page counts', async () => {
  const wanted = designation.parse('EN 14420'),
    hits = [
      ...Array.from({ length: 8 }, (_, i) => hit(i + 1)),
      hit(7, 2025, { 'dokument-typ': 'N-E' }),
      { ...hit(9), untertitel_en: 'Other standard EN 14421-9:2022' },
    ];
  let requests = 0;
  const edition = await resolveEN(wanted, {
    request: async (url) => {
      requests++;
      return {
        bytes: Buffer.from(
          url.includes('algolia')
            ? JSON.stringify({ hits, nbPages: 1 })
            : '<i data-app-id="ABC123" data-api-key="abcdef" data-suggestion-index="test" data-index-name="test"></i>',
        ),
      };
    },
  });
  assert.equal(edition.series, true);
  assert.equal(edition.items.length, 8);
  assert.equal(requests, 2);
  assert.equal(edition.items[0].reference, 'EN 14420-1:2022');
  assert.equal(edition.items[0].pageCount, null);
  assert.equal(edition.items[0].extentPolicy, 'source');
  assert.equal(
    chooseEN(designation.parse('EN 14420-2'), recordsFromHits(hits, wanted)).reference,
    'EN 14420-2:2022',
  );
  assert.throws(
    () => chooseEN(designation.parse('EN 14420-2:2015'), recordsFromHits(hits, wanted)),
    (error) => error.code === 'PUBLISHER_EDITION_CHOICE',
  );
  assert.throws(
    () =>
      chooseEN(
        designation.parse('EN 14420-2'),
        recordsFromHits([...hits, hit(2, 2004, { 'ist-zurueckgezogen': 1 })], wanted),
        { chooseEdition: true },
      ),
    (error) => {
      assert.equal(error.code, 'PUBLISHER_EDITION_CHOICE');
      assert.deepEqual(
        error.editions.map((e) => e.reference),
        ['EN 14420-2:2022', 'EN 14420-2:2004'],
      );
      return true;
    },
  );
  assert.equal(
    chooseEN(wanted, recordsFromHits(hits, wanted), { chooseEdition: true }).series,
    true,
  );
  const job = {
    query: 'EN 14420',
    controller: new AbortController(),
    update(x) {
      Object.assign(this, x);
    },
    log() {},
  };
  await runSearchJob(job, 'unused', {
    chooseEdition: true,
    lookupPublisher: async () => edition,
    search: () => assert.fail('Series must stop before searching'),
  });
  assert.equal(job.stage, 'selecting');
});
test('document language waits after catalogue resolution, validates the selected language and narrows OCR', async () => {
  const job = {
    query: 'DIN 129-1',
    controller: new AbortController(),
    update(x) {
      Object.assign(this, x);
    },
    log() {},
  };
  await runSearchJob(job, 'unused', {
    lookupPublisher: async () => ({
      publisher: 'DIN',
      reference: 'DIN EN ISO 129-1:2022-02',
      title: 'Title',
      pageCount: 83,
      languages: ['eng', 'deu'],
    }),
    search: () => assert.fail('Wait for language selection'),
  });
  assert.equal(job.stage, 'language');
  assert.deepEqual(
    job.languageChoices.map((x) => x.code),
    ['eng', 'deu'],
  );
  assert.equal(policy.resolve(job.resolvedQuery, 'eng', 'deu'), 'deu');
  assert.throws(() => policy.resolve('DIN 129-1', 'eng', 'fra'));
  assert.equal(policy.resolve('ISO 1101', 'deu'), 'eng');
  assert.deepEqual(policy.choices('NF 129-1', { languages: ['fra'] }), [
    { code: 'fra', label: 'Французский' },
  ]);
});
