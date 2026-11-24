const test = require('node:test'),
  assert = require('node:assert/strict');
const { identityCheck, titleMatches, searchDocumentPages } = require('../search.cjs');
const { createPreviewPool } = require('../preview-pool.cjs');
const { parseITEH } = require('../iteh-catalog.cjs');
const iso = require('../iso-catalog.cjs');
test('ASME reaffirmation is proven by front matter, never inferred from matching base year', () => {
  const q = 'ASME Y14.5-2018 (R2024)';
  assert.equal(identityCheck(q, ['ASME Y14.5-2018']).status, 'failed');
  assert.equal(identityCheck(q, ['ASME Y14.5-2018\nREAFFIRMED 2020']).status, 'failed');
  assert.equal(
    identityCheck(q, ['ASME Y14.5-2018\nR E A F F I R M E D 2 0 2 4']).reaffirmed,
    '2024',
  );
  assert.equal(
    identityCheck(q, ['ASME Y14.5-2018', 'Copyright', 'REAFFIRMED 2024']).status,
    'passed',
  );
  assert.equal(identityCheck('ASME Y14.5-2018', ['ASME Y14.5-2018']).status, 'passed');
  for (const title of ['ASMEY1452018', 'ASME Y14 5 2018', 'ASME Y14.5-2018 (R2024)'])
    assert.equal(titleMatches(q, title), true);
  assert.equal(titleMatches(q, 'ASME Y14.50-2018'), false);
});
test('five preflights overlap and every task is drained on close', async () => {
  let active = 0,
    peak = 0,
    release;
  const gate = new Promise((r) => (release = r));
  const pool = createPreviewPool(
    [0, 1, 2, 3, 4],
    async (n) => {
      active++;
      peak = Math.max(peak, active);
      if (active === 5) release();
      await gate;
      active--;
      return n;
    },
    { signal: new AbortController().signal, concurrency: 5 },
  );
  assert.equal((await pool.take(0)).value, 0);
  assert.equal(peak, 5);
  for (let n = 1; n < 5; n++) assert.equal((await pool.take(n)).value, n);
  await pool.close();
  assert.equal(active, 0);
});
test('default source discovery reaches page 101 instead of ending at an arbitrary page cap', async () => {
  const visited = [];
  const iterator = searchDocumentPages('ISO 5458:2018', new AbortController().signal, () => {}, {
    fetcher: async (value) => {
      const p = Number(new URL(value).searchParams.get('p'));
      visited.push(p);
      const title = p === 101 ? 'ISO 5458:2018' : 'ISO 9999:2000';
      return new Response(
        `<div class="sd-list-con"><h3><a class="sd-title" href="https://www.doc88.com/p-${p}.html">${title}</a></h3><p>页数：80</p></div><div id="page"><span class="current">${p}</span>${p < 101 ? `<a onclick="Search.searchPage('p=${p + 1}')">next</a>` : ''}</div>`,
      );
    },
  });
  const result = await iterator.next();
  assert.equal(visited.length, 101);
  assert.equal(result.value[0].url, 'https://www.doc88.com/p-101.html');
  await iterator.return();
});
test('iTeh page counts follow language and exact publisher/part rather than a translated or national neighbour', () => {
  const row = {
    id: 'cda0743a-d12c-45c6-87fd-4e96ffda6041',
    organization: { externalCode: 'ISO' },
    projectReference: 'ISO 7200:2004',
    title: 'Official title',
    standardStatus: { value: 'Published' },
    projectDocuments: [
      { type: { value: 'Standard' }, language: { externalCode: 'en' }, numberOfPages: 6 },
      { type: { value: 'Standard' }, language: { externalCode: 'fr' }, numberOfPages: 7 },
    ],
  };
  const wanted = iso.reference('ISO 7200:2004');
  assert.equal(parseITEH({ data: [row] }, wanted, 'eng')[0].pageCount, 6);
  assert.equal(parseITEH({ data: [row] }, wanted, 'fra')[0].pageCount, 7);
  assert.equal(parseITEH({ data: [row] }, wanted, 'deu').length, 0);
  assert.equal(
    parseITEH({ data: [{ ...row, projectReference: 'SIST ISO 7200:2004' }] }, wanted).length,
    0,
  );
  assert.equal(
    parseITEH({ data: [{ ...row, projectReference: 'ISO 7200-1:2004' }] }, wanted).length,
    0,
  );
});
