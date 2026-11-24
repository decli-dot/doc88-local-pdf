const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { seriesChoices } = require('../dist/ocr-language.js');
const { runSearchJob } = require('../search.cjs');

test('a series offers its available languages once; ISO and BS remain English-only', () => {
  assert.deepEqual(
    seriesChoices([
      { reference: 'DIN 123-1:2024-01', languages: ['eng', 'deu'] },
      { reference: 'DIN 123-2:2024-01', languages: ['deu'] },
    ]).map((x) => x.code),
    ['eng', 'deu'],
  );
  assert.deepEqual(
    seriesChoices([
      { reference: 'NF EN ISO 123-1:2024', languages: ['eng', 'fra'] },
      { reference: 'NF EN ISO 123-2:2024', languages: ['fra'] },
    ]).map((x) => x.code),
    ['eng', 'fra'],
  );
  for (const publisher of ['ISO', 'BS EN ISO', 'ASME'])
    assert.deepEqual(
      seriesChoices([
        { reference: publisher + ' 123-1:2024', languages: ['eng', 'deu', 'fra'] },
      ]).map((x) => x.code),
      ['eng'],
    );
});
test('batch language applies to matching parts and asks explicitly for the unavailable-language exception', async () => {
  for (const publisher of ['DIN', 'NF']) {
    const alternative = publisher === 'DIN' ? 'deu' : 'fra';
    const edition = {
      publisher,
      reference: publisher + ' EN ISO 129-1:2022-02',
      title: 'Fixture',
      pageCount: 2,
      languages: ['eng', alternative],
    };
    function job(languages) {
      return {
        query: edition.reference,
        resolvedQuery: edition.reference,
        catalogueEdition: { ...edition, languages },
        batchLanguagePreference: 'eng',
        controller: new AbortController(),
        update(x) {
          Object.assign(this, x);
        },
        log() {},
      };
    }
    const first = job(['eng', alternative]);
    await assert.rejects(runSearchJob(first, 'unused', { candidates: [] }), /Выбранный вариант/);
    assert.equal(first.documentLanguage, 'eng');
    assert.equal(first.ocrLanguage, 'eng');
    const exception = job([alternative]);
    await runSearchJob(exception, 'unused', {
      search: () => assert.fail('Wait for the exception choice'),
    });
    assert.equal(exception.stage, 'language');
    assert.equal(exception.languageException, 'batch-unavailable');
    assert.deepEqual(
      exception.languageChoices.map((x) => x.code),
      [alternative],
    );
    exception.documentLanguage = alternative;
    await assert.rejects(
      runSearchJob(exception, 'unused', { candidates: [] }),
      /Выбранный вариант/,
    );
    assert.equal(exception.documentLanguage, alternative);
    assert.equal(exception.resolvedQuery, edition.reference);
    const next = job(['eng', alternative]);
    await assert.rejects(runSearchJob(next, 'unused', { candidates: [] }), /Выбранный вариант/);
    assert.equal(next.documentLanguage, 'eng');
  }
});
test('selected parts and the one-time language chooser survive restart and cancellation; concurrent choices create one batch', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'declipdf-series-language-'));
  const root = path.resolve(__dirname, '..'),
    id = '11111111-1111-4111-8111-111111111111';
  const jobDir = path.join(directory, 'jobs', id);
  await fs.mkdir(jobDir, { recursive: true });
  const editions = [1, 2, 3].map((part) => ({
    reference: `DIN EN ISO 17450-${part}:2024-02`,
    publisher: 'DIN',
    title: 'Official part ' + part,
    pageCount: 2,
    languages: part === 2 ? ['deu'] : ['eng', 'deu'],
    sourceURL: 'https://www.dinmedia.de/en/standard/fixture',
    status: 'Published',
  }));
  await fs.writeFile(
    path.join(jobDir, 'job.json'),
    JSON.stringify({
      id,
      kind: 'search',
      query: 'DIN 17450',
      title: 'DIN 17450',
      stage: 'selecting',
      seriesReference: 'DIN 17450',
      seriesOptions: editions,
      ocrLanguage: 'eng+deu',
      createdAt: new Date().toISOString(),
    }),
  );
  const preload = path.join(directory, 'worker.cjs');
  await fs.writeFile(
    preload,
    `const file=${JSON.stringify(path.join(root, 'search.cjs'))};const original=require(file);require.cache[file].exports={...original,runSearchJob:async(job,data)=>{try{await original.runSearchJob(job,data,{search:async()=>[]});}catch(error){if(error.code!=='SEARCH_EXHAUSTED')throw error;job.update({stage:'done',pdfReady:false});}}};`,
  );
  const origin = 'http://127.0.0.1:18980';
  let child;
  async function stop() {
    if (child && child.exitCode === null) {
      const ended = new Promise((r) => child.once('exit', r));
      child.kill();
      await ended;
    }
  }
  async function start() {
    child = spawn(process.execPath, ['--require', preload, path.join(root, 'server.cjs')], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DOC88_PORT: '18980', DOC88_DATA_DIR: directory },
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
  }
  t.after(async () => {
    await stop();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('declipdf-series-language-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  async function get(jobId = id) {
    return (await fetch(origin + '/api/jobs/' + jobId)).json();
  }
  const post = (suffix, body = {}, jobId = id) =>
    fetch(origin + '/api/jobs/' + jobId + '/' + suffix, {
      method: 'POST',
      headers: { Origin: origin, 'x-doc88-request': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  async function until(predicate) {
    for (let n = 0; n < 100; n++) {
      if (await predicate()) return;
      await new Promise((r) => setTimeout(r, 40));
    }
    assert.fail('Expected persisted state was not reached');
  }
  await start();
  const references = editions.map((x) => x.reference);
  const responses = await Promise.all([
    post('series', { references }),
    post('series', { references }),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  let state = await get();
  assert.equal(state.stage, 'language');
  assert.equal(state.languageScope, 'series');
  assert.equal(state.languageDocumentCount, 3);
  assert.match(state.message, /выбранных документов/);
  assert.equal((await (await fetch(origin + '/api/status')).json()).batches.length, 0);
  await until(
    async () =>
      JSON.parse(await fs.readFile(path.join(jobDir, 'job.json'))).languageScope === 'series',
  );
  await stop();
  await start();
  state = await get();
  assert.equal(state.stage, 'language');
  assert.equal(state.languageDocumentCount, 3);
  assert.equal((await post('cancel')).status, 200);
  assert.equal((await get()).stage, 'cancelled');
  assert.equal((await post('resume')).status, 202);
  assert.equal((await get()).languageScope, 'series');
  assert.equal((await post('language', { code: 'fra' })).status, 400);
  const chosen = await Promise.all([
    post('language', { code: 'eng' }),
    post('language', { code: 'deu' }),
  ]);
  assert.deepEqual(chosen.map((r) => r.status).sort(), [202, 409]);
  const batch = await chosen.find((r) => r.status === 202).json();
  assert.equal(batch.total, 3);
  assert.deepEqual(
    batch.items.map((x) => x.query),
    references,
  );
  await until(async () => {
    const jobs = await Promise.all(batch.items.map((x) => get(x.id)));
    return jobs[0].stage === 'done' && jobs[1].stage === 'language' && jobs[2].stage === 'done';
  });
  const members = await Promise.all(batch.items.map((x) => get(x.id)));
  assert.equal(members[0].documentLanguage, 'eng');
  assert.equal(members[2].documentLanguage, 'eng');
  const exception = members[1];
  assert.equal(exception.languageException, 'batch-unavailable');
  assert.deepEqual(
    exception.languageChoices.map((x) => x.code),
    ['deu'],
  );
  assert.equal((await post('language', { code: 'eng' }, exception.id)).status, 400);
  assert.equal((await post('language', { code: 'deu' }, exception.id)).status, 202);
  await until(async () => (await get(exception.id)).stage === 'done');
  assert.equal((await get(exception.id)).documentLanguage, 'deu');
  assert.equal((await get(batch.items[2].id)).documentLanguage, 'eng');
  assert.equal((await get(exception.id)).query, editions[1].reference);
  assert.equal((await (await fetch(origin + '/api/status')).json()).batches.length, 1);
});
