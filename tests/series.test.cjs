const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
test('saved series selections survive restart, accept only listed parts and atomically create one batch', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'declipdf-series-')),
    root = path.resolve(__dirname, '..'),
    id = '11111111-1111-4111-8111-111111111111',
    jobDir = path.join(directory, 'jobs', id);
  await fs.mkdir(jobDir, { recursive: true });
  const seriesOptions = [1, 2, 3].map((part) => ({
    reference: `ISO 17450-${part}:2020`,
    title: 'Official part ' + part,
    status: 'Published',
    sourceURL: `https://www.iso.org/standard/${part}.html`,
  }));
  await fs.writeFile(
    path.join(jobDir, 'job.json'),
    JSON.stringify({
      id,
      kind: 'search',
      sourcePolicy: 'anna-first',
      query: 'ISO 17450',
      title: 'ISO 17450',
      stage: 'selecting',
      seriesReference: 'ISO 17450',
      seriesOptions,
      ocrLanguage: 'eng',
      createdAt: new Date().toISOString(),
    }),
  );
  const preload = path.join(directory, 'worker.cjs');
  const languageId = '22222222-2222-4222-8222-222222222222',
    languageDir = path.join(directory, 'jobs', languageId);
  await fs.mkdir(languageDir, { recursive: true });
  await fs.writeFile(
    path.join(languageDir, 'job.json'),
    JSON.stringify({
      id: languageId,
      kind: 'search',
      query: 'DIN EN ISO 129-1:2022-02',
      stage: 'language',
      languageChoices: [
        { code: 'eng', label: 'Английский' },
        { code: 'deu', label: 'Немецкий' },
      ],
      createdAt: new Date().toISOString(),
    }),
  );
  await fs.writeFile(
    preload,
    `const file=${JSON.stringify(path.join(root, 'search.cjs'))};const original=require(file);require.cache[file].exports={...original,runSearchJob:async job=>job.update({stage:'done',pdfReady:false})};`,
  );
  const origin = 'http://127.0.0.1:18979';
  const child = spawn(process.execPath, ['--require', preload, path.join(root, 'server.cjs')], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DOC88_PORT: '18979', DOC88_DATA_DIR: directory },
  });
  t.after(async () => {
    if (child.exitCode === null) {
      const ended = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await ended;
    }
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('declipdf-series-'));
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
    child.once('error', reject);
  });
  const saved = await (await fetch(origin + '/api/jobs/' + id)).json();
  assert.equal(saved.stage, 'selecting');
  assert.equal(saved.seriesOptions.length, 3);
  const post = (references, requestOrigin = origin) =>
    fetch(origin + '/api/jobs/' + id + '/series', {
      method: 'POST',
      headers: {
        Origin: requestOrigin,
        'x-doc88-request': '1',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ references, sourceURL: 'https://evil.test/' }),
    });
  assert.equal((await post([])).status, 400);
  assert.equal((await post(['ISO 9999:2020'])).status, 400);
  assert.equal((await post([seriesOptions[0].reference], 'https://evil.test')).status, 403);
  const responses = await Promise.all([
    post([seriesOptions[0].reference, seriesOptions[2].reference, seriesOptions[2].reference]),
    post([seriesOptions[1].reference]),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [202, 409]);
  const batch = await responses.find((response) => response.status === 202).json();
  assert.equal(batch.total, 2);
  for (const item of batch.items) {
    const stored = JSON.parse(
      await fs.readFile(path.join(directory, 'jobs', item.id, 'job.json'), 'utf8'),
    );
    assert.equal(stored.sourcePolicy, 'anna-first');
  }
  assert.deepEqual(
    batch.items.map((item) => item.query),
    [seriesOptions[0].reference, seriesOptions[2].reference],
  );
  const job = await (await fetch(origin + '/api/jobs/' + id)).json();
  assert.equal(job.resolvedQuery, seriesOptions[0].reference);
  assert.equal(job.seriesOptions, null);
  assert.equal((await post([seriesOptions[1].reference])).status, 409);
  assert.equal((await (await fetch(origin + '/api/jobs/' + languageId)).json()).stage, 'language');
  const chooseLanguage = (code, requestOrigin = origin) =>
    fetch(origin + '/api/jobs/' + languageId + '/language', {
      method: 'POST',
      headers: {
        Origin: requestOrigin,
        'x-doc88-request': '1',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ code, ocrLanguage: 'fra', sourceURL: 'https://evil.test/' }),
    });
  assert.equal((await chooseLanguage('fra')).status, 400);
  assert.equal((await chooseLanguage('deu', 'https://evil.test')).status, 403);
  const choices = await Promise.all([chooseLanguage('deu'), chooseLanguage('eng')]);
  assert.deepEqual(choices.map((r) => r.status).sort(), [202, 409]);
  const selected = await (await fetch(origin + '/api/jobs/' + languageId)).json();
  assert.equal(selected.documentLanguage, 'deu');
  assert.equal(selected.ocrLanguage, 'deu');
  assert.equal(selected.languageChoices, null);
});
