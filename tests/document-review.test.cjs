const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs/promises'),
  os = require('node:os'),
  path = require('node:path');
const { spawn } = require('node:child_process');
const { PDFDocument } = require('pdf-lib');
test('ratings and cache are persisted, private diagnostics stay gated, and rejected PDFs cannot be reused', async (t) => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'declipdf-review-'));
  const id = '11111111-1111-4111-8111-111111111111';
  const directory = path.join(data, 'jobs', id);
  await fs.mkdir(directory, { recursive: true });
  const pdf = await PDFDocument.create();
  pdf.addPage();
  await fs.writeFile(path.join(directory, 'result.pdf'), await pdf.save());
  const job = {
    id,
    kind: 'search',
    stage: 'done',
    pdfReady: true,
    total: 1,
    createdAt: new Date().toISOString(),
    query: 'ISO 7200:2004',
    resolvedQuery: 'ISO 7200:2004',
    title: 'Test standard',
    url: 'https://www.doc88.com/p-123456.html',
    documentLanguage: 'eng',
    ocrLanguage: 'eng',
    isoEdition: { reference: 'ISO 7200:2004', title: 'Test standard', pageCount: 1 },
    verification: {
      language: { version: 2, status: 'passed', matchedLanguages: ['eng'] },
      identity: { status: 'passed' },
      extent: { status: 'passed' },
      completeness: { status: 'passed', pages: 1, declaredPages: 1 },
    },
    scriptVerification: {
      version: 1,
      status: 'passed',
      evidence: [{ script: 'Latin', confidence: 0.9 }],
    },
  };
  await fs.writeFile(path.join(directory, 'job.json'), JSON.stringify(job));
  const root = path.resolve(__dirname, '..'),
    port = 18994,
    origin = 'http://127.0.0.1:' + port;
  const child = spawn(process.execPath, [path.join(root, 'server.cjs')], {
    cwd: root,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DOC88_PORT: String(port),
      DOC88_DATA_DIR: data,
      DECLIPDF_DEV_PASSWORD: 'test-review-password',
    },
  });
  t.after(async () => {
    child.kill();
    await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
    assert.equal(path.dirname(data), os.tmpdir());
    await fs.rm(data, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Server startup timeout')), 15000);
    child.stdout.on('data', (b) => {
      if (String(b).includes('DOC88_READY')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('error', reject);
    child.once('exit', () => {
      clearTimeout(timer);
      reject(Error('Server exited'));
    });
  });
  let cookie = '';
  const req = (route, body, auth = false) =>
    fetch(origin + route, {
      method: body ? 'POST' : 'GET',
      headers: {
        Origin: origin,
        'x-doc88-request': '1',
        'Content-Type': 'application/json',
        ...(auth ? { Cookie: cookie } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  assert.equal((await req('/api/dev/cache')).status, 403);
  const login = await req('/api/dev/login', { password: 'test-review-password' });
  cookie = login.headers.get('set-cookie').split(';')[0];
  let list = await (await req('/api/dev/cache', null, true)).json();
  assert.equal(list.items[0].reusable, true);
  assert.equal(
    (
      await req('/api/jobs/' + id + '/review', {
        rating: 'bad',
        comment: '<img src=x onerror=alert(1)> Wrong cover',
      })
    ).status,
    200,
  );
  list = await (await req('/api/dev/cache', null, true)).json();
  assert.equal(list.items[0].reusable, false);
  assert.equal(list.events.length, 1);
  assert.equal((await req('/api/dev/cache/' + id + '/reuse', {}, true)).status, 409);
  const publicJob = await (await req('/api/jobs/' + id)).json();
  assert.equal(publicJob.review.rating, 'bad');
  assert.equal(publicJob.review.url, undefined);
  assert.equal(
    (await req('/api/jobs/' + id + '/review', { rating: 'good', comment: 'Corrected assessment' }))
      .status,
    200,
  );
  const reuse = await req('/api/dev/cache/' + id + '/reuse', {}, true);
  const result = await reuse.json();
  assert.equal(reuse.status, 200, JSON.stringify(result));
  assert.notEqual(result.id, id);
  assert.equal(result.cacheUsage.status, 'hit');
  assert.equal(result.review.rating, 'good');
  list = await (await req('/api/dev/cache', null, true)).json();
  assert.equal(list.items.length, 1, 'repeat cache use must not add another row');
  const log = JSON.parse(await fs.readFile(path.join(data, 'document-reviews.json')));
  assert.equal(log.events.length, 2);
  assert.equal(
    (await req('/api/jobs/' + id + '/review', { rating: 'bad', comment: 'x'.repeat(4001) })).status,
    400,
  );
});
