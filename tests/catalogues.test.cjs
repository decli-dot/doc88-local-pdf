const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeQuery } = require('../dist/query.js');
const designation = require('../dist/standard-reference.js');
const { titleMatches, identityCheck, runSearchJob } = require('../search.cjs');
const { seriesEditions, officialPDFName } = require('../iso-catalog.cjs');
const { parseDIN, parseASME, resolvePublisher } = require('../publisher-catalog.cjs');
const dinURL = 'https://www.dinmedia.de/en/standard/din-5008/12345';
const asmeURL =
  'https://www.asme.org/codes-standards/find-codes-standards/y14-5-dimensioning-tolerancing';
const din = (reference = 'DIN 5008:2020-03', status = 'CURRENT') =>
  `<h1>${reference}</h1><h2 class="bwr-section-hero__subtitle">Official English title</h2>[${status}]<dl><dt>Pages</dt><dd>126</dd></dl>`;
const asme = `var product_VWJS = {"products":[{"Subtitle":"Y14.5 - 2018 (R2024)","TitleOverride":"Dimensioning and Tolerancing","Pages":"347","Format":"PDF","ProductURL":"${asmeURL}"},{"Subtitle":"Y14.5 - 2009","TitleOverride":"Earlier title","Pages":"224","Format":"PDF","ProductURL":"${asmeURL}"},],"currentEdition":''};`;
test('publisher designations preserve DIN month, national prefixes and ASME edition/reaffirmation years', () => {
  assert.equal(normalizeQuery('din 5008 2020-03'), 'DIN 5008:2020-03');
  assert.equal(normalizeQuery('asme y14.5 2018'), 'ASME Y14.5-2018');
  assert.equal(designation.parse('ASME Y14.5-2018 (R2024)').year, '2018');
  assert.equal(designation.parse('ASME Y14.5-2018 (R2024)').reaffirmed, '2024');
  assert.equal(titleMatches('DIN EN ISO 1101:2017-09', 'DIN EN ISO 1101:2017-09'), true);
  assert.equal(titleMatches('ISO 1101:2017', 'DIN EN ISO 1101:2017-09'), false);
  assert.equal(titleMatches('DIN 5008:2020-03', 'DIN 5008:2011-04'), true);
  assert.equal(titleMatches('ASME Y14.5-2018 (R2024)', 'ASME Y14.5-2018 PDF'), true);
  assert.equal(titleMatches('ASME Y14.5-2018', 'ASME Y14.5-20180'), true);
  assert.equal(identityCheck('ASME Y14.5-2018 (R2024)', ['ASME Y14.5-2018']).status, 'failed');
  assert.match(
    officialPDFName({ reference: 'DIN 5008:2020-03', title: 'Official title' }),
    /^DIN 5008 2020-03 Official title\.pdf$/,
  );
});
test('series catalogue filters other numbers, national editions, drafts and supplements and chooses one edition per part', () => {
  const hit = (reference, status = 'Published', id = 123) => ({
    reference,
    status,
    title: 'Official part title',
    url: `https://www.iso.org/standard/${id}.html`,
  });
  const rows = [
    hit('ISO 17450-2:2012'),
    hit('ISO 17450-1:2011'),
    hit('ISO 17450-1:2001', 'Withdrawn'),
    hit('ISO 17450-10:2024'),
    hit('ISO 17451-1:2020'),
    hit('DIN EN ISO 17450-1:2011'),
    hit('ISO/DIS 17450-4'),
    hit('ISO 17450-2:2012/Amd 1:2020'),
  ];
  assert.deepEqual(
    seriesEditions(rows, { organization: 'ISO', number: '17450' }).map((item) => item.reference),
    ['ISO 17450-1:2011', 'ISO 17450-2:2012', 'ISO 17450-10:2024'],
  );
});
test('DIN and ASME parsers read official titles and page counts and do not confuse reaffirmation with edition year', async () => {
  assert.equal(parseDIN(din(), dinURL).pageCount, 126);
  assert.equal(parseDIN(din('DIN 5008:2011-04', 'WITHDRAWN'), dinURL).status, 'Withdrawn');
  const editions = parseASME(asme, asmeURL);
  assert.equal(editions[0].reference, 'ASME Y14.5-2018 (R2024)');
  assert.equal(editions[0].pageCount, 347);
  assert.equal(editions[1].status, 'Historical');
  let seenSearch = false;
  let seenHistorical = false;
  const request = async (url) => {
    if (url === 'https://www.dinmedia.de/en')
      return {
        bytes: Buffer.from(
          '<div data-index-name="products"></div><div data-app-id="DEMO" data-api-key="abcdef" data-suggestion-index="suggestions"></div>',
        ),
      };
    if (url.includes('algolia.net')) {
      seenSearch = true;
      return {
        bytes: Buffer.from(
          JSON.stringify({ hits: [{ titel_DOK: 'DIN 5008:2020-03', objectID: '12345' }] }),
        ),
      };
    }
    if (url.endsWith('/54321')) {
      seenHistorical = true;
      return { bytes: Buffer.from(din('DIN 5008:2011-04', 'WITHDRAWN')) };
    }
    return {
      bytes: Buffer.from(
        din() + '<a href="https://www.dinmedia.de/en/standard/din-5008/54321">DIN 5008:2011-04</a>',
      ),
    };
  };
  const result = await resolvePublisher(designation.parse('DIN 5008'), { request });
  assert.equal(result.reference, 'DIN 5008:2020-03');
  assert.equal(seenSearch, true);
  assert.equal(seenHistorical, false);
  await assert.rejects(
    resolvePublisher(designation.parse('DIN 5008'), { request, chooseEdition: true }),
    (error) => {
      assert.equal(error.code, 'PUBLISHER_EDITION_CHOICE');
      assert.deepEqual(
        error.editions.map((e) => e.reference),
        ['DIN 5008:2020-03', 'DIN 5008:2011-04'],
      );
      return true;
    },
  );
  assert.equal(seenHistorical, true);
  await assert.rejects(
    resolvePublisher(designation.parse('DIN 5008:2015'), { request }),
    (error) =>
      error.code === 'PUBLISHER_EDITION_CHOICE' &&
      error.editions[0].reference === 'DIN 5008:2020-03',
  );
});
test('yearless series selection stops before document search and publisher choice stops before downloads', async () => {
  const job = {
    query: 'ISO 17450',
    controller: new AbortController(),
    update(value) {
      Object.assign(this, value);
    },
    log() {},
  };
  await runSearchJob(job, 'unused', {
    resolveISO: async (wanted, options) => {
      assert.equal(options.detectSeries, true);
      return {
        series: true,
        reference: 'ISO 17450',
        items: [{ reference: 'ISO 17450-1:2011', title: 'Part one', status: 'Published' }],
      };
    },
    search: () => assert.fail('Must wait for selection'),
  });
  assert.equal(job.stage, 'selecting');
  assert.equal(job.seriesOptions.length, 1);
  const other = { ...job, query: 'DIN 5008:2015', stage: 'queued', seriesOptions: undefined };
  await runSearchJob(other, 'unused', {
    lookupPublisher: async () => {
      throw Object.assign(Error('Choose'), {
        code: 'PUBLISHER_EDITION_CHOICE',
        editions: [{ reference: 'DIN 5008:2020-03' }],
      });
    },
    search: () => assert.fail('Must wait for edition'),
  });
  assert.equal(other.stage, 'choosing');
  assert.equal(other.choicePublisher, 'DIN');
});

test('withdrawn DIN editions survive catalogue pagination and more than ten cards without mixing drafts or adoptions', async () => {
  const years = [1987, ...Array.from({ length: 11 }, (_, index) => 1950 + index)];
  const calls = [],
    cards = [];
  const request = async (url, options) => {
    if (url === 'https://www.dinmedia.de/en')
      return {
        bytes: Buffer.from(
          '<i data-index-name="products" data-app-id="DEMO" data-api-key="abcdef" data-suggestion-index="suggestions"></i>',
        ),
      };
    if (url.includes('algolia.net')) {
      const input = JSON.parse(options.body);
      calls.push(input);
      assert.deepEqual(input.restrictSearchableAttributes, ['titel']);
      assert.equal(input.typoTolerance, false);
      assert.equal(input.queryType, 'prefixNone');
      assert.equal(input.removeWordsIfNoResults, 'none');
      assert.equal(input.query, '"DIN 127"');
      const hits =
        input.page === 0
          ? Array.from({ length: 100 }, (_, index) => ({
              titel_DOK: 'DIN ' + (12700 + index) + ':2025-01',
              objectID: String(1000 + index),
              'dokument-typ': 'N',
            }))
          : [
              ...years.map((year, index) => ({
                titel_DOK: `DIN 127:${year}-10`,
                objectID: String(2000 + index),
                'dokument-typ': 'N',
              })),
              { titel_DOK: 'DIN 127:1985-03', objectID: '9001', 'dokument-typ': 'N-E' },
              { titel_DOK: 'DIN 127:1937-03', objectID: '9002', 'dokument-typ': 'TR' },
              { titel_DOK: 'DIN ISO 127:2020-11', objectID: '9003', 'dokument-typ': 'N' },
            ];
      return { bytes: Buffer.from(JSON.stringify({ hits, nbPages: 2 })) };
    }
    const id = Number(new URL(url).pathname.split('/').pop());
    cards.push(id);
    assert.ok(id >= 2000 && id < 2012, 'Do not read unrelated, draft or adoption cards');
    return { bytes: Buffer.from(din(`DIN 127:${years[id - 2000]}-10`, 'WITHDRAWN')) };
  };
  await assert.rejects(
    resolvePublisher(designation.parse('DIN 127'), { request, chooseEdition: true }),
    (error) => {
      assert.equal(error.code, 'PUBLISHER_EDITION_CHOICE');
      assert.equal(error.editions.length, 12);
      assert.equal(error.editions[0].reference, 'DIN 127:1987-10');
      assert.ok(error.editions.every((e) => e.status === 'Withdrawn'));
      return true;
    },
  );
  assert.deepEqual(
    calls.map((call) => call.page),
    [0, 1],
  );
  assert.equal(cards.length, 12);
});

test('short DIN designation falls back to national adoptions only when the exact designation is absent', async () => {
  const queries = [];
  const request = async (url, options) => {
    if (url === 'https://www.dinmedia.de/en')
      return {
        bytes: Buffer.from(
          '<i data-index-name="products" data-app-id="DEMO" data-api-key="abcdef" data-suggestion-index="suggestions"></i>',
        ),
      };
    if (url.includes('algolia.net')) {
      const { query } = JSON.parse(options.body);
      queries.push(query);
      return {
        bytes: Buffer.from(
          JSON.stringify({
            nbPages: 1,
            hits: query.startsWith('"')
              ? []
              : [
                  { titel_DOK: 'DIN EN ISO 129-1:2022-02', objectID: '3001', 'dokument-typ': 'N' },
                  { titel_DOK: 'DIN EN ISO 129-1:2020-02', objectID: '3002', 'dokument-typ': 'N' },
                ],
          }),
        ),
      };
    }
    return {
      bytes: Buffer.from(
        url.endsWith('/3001')
          ? din('DIN EN ISO 129-1:2022-02')
          : din('DIN EN ISO 129-1:2020-02', 'WITHDRAWN'),
      ),
    };
  };
  await assert.rejects(
    resolvePublisher(designation.parse('DIN 129-1'), { request, chooseEdition: true }),
    (error) => {
      assert.equal(error.code, 'PUBLISHER_EDITION_CHOICE');
      assert.deepEqual(
        error.editions.map((e) => e.reference),
        ['DIN EN ISO 129-1:2022-02', 'DIN EN ISO 129-1:2020-02'],
      );
      return true;
    },
  );
  assert.deepEqual(queries, ['"DIN 129-1"', 'DIN 129-1']);
});

test('real national-series discovery keeps exact parts and each part language metadata', async () => {
  const queries = [];
  const records = [
    { reference: 'DIN EN ISO 17450-1:2012-04', languages: ['eng', 'deu'], status: 'Published' },
    { reference: 'DIN EN ISO 17450-2:2013-04', languages: ['deu'], status: 'Published' },
  ];
  const request = async (url, options) => {
    if (url === 'https://www.dinmedia.de/en')
      return {
        bytes: Buffer.from(
          '<i data-index-name="products" data-app-id="DEMO" data-api-key="abcdef" data-suggestion-index="suggestions"></i>',
        ),
      };
    if (url.includes('algolia.net')) {
      const input = JSON.parse(options.body);
      queries.push(input.query);
      return {
        bytes: Buffer.from(
          JSON.stringify({
            nbPages: 1,
            hits: input.query.startsWith('"')
              ? []
              : [
                  ...records.map((r, i) => ({
                    titel_DOK: r.reference,
                    objectID: String(4000 + i),
                    'dokument-typ': 'N',
                    'ist-zurueckgezogen': 0,
                  })),
                  {
                    titel_DOK: 'DIN EN ISO 17450-1:2001-01',
                    objectID: '4002',
                    'dokument-typ': 'N',
                    'ist-zurueckgezogen': 1,
                  },
                  {
                    titel_DOK: 'DIN EN ISO 17451-1:2025-01',
                    objectID: '4003',
                    'dokument-typ': 'N',
                  },
                  {
                    titel_DOK: 'DIN EN ISO 17450-3:2027-01',
                    objectID: '4004',
                    'dokument-typ': 'N-E',
                  },
                ],
          }),
        ),
      };
    }
    const index = Number(url.split('/').pop()) - 4000;
    assert.ok(index === 0 || index === 1, 'Read only the latest real part');
    return {
      bytes: Buffer.from(
        din(records[index].reference) +
          ' Language: German' +
          (index === 0 ? ' translation: English' : ''),
      ),
    };
  };
  const series = await resolvePublisher(designation.parse('DIN 17450'), {
    request,
    chooseEdition: true,
  });
  assert.equal(series.series, true);
  assert.equal(series.reference, 'DIN 17450');
  assert.deepEqual(
    series.items.map((e) => e.reference),
    records.map((e) => e.reference),
  );
  assert.deepEqual(
    series.items.map((e) => new Set(e.languages)),
    records.map((e) => new Set(e.languages)),
  );
  assert.deepEqual(queries, ['"DIN 17450"', 'DIN 17450']);
  assert.equal(
    designation.family(designation.parse('DIN 17450'), designation.parse(records[0].reference)),
    false,
    'Source matching remains exact',
  );
  assert.equal(
    designation.catalogueFamily(
      designation.parse('DIN 17450:2012'),
      designation.parse(records[0].reference),
    ),
    false,
  );
});

test('an explicitly dated withdrawn DIN edition does not wait for unrelated history before a cache lookup', async () => {
  const cards = [];
  const request = async (url) => {
    if (url === 'https://www.dinmedia.de/en')
      return {
        bytes: Buffer.from(
          '<i data-index-name="products" data-app-id="DEMO" data-api-key="abcdef" data-suggestion-index="suggestions"></i>',
        ),
      };
    if (url.includes('algolia.net'))
      return {
        bytes: Buffer.from(
          JSON.stringify({
            nbPages: 1,
            hits: [
              { titel_DOK: 'DIN 127:1920-12', objectID: '5000', 'dokument-typ': 'N' },
              { titel_DOK: 'DIN 127:1987-10', objectID: '5001', 'dokument-typ': 'N' },
              { titel_DOK: 'DIN 127:1970-12', objectID: '5002', 'dokument-typ': 'N' },
            ],
          }),
        ),
      };
    cards.push(url);
    assert.ok(url.endsWith('/5001'), 'No request for older catalogue cards');
    return {
      bytes: Buffer.from(
        din('DIN 127:1987-10', 'WITHDRAWN') +
          '<a href="https://www.dinmedia.de/en/standard/din-127/5002">DIN 127:1970-12</a>',
      ),
    };
  };
  const result = await resolvePublisher(designation.parse('DIN 127:1987-10'), {
    request,
    chooseEdition: true,
  });
  assert.equal(result.reference, 'DIN 127:1987-10');
  assert.equal(result.status, 'Withdrawn');
  assert.equal(cards.length, 1);
});
