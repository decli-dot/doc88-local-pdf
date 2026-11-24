'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os');
const { spawn } = require('node:child_process');
const { dependency } = require('../runtime.cjs');

test('multiple languages create distinct PDFs, expand a series by availability, and preserve an existing queue', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'declipdf-languages-'));
  const root = path.resolve(__dirname, '..');
  const ids = Array.from(
    { length: 4 },
    (_, index) => String(index + 1).repeat(8) + '-1111-4111-8111-111111111111',
  );
  const parentId = '55555555-1111-4111-8111-111111111111';
  const choices = [
    { code: 'eng', label: 'Английский' },
    { code: 'deu', label: 'Немецкий' },
  ];
  const edition = {
    publisher: 'DIN',
    reference: 'DIN 127:1987-10',
    title: 'Spring lock washers',
    pageCount: 3,
    status: 'Withdrawn',
    languages: ['eng', 'deu'],
  };
  const series = [1, 2].map((part) => ({
    publisher: 'NF',
    reference: `NF EN ISO 17450-${part}:2024`,
    title: 'Official part ' + part,
    pageCount: 3,
    status: 'Published',
    languages: part === 1 ? ['eng', 'fra'] : ['fra'],
  }));
  const seeds = [
    {
      id: ids[0],
      query: edition.reference,
      resolvedQuery: edition.reference,
      catalogueEdition: edition,
      languageChoices: choices,
      sourcePolicy: 'anna-only',
    },
    {
      id: ids[1],
      query: 'NF 17450',
      seriesReference: 'NF 17450',
      seriesOptions: series,
      languageScope: 'series',
      pendingSeriesReferences: series.map((e) => e.reference),
      languageChoices: [choices[0], { code: 'fra', label: 'Французский' }],
    },
    {
      id: ids[2],
      query: edition.reference,
      resolvedQuery: edition.reference,
      catalogueEdition: edition,
      languageChoices: choices,
      batchId: parentId,
    },
    { id: ids[3], query: 'ISO 5458:2018', stage: 'done', pdfReady: false, batchId: parentId },
  ];
  for (const seed of seeds) {
    const target = path.join(directory, 'jobs', seed.id);
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(
      path.join(target, 'job.json'),
      JSON.stringify({
        kind: 'search',
        stage: 'language',
        createdAt: new Date().toISOString(),
        ...seed,
      }),
    );
  }
  await fs.mkdir(path.join(directory, 'batches'));
  await fs.writeFile(
    path.join(directory, 'batches', parentId + '.json'),
    JSON.stringify({ id: parentId, createdAt: new Date().toISOString(), jobIds: [ids[3], ids[2]] }),
  );
  const preload = path.join(directory, 'worker.cjs');
  await fs.writeFile(
    preload,
    `
    const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
    const filename=${JSON.stringify(path.join(root, 'search.cjs'))},original=require(filename);
    require.cache[filename].exports={...original,runSearchJob:async(job,data)=>{
      try{await original.runSearchJob(job,data,{search:async()=>[]});if(job.stage==='language')return;}
      catch(error){if(error.code!=='SEARCH_EXHAUSTED')throw error;}
      assert.equal(job.ocrLanguage,job.documentLanguage);
      assert.ok(['eng','deu','fra'].includes(job.documentLanguage));
      await new Promise(resolve=>setTimeout(resolve,60));
      await fs.writeFile(path.join(job.directory,'result.pdf'),'%PDF-fixture '+job.documentLanguage);
      job.update({stage:'done',pdfReady:true,pdfFilename:'Standard.pdf',total:3,finishedAt:new Date().toISOString()});
    }};
  `,
  );
  const origin = 'http://127.0.0.1:18996';
  let child;
  const stop = async () => {
    if (child?.exitCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await exited;
    }
  };
  t.after(async () => {
    await stop();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('declipdf-languages-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const start = async () => {
    child = spawn(process.execPath, ['--require', preload, path.join(root, 'server.cjs')], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DOC88_PORT: '18996', DOC88_DATA_DIR: directory },
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Server did not start')), 15000);
      child.stdout.on('data', (bytes) => {
        if (bytes.toString().includes('DOC88_READY')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once('error', reject);
    });
  };
  const get = async (route) => (await fetch(origin + route)).json();
  const post = (id, body) =>
    fetch(origin + '/api/jobs/' + id + '/language', {
      method: 'POST',
      headers: { Origin: origin, 'x-doc88-request': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const complete = async (id) => {
    for (let attempt = 0; attempt < 150; attempt++) {
      const batch = await get('/api/batches/' + id);
      if (batch.items.every((item) => item.stage === 'done')) return batch;
      if (batch.items.some((item) => item.stage === 'error'))
        assert.fail(JSON.stringify(batch.items));
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail('Queue did not complete');
  };
  await start();
  for (const codes of [[], ['rus'], ['eng', 'rus'], ['eng+deu'], 'all', [null]]) {
    assert.equal((await post(ids[0], { codes })).status, 400);
    assert.equal((await get('/api/jobs/' + ids[0])).stage, 'language');
  }
  const concurrent = await Promise.all([
    post(ids[0], { codes: ['eng', 'deu'] }),
    post(ids[0], { codes: ['eng', 'deu'] }),
  ]);
  assert.deepEqual(concurrent.map((r) => r.status).sort(), [202, 409]);
  const first = await concurrent.find((r) => r.status === 202).json();
  assert.equal(first.total, 2);
  const ready = await complete(first.id);
  assert.deepEqual(
    ready.items.map((item) => item.documentLanguage),
    ['eng', 'deu'],
  );
  for (const [index, language] of ['eng', 'deu'].entries()) {
    const current = await get('/api/jobs/' + ready.items[index].id);
    assert.equal(current.documentLanguage, language);
    assert.equal(current.ocrLanguage, language);
    assert.match(current.pdfFilename, new RegExp('\\[' + (index ? 'DE' : 'EN') + '\\]\\.pdf$'));
    const source = JSON.parse(
      await fs.readFile(path.join(directory, 'jobs', current.id, 'job.json'), 'utf8'),
    );
    assert.equal(source.sourcePolicy, 'anna-only');
    assert.equal(source.catalogueEdition.reference, edition.reference);
    const download = await fetch(origin + '/api/jobs/' + current.id + '/pdf');
    assert.ok(
      decodeURIComponent(download.headers.get('content-disposition')).includes(
        index ? '[DE].pdf' : '[EN].pdf',
      ),
    );
    assert.equal(await download.text(), '%PDF-fixture ' + language);
  }
  const zipResponse = await fetch(origin + '/api/batches/' + first.id + '/zip');
  const zip = await dependency('jszip').loadAsync(Buffer.from(await zipResponse.arrayBuffer()));
  assert.deepEqual(
    Object.keys(zip.files)
      .filter((name) => name.endsWith('.pdf'))
      .sort(),
    ['Standard [DE].pdf', 'Standard [EN].pdf'],
  );
  assert.equal(await zip.file('Standard [EN].pdf').async('string'), '%PDF-fixture eng');
  assert.equal(await zip.file('Standard [DE].pdf').async('string'), '%PDF-fixture deu');
  const seriesResponse = await post(ids[1], { codes: ['eng', 'fra'] });
  assert.equal(seriesResponse.status, 202);
  const seriesBatch = await seriesResponse.json();
  assert.equal(seriesBatch.total, 3);
  const seriesReady = await complete(seriesBatch.id);
  assert.deepEqual(
    seriesReady.items.map((item) => [item.query, item.documentLanguage]),
    [
      [series[0].reference, 'eng'],
      [series[0].reference, 'fra'],
      [series[1].reference, 'fra'],
    ],
  );
  const expandedResponse = await post(ids[2], { codes: ['eng', 'deu', 'eng'] });
  assert.equal(expandedResponse.status, 202);
  const expanded = await expandedResponse.json();
  assert.equal(expanded.id, parentId);
  assert.equal(expanded.total, 3);
  const expandedReady = await complete(parentId);
  assert.equal(expandedReady.items[0].id, ids[3]);
  assert.equal(new Set(expandedReady.items.map((item) => item.id)).size, 3);
  assert.equal((await get('/api/status')).batches.length, 3);
  await stop();
  await start();
  const restored = await get('/api/batches/' + first.id);
  assert.equal(restored.total, 2);
  assert.deepEqual(
    restored.items.map((item) => item.documentLanguage),
    ['eng', 'deu'],
  );
  assert.equal((await get('/api/status')).batches.length, 3);
});
