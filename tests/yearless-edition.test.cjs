'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { runSearchJob } = require('../search.cjs');

function job(query) {
  return {
    query,
    controller: new AbortController(),
    update(value) {
      Object.assign(this, value);
    },
    log() {},
  };
}
const isoEditions = [
  {
    reference: 'ISO 5458:2018',
    title: 'Current official title',
    pageCount: 44,
    status: 'Published',
    sourceURL: 'https://www.iso.org/standard/65559.html',
  },
  {
    reference: 'ISO 5458:1998',
    title: 'Historical official title',
    pageCount: 12,
    status: 'Withdrawn',
    sourceURL: 'https://www.iso.org/standard/11505.html',
  },
];

test('yearless interactive searches wait for an edition before discovery or cache, even with a single edition', async () => {
  for (const query of ['ISO 5458', 'ASME Y14.6', 'DIN 129-1', 'BS 129-1', 'NF 129-1']) {
    const current = job(query);
    const resolve = async (_wanted, options) => {
      assert.equal(options.chooseEdition, true);
      return query.startsWith('ISO')
        ? { choice: true, editions: isoEditions, incomplete: true }
        : { reference: query + ':2022', title: 'Title', pageCount: 83, status: 'Published' };
    };
    await runSearchJob(current, 'unused', {
      chooseEdition: true,
      resolveISO: resolve,
      lookupPublisher: resolve,
      search: () => assert.fail('Must not search before selection'),
      download: () => assert.fail('Must not download before selection'),
    });
    assert.equal(current.stage, 'choosing');
    assert.equal(current.requestedReference, query);
    assert.equal(current.query, query);
    assert.equal(current.resolvedQuery, undefined);
    assert.equal(current.pdfReady, false);
    assert.equal(current.isoChoices.length, query.startsWith('ISO') ? 2 : 1);
    if (query.startsWith('ISO')) assert.equal(current.isoHistoryIncomplete, true);
  }
});

test('yearless ISO series still stops at part selection', async () => {
  const current = job('ISO 17450');
  await runSearchJob(current, 'unused', {
    chooseEdition: true,
    resolveISO: async () => ({
      series: true,
      reference: 'ISO 17450',
      items: [{ reference: 'ISO 17450-1:2011' }],
    }),
    search: () => assert.fail('Must wait for part selection'),
  });
  assert.equal(current.stage, 'selecting');
  assert.equal(current.isoChoices, undefined);
});

test('HTTP yearless search requires a saved edition and resumes with that dated reference', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'doc88-yearless-test-'));
  const root = path.resolve(__dirname, '..');
  const preload = path.join(directory, 'fixture.cjs');
  await fs.writeFile(
    preload,
    `
    const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
    const isoPath=${JSON.stringify(path.join(root, 'iso-catalog.cjs'))},iso=require(isoPath);
    require.cache[isoPath].exports={...iso,resolveLatestISO:async(wanted,options)=>{
      assert.equal(options.chooseEdition,true);assert.equal(wanted.year,null);
      return {choice:true,reference:'ISO 5458',editions:${JSON.stringify(isoEditions)},incomplete:false};
    }};
    const pdfPath=${JSON.stringify(path.join(root, 'pdf-sources.cjs'))},pdf=require(pdfPath);
    require.cache[pdfPath].exports={...pdf,searchPDFSources:async()=>[]};
    const annaPath=${JSON.stringify(path.join(root, 'experimental/anna-search.cjs'))},anna=require(annaPath);
    require.cache[annaPath].exports={...anna,searchAnnaPages:async function*(){}};
    global.fetch=async url=>{
      const value=new URL(url);assert.equal(value.hostname,'www.doc88.com');
      fs.appendFileSync(path.join(process.env.DOC88_DATA_DIR,'queries.jsonl'),JSON.stringify(value.searchParams.get('q'))+'\\n');
      return new Response('<div id="pageResult"></div>');
    };
  `,
  );
  const origin = 'http://127.0.0.1:18995';
  const child = spawn(process.execPath, ['--require', preload, path.join(root, 'server.cjs')], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DOC88_PORT: '18995',
      DOC88_DATA_DIR: directory,
      DECLIPDF_DEV_PASSWORD: 'fixture-password',
    },
  });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await exited;
    }
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('doc88-yearless-test-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Server did not start')), 15000);
    child.stdout.on('data', (bytes) => {
      if (bytes.toString().includes('DOC88_READY')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(Error('Server stopped: ' + code));
    });
  });
  const post = (route, body) =>
    fetch(origin + route, {
      method: 'POST',
      headers: { Origin: origin, 'x-doc88-request': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const response = await post('/api/search', { query: 'iso 5458', chooseEdition: false });
  assert.equal(response.status, 202);
  const created = await response.json();
  const waitFor = async (stage) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const current = await (await fetch(origin + '/api/jobs/' + created.id)).json();
      if (current.stage === stage) return current;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail('Job never reached ' + stage);
  };
  const choosing = await waitFor('choosing');
  assert.equal(choosing.query, 'ISO 5458');
  assert.deepEqual(
    choosing.isoChoices.map((e) => e.reference),
    isoEditions.map((e) => e.reference),
  );
  await assert.rejects(fs.access(path.join(directory, 'queries.jsonl')), { code: 'ENOENT' });
  assert.equal(
    (await post('/api/jobs/' + created.id + '/edition', { reference: 'ISO 5458:2025' })).status,
    400,
  );
  assert.equal(
    (await post('/api/jobs/' + created.id + '/edition', { reference: 'ISO 5458:1998' })).status,
    202,
  );
  const finished = await waitFor('error'); // Fixture providers have no files; no network/captcha is used.
  assert.equal(finished.resolvedQuery, 'ISO 5458:1998');
  let saved;
  for (let attempt = 0; attempt < 500; attempt++) {
    saved = JSON.parse(
      await fs.readFile(path.join(directory, 'jobs', created.id, 'job.json'), 'utf8'),
    );
    if (saved.stage === 'error') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(
    saved.stage,
    'error',
    'Wait for the persisted terminal state, including queued writes',
  );
  assert.equal(saved.errorCode, 'SEARCH_EXHAUSTED');
  assert.equal(saved.isoEdition.reference, 'ISO 5458:1998');
  assert.equal(saved.isoEdition.status, 'Withdrawn');
  assert.match(await fs.readFile(path.join(directory, 'queries.jsonl'), 'utf8'), /ISO 5458:1998/);
});

test('backup catalogue preserves yearless choices when the primary catalogue is unavailable', async () => {
  const { withITEHFallback } = require('../iteh-catalog.cjs');
  const designation = require('../dist/standard-reference.js');
  const iso = require('../iso-catalog.cjs');
  const rows = isoEditions.map((edition, index) => ({
    id: 'cda0743a-d12c-45c6-87fd-4e96ffda604' + index,
    organization: { externalCode: 'ISO' },
    projectReference: edition.reference,
    title: edition.title,
    standardStatus: { value: edition.status },
    projectDocuments: [
      {
        type: { value: 'Standard' },
        language: { externalCode: 'en' },
        numberOfPages: edition.pageCount,
      },
    ],
  }));
  const primary = async () => {
    throw Error('Catalogue unavailable');
  };
  const options = {
    chooseEdition: true,
    request: async () => ({
      bytes: Buffer.from(JSON.stringify({ data: rows, total: rows.length })),
    }),
  };
  const choice = await withITEHFallback(primary, iso.reference('ISO 5458'), options);
  assert.equal(choice.choice, true);
  assert.deepEqual(
    choice.editions.map((e) => e.reference),
    isoEditions.map((e) => e.reference),
  );
  const nationalRows = rows.map((row, index) => ({
    ...row,
    organization: { externalCode: 'DIN' },
    projectReference: 'DIN 5008:' + (index ? '2011-04' : '2020-03'),
  }));
  await assert.rejects(
    withITEHFallback(primary, designation.parse('DIN 5008'), {
      ...options,
      request: async () => ({
        bytes: Buffer.from(JSON.stringify({ data: nationalRows, total: nationalRows.length })),
      }),
    }),
    (error) => {
      assert.equal(error.code, 'PUBLISHER_EDITION_CHOICE');
      assert.equal(error.editions.length, 2);
      return true;
    },
  );
});
