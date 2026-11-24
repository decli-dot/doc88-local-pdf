const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { passwordRecord, publicJob } = require('../dev-access.cjs');

test('public job projection withholds source data and diagnostics but retains required user actions', () => {
  const job = {
    id: 'test',
    stage: 'ocr',
    query: 'ISO 5458',
    title: 'ISO 5458',
    message: 'PRIVATE',
    url: 'https://www.doc88.com/p-1.html',
    searchResults: [{ error: 'PRIVATE' }],
    logs: ['PRIVATE'],
    performanceMetrics: { stages: [{ key: 'PRIVATE_METRICS' }] },
    previewDiagnostics: { peak: 2 },
    ocrDiagnostics: { concurrency: 4, peak: 4 },
    pdfOptimization: { version: 1, lossless: true },
    searchProvider: 'anna',
    sourcePolicy: 'anna-first',
    sourceAttempts: [{ provider: 'anna', status: 'passed' }],
    activeSource: 'anna',
    annaSearchDiagnostics: { sample: ['PRIVATE_SOURCE_METADATA'] },
    current: 4,
    total: 12,
    pdfReady: false,
    canResume: false,
    challengeAvailable: true,
  };
  const value = publicJob(job);
  assert.doesNotMatch(
    JSON.stringify(value),
    /PRIVATE|doc88|anna|sourcePolicy|sourceAttempts|activeSource|searchResults|current|total|performanceMetrics|previewDiagnostics|ocrDiagnostics|pdfOptimization/,
  );
  assert.equal(value.message, 'Готовим PDF с поиском по тексту.');
  assert.equal(value.challengeAvailable, true);
  const choices = [{ reference: 'ISO 5458:2018', status: 'Published' }];
  assert.deepEqual(
    publicJob({ ...job, stage: 'choosing', isoChoices: choices }).isoChoices,
    choices,
  );
  assert.equal(publicJob({ ...job, stage: 'done', pdfReady: true, total: 12 }).total, 12);
  assert.equal(job.message, 'PRIVATE');
  const exhausted = publicJob({ ...job, stage: 'error', errorCode: 'SEARCH_EXHAUSTED' });
  const interrupted = publicJob({ ...job, stage: 'error', errorCode: 'SEARCH_INCOMPLETE' });
  assert.equal(exhausted.problem.type, 'not_found');
  assert.equal(interrupted.problem.type, 'processing');
  assert.doesNotMatch(
    JSON.stringify([exhausted, interrupted]),
    /PRIVATE|doc88|searchResults|errorCode/,
  );
});

test('developer sessions require a password, reject cross-site login, redact APIs and revoke on logout', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'declipdf-auth-'));
  const root = path.resolve(__dirname, '..');
  const id = '11111111-1111-4111-8111-111111111111';
  const jobDir = path.join(directory, 'jobs', id);
  await fs.mkdir(jobDir, { recursive: true });
  const password = 'local-test-password';
  const record = passwordRecord(password);
  assert.doesNotMatch(JSON.stringify(record), /local-test-password/);
  await fs.writeFile(path.join(directory, 'dev-access.json'), JSON.stringify(record));
  await fs.writeFile(
    path.join(jobDir, 'job.json'),
    JSON.stringify({
      id,
      kind: 'search',
      query: 'ISO 5458',
      title: 'ISO 5458',
      stage: 'done',
      pdfReady: true,
      archiveReady: true,
      total: 1,
      createdAt: new Date().toISOString(),
      message: 'PRIVATE_DETAILS',
      logs: ['PRIVATE_DETAILS'],
      searchResults: [{ url: 'https://www.doc88.com/p-1.html' }],
    }),
  );
  const foreignId = '99999999-9999-4999-8999-999999999999';
  await fs.mkdir(path.join(directory, 'jobs', foreignId), { recursive: true });
  await fs.writeFile(
    path.join(directory, 'jobs', foreignId, 'job.json'),
    JSON.stringify({
      id: foreignId,
      kind: 'search',
      query: 'ISO 1101',
      resolvedQuery: 'ISO 1101:2017',
      title: 'ISO 1101:2017',
      sourceTitle: '中文版ISO 1101-2017',
      verification: { language: { status: 'failed', message: 'Actual foreign prose in the PDF' } },
      stage: 'done',
      pdfReady: true,
      createdAt: new Date().toISOString(),
    }),
  );
  const preload = path.join(directory, 'worker.cjs');
  await fs.writeFile(
    preload,
    `const filename=${JSON.stringify(path.join(root, 'search.cjs'))};const original=require(filename);require.cache[filename].exports={...original,runSearchJob:async(job)=>{job.update({stage:'error',message:'PRIVATE_DETAILS'});}};`,
  );
  const origin = 'http://127.0.0.1:18977';
  const child = spawn(process.execPath, ['--require', preload, path.join(root, 'server.cjs')], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DOC88_PORT: '18977',
      DOC88_DATA_DIR: directory,
      DECLIPDF_DEV_PASSWORD: '',
    },
  });
  t.after(async () => {
    if (child.exitCode === null) {
      const ended = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await ended;
    }
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('declipdf-auth-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Test server did not start')), 10000);
    child.stdout.on('data', (bytes) => {
      if (bytes.toString().includes('DOC88_READY')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('error', reject);
  });
  const post = (route, input, cookie = '', requestOrigin = origin) =>
    fetch(origin + route, {
      method: 'POST',
      headers: {
        Origin: requestOrigin,
        cookie,
        'x-doc88-request': '1',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    });
  const status = async (cookie = '') =>
    (await fetch(origin + '/api/status?advanced=1&dev=1', { headers: { cookie } })).json();
  assert.equal(
    (
      await post('/api/experiments/anna', {
        query: 'ISO 129-1',
        cardURL: 'https://annas-archive.pk/md5/' + 'a'.repeat(32),
      })
    ).status,
    403,
  );
  const foreign = await (await fetch(origin + '/api/jobs/' + foreignId)).json();
  assert.equal(foreign.stage, 'error');
  assert.equal(foreign.pdfReady, false);
  assert.equal((await fetch(origin + '/api/jobs/' + foreignId + '/pdf')).status, 409);
  assert.equal((await status()).devMode, false);
  assert.equal(
    (await post('/api/search', { query: 'ISO 5458', sourcePolicy: 'anna-only' })).status,
    403,
  );
  assert.equal(
    (await post('/api/batches', { queries: ['ISO 5458'], sourcePolicy: 'anna-first' })).status,
    403,
  );
  assert.equal(
    (await post('/api/search', { query: 'ISO 5458', processingMode: 'direct' })).status,
    403,
  );
  assert.equal(
    (await post('/api/search', { query: 'ISO 5458', processingMode: 'ocr' })).status,
    403,
  );
  assert.equal(
    (await post('/api/search', { query: 'ISO 5458', processingMode: 'unknown' })).status,
    400,
  );
  assert.doesNotMatch(
    JSON.stringify(await status()),
    /PRIVATE_DETAILS|doc88.com|searchResults|logs/,
  );
  assert.doesNotMatch(
    await (await fetch(origin + '/api/jobs/' + id)).text(),
    /PRIVATE_DETAILS|doc88.com/,
  );
  assert.equal((await fetch(origin + '/api/jobs/' + id + '/zip')).status, 403);
  assert.equal((await post('/api/dev/login', { password }, '', 'https://evil.test')).status, 403);
  assert.equal((await post('/api/dev/login', { password: 'incorrect' })).status, 401);
  assert.equal(
    (
      await post('/api/search', {
        query: 'ISO 5458',
        candidateURL: 'https://www.doc88.com/p-1.html',
        sourceJobId: id,
      })
    ).status,
    403,
  );
  const login = await post('/api/dev/login', { password });
  assert.equal(login.status, 200);
  const cookieHeader = login.headers.get('set-cookie');
  assert.match(cookieHeader, /HttpOnly; SameSite=Strict/);
  const cookie = cookieHeader.split(';')[0];
  assert.equal((await fetch(origin + '/api/dev/captcha')).status, 403);
  assert.equal((await post('/api/dev/captcha', { enabled: true })).status, 403);
  assert.equal((await post('/api/dev/captcha/balance', {})).status, 403);
  const captchaKey = '0123456789abcdef0123456789abcdef';
  const captchaSaved = await post(
    '/api/dev/captcha',
    { apiKey: captchaKey, enabled: true, maxPerJob: 1, maxPerDay: 3 },
    cookie,
  );
  assert.equal(captchaSaved.status, 200);
  assert.doesNotMatch(await captchaSaved.text(), new RegExp(captchaKey));
  const captcha = await (await fetch(origin + '/api/dev/captcha', { headers: { cookie } })).json();
  assert.equal(captcha.configured, true);
  assert.equal(captcha.maxPerJob, 1);
  assert.equal(captcha.attemptsToday, 0);
  assert.doesNotMatch(JSON.stringify(await status(cookie)), new RegExp(captchaKey));
  assert.equal((await post('/api/dev/captcha', { apiKey: 'invalid' }, cookie)).status, 400);
  assert.equal(
    (await post('/api/dev/captcha', { enabled: false, apiKey: '' }, cookie)).status,
    200,
  );
  assert.equal(
    (await post('/api/search', { query: 'ISO 5458', sourcePolicy: 'unknown' }, cookie)).status,
    400,
  );
  assert.equal((await status(cookie)).devMode, true);
  assert.match(JSON.stringify(await status(cookie)), /PRIVATE_DETAILS/);
  assert.equal((await status()).devMode, false);
  const search = await post('/api/search', { query: 'iso5458', ocrLanguage: 'rus' });
  assert.equal(search.status, 202);
  assert.equal((await search.json()).ocrLanguage, 'eng');
  for (let i = 0; (await status()).activeId && i < 100; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  const automatic = await post('/api/experiments/anna', { query: 'iso 129-1' }, cookie);
  assert.equal(automatic.status, 202);
  const autoId = (await automatic.json()).id;
  for (let i = 0; (await status()).activeId && i < 100; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  const autoDev = await (
    await fetch(origin + '/api/jobs/' + autoId, { headers: { cookie } })
  ).json();
  assert.equal(autoDev.searchProvider, 'anna');
  assert.equal(autoDev.kind, 'search');
  assert.equal(autoDev.annaCardURL, undefined);
  const autoPublic = await (await fetch(origin + '/api/jobs/' + autoId)).json();
  assert.equal(autoPublic.canResume, true);
  assert.doesNotMatch(JSON.stringify(autoPublic), /anna|PRIVATE|searchProvider/);
  assert.equal((await post('/api/jobs/' + autoId + '/resume', {})).status, 202);
  for (let i = 0; (await status()).activeId && i < 100; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(
    (
      await post(
        '/api/experiments/anna',
        {
          query: 'ISO 129-1',
          slowURL: 'https://annas-archive.pk/slow_download/' + 'a'.repeat(32) + '/0/0',
        },
        cookie,
      )
    ).status,
    400,
  );
  const batch = await post('/api/batches', {
    queries: ['ISO 5458', 'DIN 12345'],
    ocrLanguage: 'deu',
  });
  assert.equal(batch.status, 202);
  const items = (await batch.json()).items;
  for (const item of items) {
    const value = await (await fetch(origin + '/api/jobs/' + item.id)).json();
    assert.equal(value.ocrLanguage, item.query.includes('ISO') ? 'eng' : 'eng+deu');
    assert.doesNotMatch(JSON.stringify(value), /PRIVATE_DETAILS/);
  }
  for (let i = 0; (await status()).activeId && i < 100; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  const manual = await post(
    '/api/search',
    { query: 'ASME Y14.3', processingMode: 'ocr', sourcePolicy: 'anna-only' },
    cookie,
  );
  assert.equal(manual.status, 202);
  const manualId = (await manual.json()).id;
  const manualDev = await (
    await fetch(origin + '/api/jobs/' + manualId, { headers: { cookie } })
  ).json();
  assert.equal(manualDev.processingMode, 'ocr');
  assert.equal(manualDev.sourcePolicy, 'anna-only');
  assert.equal(
    (await (await fetch(origin + '/api/jobs/' + manualId)).json()).sourcePolicy,
    undefined,
  );
  for (let i = 0; (await status()).activeId && i < 100; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  const preferred = await post(
    '/api/batches',
    { queries: ['ISO 5458', 'ASME Y14.3'], sourcePolicy: 'anna-first' },
    cookie,
  );
  assert.equal(preferred.status, 202);
  const preferredItems = (await preferred.json()).items;
  for (const item of preferredItems) {
    const saved = await (
      await fetch(origin + '/api/jobs/' + item.id, { headers: { cookie } })
    ).json();
    assert.equal(saved.sourcePolicy, 'anna-first');
  }
  assert.equal(
    (await (await fetch(origin + '/api/jobs/' + manualId)).json()).processingMode,
    undefined,
  );
  assert.equal((await post('/api/dev/logout', {}, cookie)).status, 200);
  assert.equal((await fetch(origin + '/api/dev/captcha', { headers: { cookie } })).status, 403);
  assert.equal((await status(cookie)).devMode, false);
  for (let i = 0; i < 5; i++)
    assert.equal((await post('/api/dev/login', { password: 'incorrect' })).status, 401);
  assert.equal((await post('/api/dev/login', { password })).status, 429);
  const persisted = JSON.parse(await fs.readFile(path.join(jobDir, 'job.json'), 'utf8'));
  assert.equal(persisted.message, 'PRIVATE_DETAILS');
});
