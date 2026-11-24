'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs/promises'),
  os = require('node:os'),
  path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { requestedPolicy, providersFor } = require('../source-policy.cjs');
const { createSourceSearch } = require('../source-search.cjs');
const { runSearchJob } = require('../search.cjs');
const { importPDF } = require('../pdf-input.cjs');
const { loadSharedCache } = require('../shared-cache.cjs');
const { publicJob } = require('../dev-access.cjs');
const query = 'ISO 129-1:2018';
const prose =
  'This document specifies the requirements for the measurement of manufactured parts.\nThe method shall be used with the specified reference system.\nEach feature is measured independently and the results are recorded in the report.\nThe operator should check that the equipment is suitable for the measurement.\nA surface can be evaluated by more than one method and the selected method shall be stated.';
const scriptProof = {
  version: 1,
  status: 'passed',
  evidence: [{ script: 'Latin', confidence: 2 }],
};
async function fixture(t) {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'declipdf-sources-'));
  t.after(() => fs.rm(data, { recursive: true, force: true }));
  const makePDF = async (reference = query) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica);
    for (let index = 0; index < 2; index++)
      pdf
        .addPage([600, 800])
        .drawText(reference + '\n' + (index ? 'Verification: ' : 'Inspection: ') + prose, {
          font,
          size: 10,
          x: 25,
          y: 750,
        });
    return Buffer.from(await pdf.save());
  };
  const good = await makePDF(),
    old = await makePDF('ISO 129-1:2004');
  const doc = {
    provider: 'doc88',
    url: 'https://www.doc88.com/p-123.html',
    title: query,
    pageCount: 2,
    format: 'PDF',
    status: 'unverified',
  };
  const anna = {
    ...doc,
    provider: 'anna',
    url: 'https://annas-archive.pk/md5/' + createHash('md5').update(good).digest('hex'),
  };
  async function job(sourcePolicy) {
    const directory = path.join(data, 'jobs', randomUUID());
    await fs.mkdir(directory, { recursive: true });
    return {
      directory,
      query,
      sourcePolicy,
      controller: new AbortController(),
      documentLanguage: 'eng',
      ocrLanguage: 'eng',
      processingMode: 'auto',
      isoEdition: {
        reference: query,
        title: 'Technical product documentation',
        pageCount: 2,
        status: 'Published',
      },
      update(value) {
        Object.assign(this, value);
      },
      log() {},
    };
  }
  async function run(job, adapters = {}, hooks = {}) {
    const source = createSourceSearch(job, data, {
      ...adapters,
      downloadAnna: async (child) => fs.writeFile(path.join(child.directory, 'source.pdf'), good),
      checkScripts: async (child) => child.update({ scriptVerification: scriptProof }),
    });
    try {
      await runSearchJob(job, data, {
        ...source.options,
        download: async (child) => {
          child.update({ scriptVerification: scriptProof });
          await fs.writeFile(path.join(child.directory, 'source.pdf'), good);
        },
        convert: importPDF,
        ...hooks,
      });
    } finally {
      await source.close();
    }
  }
  return { data, good, old, doc, anna, job, run };
}
test('source selection validates enums and ordinary requests always use Doc88 before Anna', () => {
  assert.deepEqual(providersFor(requestedPolicy(undefined, false)), ['doc88', 'anna']);
  for (const value of ['anna-first', 'anna-only', 'doc88-only']) {
    assert.throws(() => requestedPolicy(value, false), { status: 403 });
    assert.equal(requestedPolicy(value, true), value);
  }
  for (const value of [null, [], ['doc88-first'], {}, '__proto__', 'all', ''])
    assert.throws(() => requestedPolicy(value, true));
});
test('a valid Doc88 PDF finishes before Anna is opened and keeps preliminary checking enabled', async (t) => {
  const f = await fixture(t),
    job = await f.job(),
    trace = [];
  await f.run(
    job,
    {
      doc88Pages: async function* () {
        trace.push('doc88');
        yield [{ ...f.doc }];
      },
      annaPages: async function* () {
        assert.fail('Anna must stay unopened');
      },
      createBrowser: () => assert.fail('Anna browser must stay unopened'),
    },
    {
      preview: async (child) => {
        trace.push('preview');
        assert.equal(child.provider, 'doc88');
        return {};
      },
    },
  );
  assert.deepEqual(trace, ['doc88', 'preview']);
  assert.equal(job.stage, 'done');
  assert.deepEqual(
    job.sourceAttempts.map((a) => a.status),
    ['passed'],
  );
  assert.doesNotMatch(
    JSON.stringify(publicJob(job)),
    /sourcePolicy|sourceAttempts|doc88|annas-archive/,
  );
});
test('Anna starts only after Doc88 exact and optimized candidates fail the existing content checks', async (t) => {
  const f = await fixture(t),
    job = await f.job(),
    trace = [];
  await f.run(
    job,
    {
      doc88Pages: async function* (query, signal, log, { onPhase }) {
        trace.push('doc88-exact');
        onPhase('exact');
        yield [{ ...f.doc, pageCount: 1 }];
        assert.equal(job.searchResults[0].checks.extent.status, 'failed');
        trace.push('doc88-optimized');
        onPhase('optimized');
        yield [{ ...f.doc, url: 'https://www.doc88.com/p-124.html' }];
        trace.push('doc88-exhausted');
      },
      annaPages: async function* () {
        assert.ok(job.searchResults.every((c) => c.status === 'rejected'));
        trace.push('anna');
        yield [{ ...f.anna }];
      },
    },
    { download: async (child) => fs.writeFile(path.join(child.directory, 'source.pdf'), f.old) },
  );
  assert.deepEqual(trace, ['doc88-exact', 'doc88-optimized', 'doc88-exhausted', 'anna']);
  assert.deepEqual(
    job.searchResults.map((c) => c.status),
    ['rejected', 'rejected', 'passed'],
  );
  assert.equal(job.verification.identity.status, 'passed');
  assert.equal(job.url, f.anna.url);
  assert.deepEqual(
    job.sourceAttempts.map((a) => a.status),
    ['exhausted', 'passed'],
  );
});
test('Anna-first and Anna-only cannot silently use a ready Doc88 cache or old resume candidates', async (t) => {
  const f = await fixture(t),
    saved = await f.job('doc88-only');
  await f.run(saved, {
    doc88Pages: async function* () {
      yield [{ ...f.doc }];
    },
  });
  const probe = await f.job();
  assert.equal((await loadSharedCache(probe, f.data)).ready, true);
  for (const policy of ['anna-first', 'anna-only']) {
    const job = await f.job(policy),
      trace = [];
    job.searchVersion = 4;
    job.searchResults = [{ ...f.doc }];
    await f.run(job, {
      resume: true,
      doc88Pages: async function* () {
        assert.fail('Doc88 must not precede a valid Anna result');
      },
      annaPages: async function* () {
        trace.push('anna');
        yield [{ ...f.anna }];
      },
    });
    assert.deepEqual(trace, ['anna']);
    assert.equal(job.url, f.anna.url);
  }
});
test('reverse priority falls back to Doc88, while single-source modes never consult the other provider', async (t) => {
  const f = await fixture(t),
    job = await f.job('anna-first'),
    trace = [];
  await f.run(job, {
    annaPages: async function* () {
      trace.push('anna');
    },
    doc88Pages: async function* () {
      trace.push('doc88');
      yield [{ ...f.doc }];
    },
  });
  assert.deepEqual(trace, ['anna', 'doc88']);
  for (const policy of ['doc88-only', 'anna-only']) {
    const single = await f.job(policy);
    const other =
      policy === 'doc88-only'
        ? {
            annaPages: async function* () {
              assert.fail('Disabled Anna');
            },
          }
        : {
            doc88Pages: async function* () {
              assert.fail('Disabled Doc88');
            },
          };
    await assert.rejects(
      f.run(
        single,
        {
          doc88Pages: async function* () {},
          annaPages: async function* () {},
          ...other,
        },
        { _cacheAttempted: true },
      ),
      { code: 'SEARCH_EXHAUSTED' },
    );
  }
});
test('source access failures fall back, but cancellation and catalogue choices stop before another source starts', async (t) => {
  const f = await fixture(t),
    job = await f.job();
  await f.run(job, {
    doc88Pages: async function* () {
      throw Object.assign(Error('HTTP 403'), { code: 'SEARCH_INCOMPLETE' });
    },
    annaPages: async function* () {
      yield [{ ...f.anna }];
    },
  });
  assert.equal(job.stage, 'done');
  const cancelled = await f.job();
  await assert.rejects(
    f.run(
      cancelled,
      {
        doc88Pages: async function* () {
          cancelled.controller.abort();
          throw Error('Cancelled');
        },
        annaPages: async function* () {
          assert.fail('Cancellation must not launch Anna');
        },
      },
      { _cacheAttempted: true },
    ),
  );
  const choice = await f.job();
  choice.query = 'ISO 129-1:2015';
  choice.isoEdition = null;
  await f.run(
    choice,
    {
      doc88Pages: async function* () {
        assert.fail('Catalogue choice must precede all source searches');
      },
      annaPages: async function* () {
        assert.fail('Catalogue choice must precede all source searches');
      },
    },
    {
      lookupISO: async () => {
        throw Object.assign(Error('Choose edition'), {
          code: 'ISO_EDITION_NOT_FOUND',
          editions: [{ reference: query, status: 'Published' }],
        });
      },
    },
  );
  assert.equal(choice.stage, 'choosing');
});
test('failure of both sources remains retryable and manual candidates cannot enable a disabled source', async (t) => {
  const f = await fixture(t),
    job = await f.job();
  await assert.rejects(
    f.run(job, {
      doc88Pages: async function* () {
        throw Error('HTTP 403');
      },
      annaPages: async function* () {
        throw Object.assign(Error('Manual confirmation pending'), {
          code: 'SOURCE_ACCESS_PENDING',
        });
      },
    }),
    { code: 'SOURCE_ACCESS_PENDING' },
  );
  assert.deepEqual(
    job.sourceAttempts.map((a) => a.status),
    ['error', 'error'],
  );
  const single = await f.job('doc88-only');
  await assert.rejects(f.run(single, { candidates: [{ ...f.anna }] }));
  assert.notEqual(single.pdfReady, true);
});
