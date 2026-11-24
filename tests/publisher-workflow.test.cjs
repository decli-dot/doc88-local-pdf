const test = require('node:test');
const assert = require('node:assert/strict');
const designation = require('../dist/standard-reference.js');
const { resolve, explicitForeign } = require('../dist/ocr-language.js');
const { choosePublisherEdition, parseDIN } = require('../publisher-catalog.cjs');
const { parseReseller, resellerEditions } = require('../reseller-catalog.cjs');
const {
  searchQueries,
  searchAllDocuments,
  identityCheck,
  analyseTextPages,
  isoExtentCheck,
} = require('../search.cjs');
test('short national designations resolve EN/ISO adaptations without crossing publishers or parts', () => {
  for (const publisher of ['DIN', 'BS', 'NF']) {
    const wanted = designation.parse(publisher + ' 129-1');
    const edition = {
      publisher,
      reference: publisher + ' EN ISO 129-1:2022-02',
      title: 'Official title',
      pageCount: 83,
      status: 'Published',
    };
    assert.equal(choosePublisherEdition(wanted, [edition]).reference, edition.reference);
    assert.equal(designation.family(wanted, designation.parse('DIN EN ISO 129-2:2022')), false);
    assert.equal(
      designation.family(
        wanted,
        designation.parse((publisher === 'DIN' ? 'BS' : 'DIN') + ' EN ISO 129-1:2022'),
      ),
      false,
    );
  }
  assert.equal(resolve('DIN EN ISO 129-1', 'rus'), 'eng+deu');
  assert.equal(resolve('NF EN ISO 129-1', 'rus'), 'eng+fra');
  assert.equal(resolve('BS EN ISO 129-1', 'rus'), 'eng');
  assert.equal(resolve('ASME Y14.6', 'deu'), 'eng');
  assert.equal(
    choosePublisherEdition(designation.parse('DIN 129-1'), [
      {
        publisher: 'DIN',
        reference: 'DIN 129-1:2020',
        title: 'Native DIN',
        pageCount: 10,
        status: 'Published',
      },
      {
        publisher: 'DIN',
        reference: 'DIN EN ISO 129-1:2022-02',
        title: 'Adaptation',
        pageCount: 83,
        status: 'Published',
      },
    ]).reference,
    'DIN 129-1:2020',
  );
  assert.throws(
    () =>
      choosePublisherEdition(designation.parse('BS 129-1'), [
        { reference: 'BS EN 129-1:2020', title: 'A', pageCount: 10, status: 'Published' },
        { reference: 'BS EN ISO 129-1:2019', title: 'B', pageCount: 80, status: 'Published' },
      ]),
    (error) => error.code === 'PUBLISHER_EDITION_CHOICE',
  );
});
test('yearless publisher requests offer published and historical editions without changing explicit years', () => {
  for (const prefix of ['ASME Y14.6', 'DIN EN ISO 129-1', 'BS EN ISO 129-1', 'NF EN ISO 129-1']) {
    const records = [
      { reference: prefix + ':2022', title: 'Current title', pageCount: 83, status: 'Published' },
      { reference: prefix + ':2004', title: 'Earlier title', pageCount: 80, status: 'Withdrawn' },
      {
        reference: prefix + ':2027',
        title: 'Draft title',
        pageCount: 90,
        status: 'Under development',
      },
    ];
    assert.throws(
      () => choosePublisherEdition(designation.parse(prefix), records, { chooseEdition: true }),
      (error) => {
        assert.equal(error.code, 'PUBLISHER_EDITION_CHOICE');
        assert.deepEqual(
          new Set(error.editions.map((e) => e.reference)),
          new Set(records.slice(0, 2).map((e) => e.reference)),
        );
        return true;
      },
    );
    assert.equal(
      choosePublisherEdition(designation.parse(prefix + ':2004'), records, { chooseEdition: true })
        .reference,
      records[1].reference,
    );
  }
});

test('national dates and amendments are read from catalogue fields without inventing a current-edition claim', async () => {
  const label = 'BS EN ISO 129-1:2019+A1:2021',
    url = 'https://www.en-standard.eu/bs-en-iso-129-1-2019-a1-2021-example/';
  const html = `<h1>${label}</h1><h2>Technical product documentation</h2><table><tr><td>Standard number:</td><td>${label}</td></tr><tr><td>Pages:</td><td>76</td></tr><tr><td>Released:</td><td>2021-01-21</td></tr><tr><td>Status:</td><td>Standard</td></tr></table>`;
  const datedDIN = parseReseller(
    '<h1>DIN EN ISO 129-1</h1><h2>Technical documentation</h2><table><tr><td>Standard number:</td><td>DIN EN ISO 129-1</td></tr><tr><td>Released:</td><td>2022-02</td></tr><tr><td>Pages:</td><td>83</td></tr></table>',
    'https://www.en-standard.eu/din-en-iso-129-1-example/',
  );
  assert.equal(datedDIN.reference, 'DIN EN ISO 129-1:2022-02');
  const record = parseReseller(html, url);
  assert.equal(record.year, 2019);
  assert.equal(record.reference, label);
  assert.equal(record.currentConfirmed, false);
  assert.equal(record.pageCount, 76);
  const records = await resellerEditions(designation.parse('BS 129-1'), {
    request: async (requestURL) =>
      requestURL.endsWith('/search/')
        ? { bytes: Buffer.from(`<a href="${url}">${label}</a>`) }
        : { bytes: Buffer.from(html) },
  });
  assert.equal(records.length, 1);
  assert.equal(
    parseDIN(
      '<h1>NF EN ISO 129-1:2019-10-08</h1><h2 class="bwr-section-hero__subtitle">French standard</h2>[CURRENT] Pages 79',
      'https://www.dinmedia.de/en/standard/nf-en-iso-129-1/123',
    ).publisher,
    'NF',
  );
  assert.equal(
    identityCheck('NF EN ISO 129-1:2019-10-08', [
      'NF EN ISO 129-1\noctobre 2019\nDocumentation technique',
    ]).status,
    'passed',
  );
  assert.equal(
    identityCheck('DIN EN ISO 129-1:2022-02', ['DIN EN ISO 129-1\nFebruar 2022\nISO 129-1:2018'])
      .status,
    'passed',
  );
  assert.equal(identityCheck('ASME Y14.6-2001 (R2025)', ['ASME Y14.6-2001']).status, 'failed');
  assert.equal(
    identityCheck('ASME Y14.6-2001 (R2025)', ['ASME Y14.6-1999\nRevised from ASME Y14.6-2001'])
      .status,
    'failed',
  );
  assert.doesNotMatch(isoExtentCheck(24, { publisher: 'ASME', pageCount: 24 }).message, /ISO/);
});
test('search queries omit reaffirmations, include undated search, keep pagination despite duplicates, and never contact disabled sources', async () => {
  assert.deepEqual(searchQueries('ASME Y14.6-2001 (R2025)'), [
    'ASME Y14.6-2001 (R2025)',
    'ASME Y14.6-2001',
    'ASME Y14.6',
    'ASMEY14.6',
    'ASME Y14 6',
    'ASMEY146',
  ]);
  const calls = [];
  const controller = new AbortController();
  const fetcher = async (value) => {
    const url = new URL(value);
    assert.equal(url.hostname, 'www.doc88.com');
    const q = url.searchParams.get('q'),
      page = Number(url.searchParams.get('p'));
    calls.push([q, page]);
    const count = page === 1 ? 20 : q === 'ASME Y14.6' ? 2 : 0;
    let html = '<div id="pageResult">';
    for (let i = 0; i < count; i++) {
      const id = page === 1 ? i + 1 : i + 21;
      html += `<div class="sd-list-con"><a class="sd-title" href="https://www.doc88.com/p-${id}.html" title="ASME Y14.6">ASME Y14.6</a>页数：24 格式：PDF</div>`;
    }
    return new Response(html + '</div>');
  };
  const result = await searchAllDocuments('ASME Y14.6-2001 (R2025)', controller.signal, () => {}, {
    fetcher,
  });
  assert.equal(result.length, 22);
  assert.ok(calls.some(([q, p]) => q === 'ASME Y14.6' && p === 2));
  assert.equal(calls[0][0], 'ASME Y14.6-2001 (R2025)');
  assert.ok(calls.some(([q]) => q === 'ASME Y14.6'));
});
test('language checks accept German and French only for matching publisher policies and exclude explicit Chinese versions', async () => {
  const french =
    'Ce document présente les exigences relatives à la mesure des pièces et à leur fabrication. Les caractéristiques sont définies dans le système de référence choisi. Chaque mesure doit être effectuée avec un instrument approprié et les résultats doivent être enregistrés dans un rapport. La méthode utilisée pour déterminer une caractéristique doit être indiquée dans les instructions. Les exemples suivants décrivent les principes de cette procédure et les conditions nécessaires pour obtenir des résultats fiables. Il convient de vérifier les équipements avant de commencer les opérations.';
  assert.equal((await analyseTextPages([french], 'eng+fra')).status, 'passed');
  assert.equal((await analyseTextPages([french], 'eng')).status, 'failed');
  assert.equal(explicitForeign('中文版ISO 1101-2017', 'ISO 1101'), true);
  assert.equal(explicitForeign('DIN EN ISO 129-1 German version', 'DIN 129-1'), false);
});

test('pagination uses raw source rows and canonical identity even when spacing varies or matching rows appear late', async () => {
  const calls = [];
  const rows = await searchAllDocuments(
    'ISO 17450-4:2017',
    new AbortController().signal,
    () => {},
    {
      fetcher: async (value) => {
        const url = new URL(value),
          q = url.searchParams.get('q'),
          page = Number(url.searchParams.get('p'));
        calls.push([q, page]);
        let html = '<div id="pageResult">';
        const count = page <= 2 ? 20 : page === 3 ? 1 : 0;
        for (let i = 0; i < count; i++) {
          const title = page === 3 ? '（正版）ISO17450-4-2017.' : 'ISO 1101:2017';
          html += `<div class="sd-list-con"><a class="sd-title" title="${title}" href="https://www.doc88.com/p-${page * 100 + i}.html">${title}</a>页数：22 格式：PDF</div>`;
        }
        return new Response(html + '</div>');
      },
    },
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pageCount, 22);
  assert.ok(calls.some(([q]) => q === 'ISO17450-4'));
  assert.ok(calls.some(([q]) => q === 'ISO 17450 4'));
  assert.ok(calls.some(([, p]) => p === 3));
});
