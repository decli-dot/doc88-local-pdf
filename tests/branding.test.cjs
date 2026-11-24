const test = require('node:test');
const assert = require('node:assert/strict');
const { name, present, displayText } = require('../dist/product.js');

test('DecliPDF hides legacy provider text while preserving source addresses and identifiers for recovery', () => {
  const url = 'https://www.doc88.com/p-2592543989165.html';
  const stored = {
    id: 'saved-job',
    query: 'ISO 5458:2018',
    url,
    title: 'Doc88 PDF',
    message: 'Ищем документ на Doc88…',
    searchResults: [
      {
        url,
        title: 'ISO 5458:2018',
        checks: { completeness: { message: 'Все страницы Doc88 проверены.' } },
        error: 'Doc88 недоступен: https://www.doc88.com/p-2592543989165.html',
      },
    ],
    isoEdition: {
      sourceURL: 'https://www.iso.org/standard/65559.html',
      reference: 'ISO 5458:2018',
    },
  };
  const shown = present(stored);
  assert.equal(name, 'DecliPDF');
  assert.equal(shown.title, name);
  assert.equal(shown.url, url);
  assert.equal(shown.searchResults[0].url, url);
  assert.equal(shown.query, stored.query);
  assert.equal(shown.id, stored.id);
  assert.deepEqual(shown.isoEdition, stored.isoEdition);
  assert.doesNotMatch(
    [
      shown.message,
      shown.searchResults[0].error,
      shown.searchResults[0].checks.completeness.message,
    ].join('\n'),
    /doc88/i,
  );
  assert.equal(stored.title, 'Doc88 PDF');
  assert.equal(
    displayText('ISO 17450-3:2016 — General concepts'),
    'ISO 17450-3:2016 — General concepts',
  );
});
