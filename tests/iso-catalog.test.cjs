const test = require('node:test');
const assert = require('node:assert/strict');
const {
  reference,
  chooseCurrentISO,
  resolveLatestISO,
  resolveISOStandard,
  officialPDFName,
  officialFullTitle,
  normalizeOfficialTitle,
  cataloguePageCount,
  ISOEditionNotFoundError,
  collectISOHistory,
  catalogueSupplements,
  sameReference,
} = require('../iso-catalog.cjs');
const active = (
  reference,
  status = 'Published',
  url = 'https://www.iso.org/standard/65559.html',
) => ({ reference, status, url, title: 'Fixture standard title' });

test('official edition comes from the exact published standard, not review dates or newer drafts', () => {
  const hits = [
    active('ISO 5458:2018'),
    active('ISO 5458:2027', 'Under development'),
    active('ISO 5458:2026', 'Withdrawn'),
    active('ISO 54580:2025'),
    active('ISO 5458-1:2025'),
    active('ISO 5458:2018/Amd 1:2023'),
    active('ISO/DIS 5458:2027'),
    active('ISO 5458:2025', 'Deleted'),
    active('ISO 5458:2025', 'Published', 'https://evil.test/standard/1.html'),
  ];
  const found = chooseCurrentISO(hits, reference('ISO 5458'));
  assert.equal(found.reference, 'ISO 5458:2018');
  assert.equal(found.year, 2018);
  assert.equal(found.sourceURL, 'https://www.iso.org/standard/65559.html');
  assert.equal(
    chooseCurrentISO([active('ISO 5458:1998', 'Withdrawn')], reference('ISO 5458')),
    null,
  );
  assert.equal(
    chooseCurrentISO(
      [active('ISO 14405-2:2025'), active('ISO 14405-1:2025')],
      reference('ISO 14405-1'),
    ).reference,
    'ISO 14405-1:2025',
  );
});
test('catalogue lookup closes its own browser and returns a dated official source', async () => {
  let closed = 0;
  let queried = '';
  const commands = [];
  const page = {
    goto: async (url) => {
      queried = url;
    },
    waitForFunction: async () => {},
    evaluate: async () =>
      queried.includes('/search.html')
        ? [active('ISO 5458:2018')]
        : {
            heading: 'ISO 5458:2018',
            title: 'ISO 5458:2018 - Fixture standard title',
            text: 'General information\nNumber of pages\n : 44\nTechnical Committee',
          },
  };
  const context = {
    pages: () => [page],
    close: async () => closed++,
    newCDPSession: async () => ({
      send: async (method, params) => {
        commands.push([method, params]);
        return { windowId: 1 };
      },
    }),
  };
  const result = await resolveLatestISO(reference('ISO 5458'), {
    signal: new AbortController().signal,
    dataDirectory: '.data/test',
    launchContext: async () => context,
  });
  assert.equal(new URL(queried).hostname, 'www.iso.org');
  assert.equal(queried, 'https://www.iso.org/standard/65559.html');
  assert.equal(result.reference, 'ISO 5458:2018');
  assert.equal(result.pageCount, 44);
  assert.ok(Number.isFinite(Date.parse(result.checkedAt)));
  assert.equal(closed, 1);
  assert.equal(commands[1][1].bounds.windowState, 'minimized');
});
test('unavailable or cancelled ISO lookup cannot manufacture a current edition', async () => {
  let closed = 0;
  const context = {
    pages: () => [
      {
        goto: async () => {
          throw Error('unavailable');
        },
      },
    ],
    close: async () => closed++,
  };
  await assert.rejects(
    resolveLatestISO(reference('ISO 5458'), {
      signal: new AbortController().signal,
      dataDirectory: '.data/test',
      launchContext: async () => context,
    }),
    /Не удалось получить/,
  );
  assert.equal(closed, 1);
  const control = new AbortController();
  control.abort();
  await assert.rejects(
    resolveLatestISO(reference('ISO 5458'), {
      signal: control.signal,
      dataDirectory: '.data/test',
      launchContext: async () => {
        throw Error('Must not launch');
      },
    }),
    { name: 'AbortError' },
  );
});

test('full official filenames preserve long titles while remaining valid Windows filenames', () => {
  const title =
    'Geometrical product specifications (GPS) — General concepts — Part 3: Toleranced features';
  const edition = { reference: 'ISO 17450-3:2016', title };
  assert.equal(
    normalizeOfficialTitle(
      'Geometrical product specifications (GPS) — General concepts\nPart 3: Toleranced features',
    ),
    title,
  );
  assert.equal(officialFullTitle(edition), 'ISO 17450-3:2016 — ' + title);
  const name = officialPDFName(edition);
  assert.equal(
    name,
    'ISO 17450-3 2016 Geometrical product specifications (GPS) — General concepts — Part 3 - Toleranced features.pdf',
  );
  assert.ok(name.length > 100);
  assert.doesNotMatch(name, /[<>:"/\\|?*\u0000-\u001f]|_OCR/);
  assert.ok(
    Buffer.byteLength(
      officialPDFName({ ...edition, title: 'Long title — '.repeat(100) }),
      'utf8',
    ) <= 244,
  );
});
test('explicit-year metadata keeps an older official edition instead of replacing it with the current one', async () => {
  let url;
  const page = {
    goto: async (value) => {
      url = value;
    },
    waitForFunction: async () => {},
    evaluate: async () =>
      url.includes('/search.html')
        ? [active('ISO 5458:2018'), active('ISO 5458:1998', 'Withdrawn')]
        : {
            heading: 'ISO 5458:1998',
            title: 'Fixture standard title',
            text: 'Number of pages : 12',
          },
  };
  const edition = await resolveISOStandard(reference('ISO 5458:1998'), {
    dataDirectory: '.data/test',
    launchContext: async () => ({ pages: () => [page], close: async () => {} }),
  });
  assert.equal(edition.reference, 'ISO 5458:1998');
  assert.equal(edition.status, 'Withdrawn');
  assert.equal(edition.title, 'Fixture standard title');
  assert.equal(edition.pageCount, 12);
});

test('catalogue page counts do not confuse edition, review dates or other numbers', () => {
  assert.equal(cataloguePageCount('Edition : 3\nNumber of pages\n : 45\nICS : 01.100.20'), 45);
  for (const text of [
    '',
    'Confirmed in 2022\nEdition : 3',
    'Number of pages : unknown',
    'Number of pages : 0',
    'Number of pages : 20000',
  ])
    assert.equal(cataloguePageCount(text), null);
});

test('missing years return official lifecycle choices, including older designations but not amendments or drafts', async () => {
  const current = active('ISO 129-1:2018', 'Published', 'https://www.iso.org/standard/64007.html');
  const old = active('ISO 129-1:2004', 'Withdrawn', 'https://www.iso.org/standard/29015.html');
  const predecessor = active('ISO 129:1985', 'Withdrawn', 'https://www.iso.org/standard/5267.html');
  const root = active('ISO 2595:1973', 'Withdrawn', 'https://www.iso.org/standard/7555.html');
  const records = new Map([
    [
      current.url,
      {
        ...current,
        previous: [
          old,
          active('ISO 129-1:2018/Amd 1:2020'),
          active('ISO/AWI 129-1', 'Under development'),
        ],
        next: [],
      },
    ],
    [old.url, { ...old, previous: [predecessor], next: [current, active('ISO 14405-2:2018')] }],
    [predecessor.url, { ...predecessor, previous: [root], next: [old] }],
    [root.url, { ...root, previous: [], next: [predecessor] }],
  ]);
  let url,
    closed = 0;
  const page = {
    goto: async (value) => {
      url = value;
    },
    waitForFunction: async () => {},
    evaluate: async () => {
      if (url.includes('/search.html')) return [current];
      const record = records.get(url);
      assert.ok(record, url);
      return {
        heading: record.reference,
        title: record.reference + ' - Official full title',
        text: 'Number of pages : 33',
        ...record,
      };
    },
  };
  const options = {
    dataDirectory: '.data/test',
    launchContext: async () => ({ pages: () => [page], close: async () => closed++ }),
  };
  await assert.rejects(resolveISOStandard(reference('ISO 129-1:2015'), options), (error) => {
    assert.ok(error instanceof ISOEditionNotFoundError);
    assert.equal(error.code, 'ISO_EDITION_NOT_FOUND');
    assert.deepEqual(
      error.editions.map((e) => e.reference),
      ['ISO 129-1:2018', 'ISO 129-1:2004', 'ISO 129:1985', 'ISO 2595:1973'],
    );
    assert.equal(error.editions[2].relation, 'predecessor');
    assert.equal(error.editions[0].pageCount, 33);
    assert.equal(error.incomplete, false);
    return true;
  });
  assert.equal(closed, 1);
  const exact = await resolveISOStandard(reference('ISO 129-1:2004'), options);
  assert.equal(exact.reference, 'ISO 129-1:2004');
  assert.equal(exact.status, 'Withdrawn');
});

test('partial or cancelled lifecycle reads cannot claim that an edition does not exist', async () => {
  const first = {
    reference: 'ISO 5458:2018',
    status: 'Published',
    sourceURL: 'https://www.iso.org/standard/65559.html',
  };
  const older = active('ISO 5458:1998', 'Withdrawn', 'https://www.iso.org/standard/11505.html');
  const history = await collectISOHistory([first], reference('ISO 5458:2015'), async (edition) => {
    if (edition.sourceURL === older.url) throw Error('Network failure');
    return { ...first, previous: [older] };
  });
  assert.equal(history.editions.length, 1);
  assert.equal(history.incomplete, true);
  const error = new ISOEditionNotFoundError(
    reference('ISO 5458:2015'),
    history.editions,
    history.incomplete,
  );
  assert.match(error.message, /Не удалось подтвердить/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    collectISOHistory([first], reference('ISO 5458:2015'), async () => first, controller.signal),
    { name: 'AbortError' },
  );
});

test('amendments are separate ISO references and only attach to their exact base edition', () => {
  const main = reference('ISO 129-1:2018'),
    amendment = reference('ISO 129-1 2018 AMD 1 2020');
  assert.deepEqual(amendment.supplement, { type: 'Amd', number: '1', year: '2020' });
  assert.equal(sameReference(main, amendment), false);
  const links = [
    {
      reference: 'ISO 129-1:2018/Amd 1:2020',
      url: 'https://www.iso.org/standard/75971.html',
      status: 'Published',
    },
    {
      reference: 'ISO 129-1:2004/Cor 1:2008',
      url: 'https://www.iso.org/standard/1.html',
      status: 'Published',
    },
    {
      reference: 'ISO 129-1:2018/Amd 2:2024',
      url: 'https://evil.test/standard/2.html',
      status: 'Published',
    },
  ];
  const supplements = catalogueSupplements(links, { reference: 'ISO 129-1:2018' });
  assert.equal(supplements.length, 1);
  assert.equal(supplements[0].reference, 'ISO 129-1:2018/Amd 1:2020');
  assert.match(
    officialPDFName({ ...supplements[0], title: 'Amendment title' }),
    /^ISO 129-1 2018 Amd 1 2020 Amendment title.pdf$/,
  );
});

test('amendment lookup uses its own official title and page count rather than the base standard', async () => {
  let url;
  const page = {
    goto: async (value) => {
      url = value;
    },
    waitForFunction: async () => {},
    evaluate: async () => {
      if (url.includes('/search.html'))
        return [active('ISO 129-1:2018', 'Published', 'https://www.iso.org/standard/64007.html')];
      if (url.includes('64007'))
        return {
          heading: 'ISO 129-1:2018',
          title: 'ISO 129-1:2018 - Main title',
          text: 'Number of pages : 68',
          supplements: [
            {
              reference: 'ISO 129-1:2018/Amd 1:2020',
              url: 'https://www.iso.org/standard/75971.html',
              status: 'Published',
            },
          ],
        };
      return {
        heading: 'ISO 129-1:2018/Amd 1:2020',
        title: 'ISO 129-1:2018/Amd 1:2020 - Main title — Amendment 1',
        text: 'Number of pages : 1',
        status: 'Published',
      };
    },
  };
  const result = await resolveISOStandard(reference('ISO 129-1:2018/Amd 1:2020'), {
    dataDirectory: '.data/test',
    launchContext: async () => ({ pages: () => [page], close: async () => {} }),
  });
  assert.equal(result.reference, 'ISO 129-1:2018/Amd 1:2020');
  assert.equal(result.pageCount, 1);
  assert.equal(result.title, 'Main title — Amendment 1');
});
