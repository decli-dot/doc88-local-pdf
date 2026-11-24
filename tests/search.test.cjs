const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { ISOEditionNotFoundError, reference } = require('../iso-catalog.cjs');
const {
  validateQuery,
  titleMatches,
  exactTitleMatches,
  parseResults,
  searchDocumentPages,
  searchAllDocuments,
  analyseTextPages,
  identityCheck,
  isoExtentCheck,
  runSearchJob,
} = require('../search.cjs');
const english =
  'This document defines the requirements for the measurement of manufactured parts. The method shall be used with the specified reference system. Each feature is measured independently and the results are recorded in the report. A surface can be evaluated by more than one method, and the selected method shall be stated. The following examples show how a measurement can be performed and how the uncertainty of the result is determined. This procedure is intended for use in industrial inspection and does not replace the requirements of the drawing. The operator should check that the equipment is suitable for the required measurement.';
const french =
  'Ce document présente les exigences relatives à la mesure des pièces et à leur fabrication. Les caractéristiques sont définies dans le système de référence choisi. Chaque mesure doit être effectuée avec un instrument approprié et les résultats doivent être enregistrés dans un rapport. La méthode utilisée pour déterminer une caractéristique doit être indiquée dans les instructions. Les exemples suivants décrivent les principes de cette procédure et les conditions nécessaires pour obtenir des résultats fiables. Il convient de vérifier les équipements avant de commencer les opérations. Cette procédure ne remplace pas les exigences définies sur le dessin technique.';

test('ISO input formatting preserves the specified year and part before catalogue checks', () => {
  for (const value of [
    'iso 5458 2013',
    'iso 5458-2013',
    'iso5458:2013',
    ' ISO  5458 — 2013 ',
    'ｉｓｏ ５４５８：２０１３',
  ])
    assert.equal(validateQuery(value), 'ISO 5458:2013');
  for (const value of ['iso 129-1 2015', 'iso129-1-2015', 'ISO 129 – 1 : 2015'])
    assert.equal(validateQuery(value), 'ISO 129-1:2015');
  assert.equal(validateQuery('iso / iec 27001-2022'), 'ISO/IEC 27001:2022');
  assert.equal(validateQuery('iso5458'), 'ISO 5458');
  assert.equal(validateQuery('BS EN ISO 5458-2013'), 'BS EN ISO 5458:2013');
  for (const value of [
    'ISO 5458:2018/Amd 1:2020',
    'ISO 5458 20130',
    'An English handbook',
    'ISO 5458 geometry',
  ])
    assert.equal(validateQuery(value), value);
});

test('search keeps the ISO part and publisher, leaves year checks to OCR, removes drafts and unsafe links', () => {
  assert.equal(validateQuery(' ISO  14405-1:2025 '), 'ISO 14405-1:2025');
  for (const input of [null, {}, 'ab', 'x'.repeat(181)]) assert.throws(() => validateQuery(input));
  for (const title of [
    'ISO14405-1-2025',
    'ISO 14405-1 2025',
    '（高清）ISO 14405-1:2025',
    'ISO 14405-1:2016',
    'ISO 14405-1',
    'ISO 14405-1:20250',
  ])
    assert.ok(titleMatches('ISO 14405-1:2025', title));
  for (const title of [
    'ISO 14405-2:2025',
    'ISO/DIS 14405-1:2025',
    'ISO/IEC 14405-1:2025',
    'EN ISO 14405-1:2025',
    'BS EN ISO 14405-1:2025',
    'DIN EN ISO 14405-1:2025',
    'NF EN ISO 14405-1:2025',
    '可编辑word原版标准_BS ISO 14405-1:2025',
    '标准BS EN ISO 14405-1:2025',
  ])
    assert.equal(Boolean(titleMatches('ISO 14405-1:2025', title)), false);
  const item = (title, url, format) =>
    `<div class="sd-list-con"><h3><a href="${url}" class="sd-title" title="${title}">${title}</a></h3><div>页数：64<b></b>格式：${format}<b></b></div>`;
  const html =
    item('ISO 14405-1 2025', 'https://www.doc88.com/p-1.html', 'DOCX') +
    item('ISO 14405-1:2016', 'https://www.doc88.com/p-2.html', 'PDF') +
    item('ISO 14405-1 2025', 'https://evil.test/p-3.html', 'PDF') +
    item('ISO 14405-1 2025', 'https://www.doc88.com/p-4.html', 'PDF') +
    item('EN ISO 14405-1 2025', 'https://www.doc88.com/p-5.html', 'PDF') +
    item('BS EN ISO 14405-1 2025', 'https://www.doc88.com/p-6.html', 'PDF') +
    item('DIN EN ISO 14405-1 2025', 'https://www.doc88.com/p-7.html', 'PDF') +
    item('ISO 14405-1 2025', 'https://www.doc88.com/p-4.html', 'PDF');
  const results = parseResults(html, 'ISO 14405-1:2025');
  assert.deepEqual(
    results.map((item) => item.url),
    [
      'https://www.doc88.com/p-2.html',
      'https://www.doc88.com/p-4.html',
      'https://www.doc88.com/p-1.html',
    ],
  );
  assert.equal(results[0].pageCount, 64);
  assert.equal(results[0].checks, null);
});

test('language checks actual prose, rejects French and ignores repeated English footers', async () => {
  assert.equal((await analyseTextPages([english, english])).status, 'passed');
  assert.equal((await analyseTextPages([french, french])).status, 'failed');
  assert.notEqual(
    (await analyseTextPages(['ISO 14405-1:2025 English 123456789'])).status,
    'passed',
  );
  assert.notEqual(
    (await analyseTextPages([1, 2, 3, 4].map((n) => `qxvz kjzxk vzzxq qxxzw ${n}\n${english}`)))
      .status,
    'passed',
  );
  const footer = english.split('. ').join('\n');
  assert.notEqual(
    (await analyseTextPages([1, 2, 3, 4].map((n) => french + `\n${n}\n` + footer))).status,
    'passed',
  );
  assert.equal(identityCheck('ISO 14405-1:2025', ['ISO 14405-1:2016', english]).status, 'failed');
  assert.equal(
    identityCheck('ISO 14405-1:2025', ['ISO 14405-1:2025(E)', english]).status,
    'passed',
  );
});

test('explicit machine-translation notices cannot turn translated prose into an official language match', async () => {
  for (const notice of [
    'Machine Translated by Google',
    'Machine translated by DeepL',
    'Translated by Google Translate',
  ]) {
    const result = await analyseTextPages([notice + '\n' + english, notice + '\n' + english]);
    assert.equal(result.status, 'failed');
    assert.equal(result.machineTranslation, true);
    assert.match(result.message, /автоматический перевод/);
  }
  const plain = await analyseTextPages([
    english + '\nThis clause describes a machine translated by Google in an example.',
  ]);
  assert.equal(plain.status, 'passed');
  assert.equal(plain.machineTranslation, false);
});

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'doc88-search-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('doc88-search-test-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    query: 'ISO 14405-1:2025',
    isoEdition: {
      reference: 'ISO 14405-1:2025',
      title: 'Fixture standard title',
      pageCount: 2,
      status: 'Published',
      sourceURL: 'https://www.iso.org/standard/86001.html',
      checkedAt: new Date().toISOString(),
    },
    controller: new AbortController(),
    update(value) {
      Object.assign(this, value);
    },
    log() {},
  };
}
function candidate(url, pageCount = 2) {
  return {
    url,
    title: 'ISO 14405-1 2025',
    format: 'PDF',
    pageCount,
    status: 'unverified',
    checks: null,
  };
}
async function convertFixture(job, text = english) {
  const directory = path.join(job.directory, 'ocr');
  await fs.mkdir(directory, { recursive: true });
  for (let i = 1; i <= 2; i++)
    await fs.writeFile(
      path.join(directory, `page${String(i).padStart(5, '0')}.txt`),
      'ISO 14405-1:2025(E)\n' + text,
    );
  await fs.writeFile(path.join(job.directory, 'result.pdf'), '%PDF-synthetic');
  job.update({
    stage: 'done',
    total: 2,
    pdfReady: true,
    pdfFilename: job.officialFilename || 'test.pdf',
    archiveFilename: 'test.zip',
    bytes: 14,
    textChars: 1200,
    blankPages: 0,
  });
}

test('search skips a non-English upload and exposes files only after both checks pass', async (t) => {
  const job = await fixture(t);
  const candidates = [
    candidate('https://www.doc88.com/p-1.html'),
    candidate('https://www.doc88.com/p-2.html'),
  ];
  await runSearchJob(job, job.directory, {
    candidates,
    download: async (child) => {
      assert.equal(Boolean(job.pdfReady), false);
      await fs.writeFile(path.join(child.directory, 'archive.zip'), 'PK-test');
    },
    convert: (child) => convertFixture(child, child.url.endsWith('p-1.html') ? french : english),
  });
  assert.equal(candidates[0].status, 'rejected');
  assert.equal(candidates[0].checks.language.status, 'failed');
  assert.equal(job.url, candidates[1].url);
  assert.equal(job.stage, 'done');
  assert.equal(job.pdfReady, true);
  assert.equal(job.verification.completeness.pages, 2);
  assert.match(job.pdfFilename, /Fixture standard title\.pdf$/);
  assert.doesNotMatch(job.pdfFilename, /_OCR/);
  assert.equal(await fs.readFile(path.join(job.directory, 'result.pdf'), 'utf8'), '%PDF-synthetic');
});

test('missing declared pages and cancellation cannot produce a verified result', async (t) => {
  const job = await fixture(t);
  await assert.rejects(
    runSearchJob(job, job.directory, {
      candidates: [candidate('https://www.doc88.com/p-1.html', 3)],
      download: async (child) => fs.writeFile(path.join(child.directory, 'archive.zip'), 'PK-test'),
      convert: convertFixture,
    }),
  );
  assert.equal(job.searchResults[0].checks.completeness.status, 'failed');
  assert.equal(Boolean(job.pdfReady), false);
  await assert.rejects(fs.access(path.join(job.directory, 'result.pdf')));
  const cancelled = await fixture(t);
  await assert.rejects(
    runSearchJob(cancelled, cancelled.directory, {
      candidates: [candidate('https://www.doc88.com/p-2.html')],
      download: async () => {
        cancelled.controller.abort();
        throw new Error('cancelled');
      },
    }),
    /остановлена/,
  );
  assert.equal(Boolean(cancelled.pdfReady), false);
});

test('yearless ISO lookup narrows Doc88 search and content verification to the official edition', async (t) => {
  const job = await fixture(t);
  job.query = 'ISO 14405-1';
  let searched;
  await runSearchJob(job, job.directory, {
    resolveISO: async (wanted) => {
      assert.equal(wanted.year, null);
      return {
        reference: 'ISO 14405-1:2025',
        title: 'Fixture standard title',
        pageCount: 2,
        sourceURL: 'https://www.iso.org/standard/86001.html',
        status: 'Published',
        checkedAt: new Date().toISOString(),
      };
    },
    search: async (query) => {
      searched = query;
      return [candidate('https://www.doc88.com/p-1.html')];
    },
    download: async (child) => fs.writeFile(path.join(child.directory, 'archive.zip'), 'PK-test'),
    convert: convertFixture,
  });
  assert.equal(searched, 'ISO 14405-1:2025');
  assert.equal(job.query, 'ISO 14405-1');
  assert.equal(job.resolvedQuery, 'ISO 14405-1:2025');
  assert.equal(job.stage, 'done');
  const retry = await fixture(t);
  retry.query = job.query;
  retry.resolvedQuery = job.resolvedQuery;
  await assert.rejects(
    runSearchJob(retry, retry.directory, {
      candidates: [candidate('https://www.doc88.com/p-1.html')],
      resolveISO: async () => {
        throw Error('Must reuse the resolved edition');
      },
      download: async (child) => fs.writeFile(path.join(child.directory, 'archive.zip'), 'PK-test'),
      convert: async (child) => {
        await convertFixture(child);
        for (let n = 1; n <= 2; n++)
          await fs.writeFile(
            path.join(child.directory, 'ocr', `page${String(n).padStart(5, '0')}.txt`),
            'ISO 14405-1:2016(E)\n' + english,
          );
      },
    }),
  );
  assert.equal(retry.searchResults[0].checks.identity.status, 'failed');
  assert.equal(Boolean(retry.pdfReady), false);
});
test('explicit years are preserved when retrieving titles, and ISO failure never picks an arbitrary year', async (t) => {
  for (const query of ['ISO 5458:1998', 'An English handbook']) {
    const job = await fixture(t);
    job.query = query;
    delete job.isoEdition;
    await assert.rejects(
      runSearchJob(job, job.directory, {
        resolveISO: async () => {
          throw Error('Must not resolve an explicit year');
        },
        lookupISO: async (wanted) => {
          assert.equal(wanted.year, '1998');
          return {
            reference: 'ISO 5458:1998',
            title: 'Older fixture title',
            pageCount: 12,
            status: 'Withdrawn',
          };
        },
        search: async (actual) => {
          assert.equal(actual, query);
          return [];
        },
      }),
      { code: 'SEARCH_EXHAUSTED' },
    );
    assert.equal(job.isoEdition?.reference, query.startsWith('ISO') ? 'ISO 5458:1998' : undefined);
  }
  const job = await fixture(t);
  job.query = 'ISO 5458';
  let searched = false;
  await assert.rejects(
    runSearchJob(job, job.directory, {
      resolveISO: async () => {
        throw Error('ISO unavailable');
      },
      search: async () => {
        searched = true;
        return [];
      },
    }),
    /ISO unavailable/,
  );
  assert.equal(searched, false);
  assert.equal(job.resolvedQuery, undefined);
  assert.match(job.isoLookupURL, /iso\.org\/search/);
});

test('an ISO label cannot admit a national edition printed on the cover', () => {
  assert.equal(
    identityCheck('ISO 17450-3:2016', ['BS EN ISO 17450-3:2016\n' + english]).status,
    'failed',
  );
  assert.equal(
    identityCheck('ISO 17450-3:2016', ['INTERNATIONAL STANDARD\nISO 17450-3:2016(E)\n' + english])
      .status,
    'passed',
  );
});

test('legacy candidates without a resolved year are checked against ISO before rechecking', async (t) => {
  const job = await fixture(t);
  job.query = 'ISO 5458';
  let lookedUp = false;
  let downloaded = false;
  await assert.rejects(
    runSearchJob(job, job.directory, {
      candidates: [{ ...candidate('https://www.doc88.com/p-1.html'), title: 'ISO 5458:1998' }],
      resolveISO: async () => {
        lookedUp = true;
        return {
          reference: 'ISO 5458:2018',
          sourceURL: 'https://www.iso.org/standard/65559.html',
          status: 'Published',
          checkedAt: new Date().toISOString(),
        };
      },
      download: async () => {
        downloaded = true;
      },
    }),
    { code: 'SEARCH_EXHAUSTED' },
  );
  assert.equal(lookedUp, true);
  assert.equal(downloaded, false);
  assert.equal(job.resolvedQuery, 'ISO 5458:2018');
});

test('ISO extent rejects a nine-page excerpt but permits extra covers and front matter', () => {
  const edition = { pageCount: 45 };
  const short = isoExtentCheck(9, edition);
  assert.equal(short.status, 'failed');
  assert.equal(short.officialPages, 45);
  assert.match(short.message, /9 стр.*45/);
  assert.equal(isoExtentCheck(54, edition).status, 'passed');
  assert.equal(isoExtentCheck(45, edition).status, 'passed');
  assert.equal(isoExtentCheck(54, {}).status, 'unknown');
  assert.equal(isoExtentCheck(null, edition).status, 'unknown');
});

test('shortened uploads do not consume the three-candidate budget or run OCR', async (t) => {
  const job = await fixture(t);
  const candidates = Array.from({ length: 5 }, (_, i) =>
    candidate(`https://www.doc88.com/p-${i}.html`, i === 4 ? 2 : 1),
  );
  const downloaded = [];
  await runSearchJob(job, job.directory, {
    candidates,
    download: async (child) => {
      downloaded.push(child.url);
      await fs.writeFile(path.join(child.directory, 'archive.zip'), 'PK-test');
    },
    convert: convertFixture,
  });
  assert.deepEqual(downloaded, [candidates[4].url]);
  assert.ok(
    candidates
      .slice(0, 4)
      .every((item) => item.status === 'rejected' && item.checks.extent.status === 'failed'),
  );
  assert.equal(job.verification.extent.status, 'passed');
  assert.equal(job.pdfReady, true);
});

test('actual downloaded page count is checked even when Doc88 omits its count', async (t) => {
  const job = await fixture(t);
  job.isoEdition.pageCount = 45;
  await assert.rejects(
    runSearchJob(job, job.directory, {
      candidates: [candidate('https://www.doc88.com/p-1.html', null)],
      download: async (child) => fs.writeFile(path.join(child.directory, 'archive.zip'), 'PK-test'),
      convert: convertFixture,
    }),
  );
  assert.equal(job.searchResults[0].checks.extent.status, 'failed');
  assert.equal(job.pdfReady, false);
  await assert.rejects(fs.access(path.join(job.directory, 'result.pdf')));
});

test('unavailable catalogue counts cannot result in verified ISO PDFs', async (t) => {
  const job = await fixture(t);
  delete job.isoEdition.pageCount;
  let downloaded = false;
  await assert.rejects(
    runSearchJob(job, job.directory, {
      candidates: [candidate('https://www.doc88.com/p-1.html')],
      lookupISO: async () => {
        throw Error('Catalogue unavailable');
      },
      download: async () => {
        downloaded = true;
      },
    }),
  );
  assert.equal(downloaded, false);
  assert.equal(job.searchResults[0].checks.extent.status, 'unknown');
  assert.equal(Boolean(job.pdfReady), false);
  assert.match(job.namingWarning, /объёма/);
});

test('rechecking historical results refreshes metadata that lacks an ISO page count', async (t) => {
  const job = await fixture(t);
  delete job.isoEdition.pageCount;
  let lookedUp = 0;
  await runSearchJob(job, job.directory, {
    candidates: [candidate('https://www.doc88.com/p-1.html')],
    lookupISO: async (wanted) => {
      lookedUp++;
      assert.equal(wanted.year, '2025');
      return { ...job.isoEdition, pageCount: 2 };
    },
    download: async (child) => fs.writeFile(path.join(child.directory, 'archive.zip'), 'PK-test'),
    convert: convertFixture,
  });
  assert.equal(lookedUp, 1);
  assert.equal(job.verification.extent.officialPages, 2);
  assert.equal(job.stage, 'done');
});

test('a nonexistent explicit year waits for a choice before contacting Doc88', async (t) => {
  const job = await fixture(t);
  job.query = 'ISO 129-1:2015';
  delete job.isoEdition;
  let searched = false;
  const editions = [
    {
      reference: 'ISO 129-1:2018',
      title: 'Official title',
      pageCount: 68,
      status: 'Published',
      sourceURL: 'https://www.iso.org/standard/64007.html',
    },
  ];
  await runSearchJob(job, job.directory, {
    lookupISO: async () => {
      throw new ISOEditionNotFoundError(reference(job.query), editions);
    },
    search: async () => {
      searched = true;
      return [];
    },
  });
  assert.equal(job.stage, 'choosing');
  assert.equal(searched, false);
  assert.equal(job.query, 'ISO 129-1:2015');
  assert.equal(job.resolvedQuery, undefined);
  assert.equal(job.isoChoices[0].reference, 'ISO 129-1:2018');
  assert.equal(job.pdfReady, false);
});

test('a selected earlier designation drives the exact Doc88 query', async (t) => {
  const job = await fixture(t);
  job.query = 'ISO 129-1:2015';
  job.resolvedQuery = 'ISO 2595:1973';
  job.isoEdition = {
    reference: job.resolvedQuery,
    title: 'Earlier official title',
    pageCount: 2,
    status: 'Withdrawn',
  };
  let actual;
  await assert.rejects(
    runSearchJob(job, job.directory, {
      lookupISO: async () => {
        throw Error('Must reuse the explicitly selected catalogue edition');
      },
      search: async (query) => {
        actual = query;
        return [];
      },
    }),
    { code: 'SEARCH_EXHAUSTED' },
  );
  assert.equal(actual, 'ISO 2595:1973');
  assert.equal(job.query, 'ISO 129-1:2015');
});

test('space and hyphen year input both reach the edition picker without changing the year', async (t) => {
  for (const input of ['iso 5458 2013', 'iso 5458-2013']) {
    const job = await fixture(t);
    job.query = validateQuery(input);
    delete job.isoEdition;
    let searched = false;
    await runSearchJob(job, job.directory, {
      lookupISO: async (wanted) => {
        assert.deepEqual(wanted, { organization: 'ISO', number: '5458', part: null, year: '2013' });
        throw new ISOEditionNotFoundError(wanted, [
          { reference: 'ISO 5458:2018', status: 'Published' },
        ]);
      },
      search: async () => {
        searched = true;
        return [];
      },
    });
    assert.equal(job.query, 'ISO 5458:2013');
    assert.equal(job.requestedReference, 'ISO 5458:2013');
    assert.equal(job.stage, 'choosing');
    assert.equal(searched, false);
  }
});

test('page integrity failures reject an upload while uncertain OCR remains a visible review note', async (t) => {
  const job = await fixture(t);
  const candidates = [
    candidate('https://www.doc88.com/p-1.html'),
    candidate('https://www.doc88.com/p-2.html'),
  ];
  await runSearchJob(job, job.directory, {
    candidates,
    download: (child) => fs.writeFile(path.join(child.directory, 'archive.zip'), 'PK-test'),
    convert: async (child) => {
      await convertFixture(child);
      child.pageIntegrity = {
        status: child.url.endsWith('p-1.html') ? 'failed' : 'unknown',
        message: 'Fixture integrity evidence',
      };
    },
  });
  assert.equal(candidates[0].status, 'rejected');
  assert.equal(candidates[0].checks.pageIntegrity.status, 'failed');
  assert.equal(job.url, candidates[1].url);
  assert.equal(job.pageIntegrity.status, 'unknown');
  assert.match(job.message, /ручной проверки/);
});

test('search recovery reuses saved candidates and skips already rejected uploads', async (t) => {
  const job = await fixture(t);
  job.searchVersion = 4;
  job.searchResults = [
    { ...candidate('https://www.doc88.com/p-1.html'), status: 'rejected' },
    { ...candidate('https://www.doc88.com/p-2.html'), status: 'cancelled' },
  ];
  const downloads = [];
  await runSearchJob(job, job.directory, {
    resume: true,
    search: async () => {
      throw Error('Search must not be repeated');
    },
    download: async (child) => {
      downloads.push(child.url);
      await fs.writeFile(path.join(child.directory, 'archive.zip'), 'PK-test');
    },
    convert: convertFixture,
  });
  assert.deepEqual(downloads, ['https://www.doc88.com/p-2.html']);
  assert.equal(job.stage, 'done');
});

test('uncertain English OCR keeps the PDF available with a review note', async (t) => {
  const job = await fixture(t);
  await runSearchJob(job, job.directory, {
    candidates: [candidate('https://www.doc88.com/p-1.html')],
    download: (child) => fs.writeFile(path.join(child.directory, 'archive.zip'), 'PK-test'),
    convert: (child) =>
      convertFixture(child, 'ISO 14405-1:2025(E)\nDimension 123, datum A, tolerance 0.05'),
  });
  assert.equal(job.stage, 'done');
  assert.equal(job.pdfReady, true);
  assert.equal(job.verification.language.status, 'unknown');
  assert.match(job.message, /Язык распознан неуверенно/);
});

test('main standard and amendment search titles and cover identities cannot substitute for one another', () => {
  assert.equal(Boolean(titleMatches('ISO 129-1:2018', 'ISO 129-1:2018/Amd 1:2020')), true);
  assert.equal(identityCheck('ISO 129-1:2018', ['ISO 129-1:2018/Amd 1:2020(E)']).status, 'failed');
  assert.equal(
    Boolean(titleMatches('ISO 129-1:2018/Amd 1:2020', 'ISO 129-1 2018 AMD 1 2020')),
    true,
  );
  assert.equal(identityCheck('ISO 129-1:2018/Amd 1:2020', ['ISO 129-1:2018(E)']).status, 'unknown');
  assert.equal(
    identityCheck('ISO 129-1:2018/Amd 1:2020', ['ISO 129-1:2018/Amd 1:2020(E)']).status,
    'passed',
  );
});

test('preview rejects wrong language before full download, then continues past the first three candidates', async (t) => {
  const job = await fixture(t),
    first = [1, 2, 3].map((n) => candidate(`https://www.doc88.com/p-${n}.html`)),
    fourth = candidate('https://www.doc88.com/p-4.html');
  const downloads = [],
    previews = [];
  async function* pages() {
    yield [fourth];
  }
  await runSearchJob(job, job.directory, {
    candidates: first,
    _searchIterator: pages(),
    preview: async (child) => {
      previews.push(child.url);
      if (!child.url.endsWith('p-4.html'))
        throw Object.assign(Error('Wrong language'), { code: 'FOREIGN_LANGUAGE' });
      return { language: { status: 'passed' } };
    },
    download: async (child) => {
      downloads.push(child.url);
      await fs.writeFile(path.join(child.directory, 'archive.zip'), 'PK-test');
    },
    convert: convertFixture,
  });
  assert.equal(job.stage, 'done');
  assert.equal(previews.length, 4);
  assert.equal(job.previewDiagnostics.total, 4);
  assert.equal(job.previewDiagnostics.completed, 4);
  assert.equal(job.previewDiagnostics.peak, 3);
  assert.deepEqual(downloads, [fourth.url]);
  assert.equal(job.searchResults.length, 4);
  assert.ok(first.every((item) => item.checks.language.status === 'failed'));
});

test('punctuation and translated-title hints do not reject candidate discovery or replace page verification', () => {
  for (const title of [
    '(正版) ISO17450-4-2017.',
    '(精品) ISO17450_4_2017',
    '专业AI译中文版 ISO17450-4-2017',
  ])
    assert.equal(titleMatches('ISO 17450-4:2017', title), true);
  for (const title of ['ISO17450-40:2017', 'ISO17450-5:2017', 'ISO174500-4:2017'])
    assert.equal(titleMatches('ISO 17450-4:2017', title), false);
  assert.equal(
    titleMatches('ASME Y14.6-2001 (R2025)', '专业AI译中文版 ASME Y14.6-2001(R2025)'),
    true,
  );
});

function sourcePage(page, items, next = null) {
  return (
    '<span id="pageResult"></span>' +
    items
      .map(
        ({ title, id, pages = 2 }) =>
          `<div class="sd-list-con"><a class="sd-title" title="${title}" href="https://www.doc88.com/p-${id}.html">${title}</a>页数：${pages} 格式：PDF</div>`,
      )
      .join('') +
    `<div id="page"><a href="javascript:;"><span class="pa current">${page}</span></a>` +
    (page > 1 ? `<a onclick="Search.searchPage('p=${page - 1}');">Previous</a>` : '') +
    (next ? `<a onclick="Search.searchPage('p=${next}');">Next</a>` : '') +
    '</div>'
  );
}

test('short, empty and duplicate source pages still follow explicit pagination, across query variants', async () => {
  const calls = [];
  const excluded = { title: 'DIN EN ISO 129-1:2022', id: 10 };
  const rows = await searchAllDocuments('ISO 129-1:2018', new AbortController().signal, () => {}, {
    fetcher: async (value) => {
      const address = new URL(value),
        q = address.searchParams.get('q'),
        page = Number(address.searchParams.get('p'));
      calls.push([q, page]);
      if (q !== 'ISO 129-1 2018')
        return new Response(sourcePage(1, [{ title: 'ISO129-1-2018', id: 15, pages: 68 }]));
      const items =
        page <= 2 ? [excluded] : page <= 4 ? [] : [{ title: 'ISO 129-1 2018', id: 14, pages: 68 }];
      return new Response(sourcePage(page, items, page < 5 ? page + 1 : null));
    },
  });
  assert.deepEqual(
    calls.filter(([q]) => q === 'ISO 129-1 2018').map(([, p]) => p),
    [1, 2, 3, 4, 5],
  );
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.pageCount === 68));
  assert.ok(calls.some(([q]) => q === 'ISO129-1'));
});

test('search continues after a short rejected upload and wrong-language candidate, then stops at a verified PDF', async (t) => {
  const job = await fixture(t),
    calls = [],
    downloaded = [];
  const iterator = searchDocumentPages(job.query, job.controller.signal, job.log, {
    fetcher: async (value) => {
      const page = Number(new URL(value).searchParams.get('p'));
      calls.push(page);
      assert.ok(page <= 4, 'verified PDF must stop further discovery');
      const items =
        page === 2
          ? [{ title: 'DIN EN ISO 14405-1:2025', id: 2 }]
          : [{ title: 'ISO 14405-1 2025', id: page, pages: page === 1 ? 1 : 2 }];
      return new Response(sourcePage(page, items, page + 1));
    },
  });
  await runSearchJob(job, job.directory, {
    _searchIterator: iterator,
    download: async (child) => {
      downloaded.push(child.url);
      await fs.writeFile(path.join(child.directory, 'archive.zip'), 'PK-test');
    },
    convert: (child) => convertFixture(child, child.url.endsWith('p-3.html') ? french : english),
  });
  assert.deepEqual(calls, [1, 2, 3, 4]);
  assert.deepEqual(downloaded, [
    'https://www.doc88.com/p-3.html',
    'https://www.doc88.com/p-4.html',
  ]);
  assert.equal(job.searchResults[0].checks.extent.status, 'failed');
  assert.equal(job.searchResults[1].checks.language.status, 'failed');
  assert.equal(job.stage, 'done');
  assert.equal(job.pdfReady, true);
  assert.equal(job.url, 'https://www.doc88.com/p-4.html');
});

test('pagination does not mistake a wrong page, fetch failure or safety limit for exhausted search', async () => {
  const run = (fetcher) =>
    searchAllDocuments('ISO 129-1:2018', new AbortController().signal, () => {}, {
      fetcher,
      maxPages: 2,
    });
  await assert.rejects(
    run(async () => new Response(sourcePage(1, [], 2))),
    /другую страницу/,
  );
  await assert.rejects(
    run(async () => new Response('', { status: 503 })),
    /HTTP 503/,
  );
  await assert.rejects(
    run(async (value) => {
      const page = Number(new URL(value).searchParams.get('p'));
      return new Response(sourcePage(page, [], page + 1));
    }),
    /Поиск ещё не завершён/,
  );
  const controller = new AbortController();
  const iterator = searchDocumentPages('ISO 129-1:2018', controller.signal, () => {}, {
    fetcher: async () => new Response(sourcePage(1, [{ title: 'ISO 129-1:2018', id: 1 }], 2)),
  });
  await iterator.next();
  controller.abort();
  await assert.rejects(iterator.next(), /abort/i);
});

test('exhausted rejected candidates and unfinished technical checks have different outcomes', async (t) => {
  const exhausted = await fixture(t);
  await assert.rejects(
    runSearchJob(exhausted, exhausted.directory, {
      candidates: [candidate('https://www.doc88.com/p-1.html', 1)],
      download: async () => {
        throw Error('short uploads must not be downloaded');
      },
    }),
    { code: 'SEARCH_EXHAUSTED' },
  );
  const unfinished = await fixture(t);
  await assert.rejects(
    runSearchJob(unfinished, unfinished.directory, {
      candidates: [candidate('https://www.doc88.com/p-2.html')],
      download: async () => {
        throw Error('connection interrupted');
      },
    }),
    { code: 'SEARCH_INCOMPLETE' },
  );
  assert.equal(unfinished.searchResults[0].status, 'error');
  assert.equal(Boolean(unfinished.pdfReady), false);
});

test('precise discovery requires the requested publisher, part and edition year before broader OCR verification', () => {
  for (const title of [
    'ISO 129-1:2018',
    '（高清）ISO129-1-2018 Technical product documentation',
    'ISO 129-1 2018',
  ])
    assert.equal(exactTitleMatches('ISO 129-1:2018', title), true, title);
  for (const title of [
    'ISO129-1-2004',
    'ISO 129-1',
    'ISO 129-1:20180',
    'ISO 129-2:2018',
    'BS ISO 129-1:2018',
    'DIN EN ISO 129-1:2018',
    'Draft ISO 129-1:2018',
    'ISO 129-1:2018/Amd 1:2020',
    'ISO 129-1-2018 A1-2020',
  ])
    assert.equal(exactTitleMatches('ISO 129-1:2018', title), false, title);
  assert.equal(exactTitleMatches('ISO 129-1:2018/Amd 1:2020', 'ISO 129-1:2018/Amd 1:2020'), true);
  assert.equal(exactTitleMatches('DIN EN ISO 129-1:2022-02', 'DIN EN ISO 129-1 2022-02'), true);
  assert.equal(exactTitleMatches('DIN EN ISO 129-1:2022-02', 'DIN EN ISO 129-1 2019-12'), false);
  assert.equal(exactTitleMatches('ASME Y14.6-2001 (R2025)', 'ASME Y14.6-2001'), true);
  assert.equal(exactTitleMatches('ASME Y14.6-2001 (R2025)', 'ASME Y14.6-2016'), false);
});

test('a valid exact match on a later page finishes before old editions or optimized requests are processed', async (t) => {
  const job = await fixture(t),
    calls = [],
    phases = [],
    downloads = [];
  const iterator = searchDocumentPages(job.query, job.controller.signal, job.log, {
    onPhase: (phase) => phases.push(phase),
    fetcher: async (value) => {
      const url = new URL(value),
        q = url.searchParams.get('q'),
        page = Number(url.searchParams.get('p'));
      calls.push([q, page]);
      assert.equal(q, job.query, 'exact query must retain the colon and year');
      assert.ok(page <= 2, 'verified PDF must not trigger more discovery');
      return new Response(
        sourcePage(
          page,
          [{ title: page === 1 ? 'ISO14405-1-2016' : 'ISO 14405-1:2025', id: page }],
          page + 1,
        ),
      );
    },
  });
  await runSearchJob(job, job.directory, {
    _searchIterator: iterator,
    download: async (child) => {
      downloads.push(child.url);
      await fs.writeFile(path.join(child.directory, 'archive.zip'), 'PK-test');
    },
    convert: convertFixture,
  });
  assert.deepEqual(calls, [
    [job.query, 1],
    [job.query, 2],
  ]);
  assert.deepEqual(phases, ['exact']);
  assert.deepEqual(downloads, ['https://www.doc88.com/p-2.html']);
  assert.equal(job.pdfReady, true);
});

test('failed exact candidates finish before optimized discovery can accept a differently labelled correct PDF', async (t) => {
  const job = await fixture(t),
    calls = [],
    phases = [],
    downloads = [];
  const iterator = searchDocumentPages(job.query, job.controller.signal, job.log, {
    onPhase: (phase) => phases.push(phase),
    fetcher: async (value) => {
      const url = new URL(value),
        q = url.searchParams.get('q'),
        page = Number(url.searchParams.get('p'));
      calls.push([q, page]);
      const items =
        q === job.query
          ? [
              { title: 'ISO 14405-1:2025', id: 1 },
              { title: 'ISO 14405-1:2016', id: 2 },
            ]
          : q === 'ISO 14405-1 2025'
            ? []
            : [{ title: 'ISO 14405-1:2016', id: 2 }];
      return new Response(sourcePage(page, items));
    },
  });
  await runSearchJob(job, job.directory, {
    _searchIterator: iterator,
    download: async (child) => {
      downloads.push(child.url);
      await fs.writeFile(path.join(child.directory, 'archive.zip'), 'PK-test');
    },
    convert: (child) => convertFixture(child, child.url.endsWith('p-1.html') ? french : english),
  });
  assert.deepEqual(phases, ['exact', 'optimized']);
  assert.deepEqual(calls, [
    [job.query, 1],
    ['ISO 14405-1 2025', 1],
    ['ISO 14405-1', 1],
  ]);
  assert.deepEqual(downloads, ['https://www.doc88.com/p-1.html', 'https://www.doc88.com/p-2.html']);
  assert.equal(job.searchResults[0].checks.language.status, 'failed');
  assert.equal(job.searchResults[1].checks.identity.status, 'passed');
  assert.equal(job.pdfReady, true);
});

test('empty exact results switch to optimized search and identical ASME requests reuse parsed responses', async () => {
  const phases = [],
    calls = [];
  const rows = await searchAllDocuments(
    'ASME Y14.6-2001 (R2025)',
    new AbortController().signal,
    () => {},
    {
      onPhase: (phase) => phases.push(phase),
      fetcher: async (value) => {
        const url = new URL(value),
          q = url.searchParams.get('q'),
          page = Number(url.searchParams.get('p'));
        calls.push([q, page]);
        return new Response(sourcePage(page, [{ title: 'ASME Y14.6', id: 1, pages: 24 }]));
      },
    },
  );
  assert.deepEqual(phases, ['exact', 'optimized']);
  assert.equal(rows.length, 1);
  assert.equal(calls.filter(([q]) => q === 'ASME Y14.6-2001').length, 1);
});

test('resuming an older broad-search job discards its candidate order and starts fresh discovery', async (t) => {
  const job = await fixture(t),
    downloads = [];
  job.searchVersion = 3;
  job.searchResults = [{ ...candidate('https://www.doc88.com/p-1.html'), status: 'error' }];
  await runSearchJob(job, job.directory, {
    resume: true,
    search: async () => [candidate('https://www.doc88.com/p-2.html')],
    download: async (child) => {
      downloads.push(child.url);
      await fs.writeFile(path.join(child.directory, 'archive.zip'), 'PK-test');
    },
    convert: convertFixture,
  });
  assert.deepEqual(downloads, ['https://www.doc88.com/p-2.html']);
  assert.equal(job.searchVersion, 4);
});

test('two preliminary checks overlap while full processing stays ordered and ignores speculative progress', async (t) => {
  const job = await fixture(t),
    downloads = [],
    started = [];
  let secondStarted;
  const ready = new Promise((resolve) => {
    secondStarted = resolve;
  });
  await runSearchJob(job, job.directory, {
    candidates: [
      candidate('https://www.doc88.com/p-1.html'),
      candidate('https://www.doc88.com/p-2.html'),
    ],
    preview: async (child) => {
      started.push(child.url);
      child.update({ stage: 'ocr', message: 'SPECULATIVE PROGRESS' });
      assert.doesNotMatch(job.message, /SPECULATIVE/);
      if (child.url.endsWith('p-1.html')) {
        await ready;
        throw Object.assign(Error('wrong language'), { code: 'FOREIGN_LANGUAGE' });
      }
      secondStarted();
      return { language: { status: 'passed' } };
    },
    download: async (child) => {
      downloads.push(child.url);
      await fs.writeFile(path.join(child.directory, 'archive.zip'), 'PK-test');
    },
    convert: convertFixture,
  });
  assert.equal(started.length, 2);
  assert.equal(job.previewDiagnostics.peak, 2);
  assert.deepEqual(downloads, ['https://www.doc88.com/p-2.html']);
  assert.equal(job.previewDiagnostics.active, 0);
  assert.equal(job.performanceMetrics.status, 'done');
  assert.ok(
    job.performanceMetrics.stages.some((stage) => stage.key === 'preview' && stage.calls === 2),
  );
});

test('a faster later preview cannot outrank the first valid candidate; pending work is aborted and drained', async (t) => {
  const job = await fixture(t),
    downloads = [];
  let otherStarted,
    drained = false;
  const ready = new Promise((resolve) => {
    otherStarted = resolve;
  });
  await runSearchJob(job, job.directory, {
    candidates: [
      candidate('https://www.doc88.com/p-1.html'),
      candidate('https://www.doc88.com/p-2.html'),
    ],
    preview: async (child) => {
      if (child.url.endsWith('p-1.html')) {
        await ready;
        return { language: { status: 'passed' } };
      }
      otherStarted();
      await new Promise((resolve) =>
        child.controller.signal.addEventListener('abort', resolve, { once: true }),
      );
      drained = true;
      child.controller.signal.throwIfAborted();
    },
    download: async (child) => {
      downloads.push(child.url);
      await fs.writeFile(path.join(child.directory, 'archive.zip'), 'PK-test');
    },
    convert: convertFixture,
  });
  assert.deepEqual(downloads, ['https://www.doc88.com/p-1.html']);
  assert.equal(drained, true);
  assert.equal(job.previewDiagnostics.cancelled, 1);
  assert.equal(job.previewDiagnostics.active, 0);
  assert.equal(job.stage, 'done');
  assert.ok(job.performanceMetrics.stages.every((stage) => stage.active === 0));
});

test('cancelling parallel previews waits for cleanup and never exposes a PDF', async (t) => {
  const job = await fixture(t);
  let count = 0;
  await assert.rejects(
    runSearchJob(job, job.directory, {
      candidates: [
        candidate('https://www.doc88.com/p-1.html'),
        candidate('https://www.doc88.com/p-2.html'),
      ],
      preview: async (child) => {
        const stopped = new Promise((resolve) =>
          child.controller.signal.addEventListener('abort', resolve, { once: true }),
        );
        if (++count === 2) job.controller.abort();
        await stopped;
        child.controller.signal.throwIfAborted();
      },
      download: async () => {
        throw Error('must never reach download');
      },
      convert: convertFixture,
    }),
    /остановлена/,
  );
  assert.equal(count, 2);
  assert.equal(job.previewDiagnostics.active, 0);
  assert.equal(job.performanceMetrics.status, 'cancelled');
  assert.equal(Boolean(job.pdfReady), false);
  await assert.rejects(fs.access(path.join(job.directory, 'result.pdf')));
});
