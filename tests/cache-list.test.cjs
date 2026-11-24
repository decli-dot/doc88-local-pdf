const test = require('node:test'),
  assert = require('node:assert/strict');
const { cacheList } = require('../cache-list.cjs');
const { reviewKey } = require('../document-review.cjs');
const job = (id, query, extra = {}) => ({
  id,
  query,
  title: query,
  stage: 'done',
  pdfReady: true,
  documentLanguage: 'eng',
  url: 'https://www.doc88.com/p-' + id + '.html',
  createdAt: '2026-11-10T10:00:00Z',
  valid: true,
  ...extra,
});
test('cache collapses repeat runs while preserving different editions, parts, publishers and languages', () => {
  const records = [
    job('1', 'ISO 5458:2018'),
    job('2', 'iso 5458 2018'),
    job('3', 'ISO 5458:1998'),
    job('4', 'ISO 5458:2018', { documentLanguage: 'deu' }),
    job('5', 'BS EN ISO 5458:2018'),
    job('6', 'ISO 129-1:2018'),
    job('7', 'ISO 129-2:2021'),
    job('8', 'ASME Y14.5-2018'),
    job('9', 'ASME Y14.5-2018 (R2024)'),
  ];
  const rows = cacheList(records, {}, (j) => j.valid);
  assert.equal(rows.length, 8);
  assert.equal(
    rows.filter((r) => r.reference === 'ISO 5458:2018' && r.language === 'eng').length,
    1,
  );
  assert.equal(rows.find((r) => r.reference === 'ISO 5458:2018' && r.language === 'eng').id, '2');
});
test('a verified good copy wins over a newer rejected or unverified copy; comments belong to the chosen copy', () => {
  const good = job('1', 'ISO 7200:2004'),
    bad = job('2', 'ISO 7200:2004', { createdAt: '2026-11-10T11:00:00Z' }),
    unknown = job('3', 'ISO 7200:2004', { valid: false, createdAt: '2026-11-10T12:00:00Z' });
  const reviews = {
    [reviewKey(good)]: { rating: 'good', comment: 'Checked' },
    [reviewKey(bad)]: { rating: 'bad', comment: 'Wrong cover' },
  };
  const rows = cacheList([good, bad, unknown], reviews, (j) => j.valid);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, '1');
  assert.equal(rows[0].review.comment, 'Checked');
  assert.equal(Object.keys(reviews).length, 2);
});
