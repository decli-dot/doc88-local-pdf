const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

test('edition API restores pending choices, accepts only saved choices, serializes resumption and cancels', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'doc88-edition-test-'));
  const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
  const editions = [
    {
      reference: 'ISO 129-1:2018',
      status: 'Published',
      title: 'Current official title',
      pageCount: 68,
      sourceURL: 'https://www.iso.org/standard/64007.html',
    },
    {
      reference: 'ISO 129:1985',
      status: 'Withdrawn',
      title: 'Earlier official title',
      pageCount: 2,
      sourceURL: 'https://www.iso.org/standard/5267.html',
    },
  ];
  for (const id of ids) {
    const target = path.join(directory, 'jobs', id);
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(
      path.join(target, 'job.json'),
      JSON.stringify({
        id,
        query: 'ISO 129-1:2015',
        kind: 'search',
        title: 'ISO 129-1:2015',
        stage: 'choosing',
        isoChoices: editions,
        createdAt: new Date().toISOString(),
      }),
    );
  }
  const legacyId = '33333333-3333-4333-8333-333333333333';
  const legacyDirectory = path.join(directory, 'jobs', legacyId);
  await fs.mkdir(legacyDirectory, { recursive: true });
  await fs.writeFile(
    path.join(legacyDirectory, 'job.json'),
    JSON.stringify({
      id: legacyId,
      kind: 'search',
      stage: 'error',
      query: 'iso 5458 2013',
      resolvedQuery: 'ISO 5458:1998',
      createdAt: new Date().toISOString(),
      isoEdition: {
        reference: 'ISO 5458:1998',
        title: 'Historical title',
        pageCount: 2,
        status: 'Withdrawn',
      },
      searchResults: [
        { url: 'https://www.doc88.com/p-123.html', title: 'ISO 5458:1998', pageCount: 1 },
      ],
    }),
  );
  // Isolate this API test from the real catalogue and both search providers.
  const preload = path.join(directory, 'fetch-fixture.cjs');
  await fs.writeFile(
    preload,
    `const sourceModule=${JSON.stringify(path.join(__dirname, '../pdf-sources.cjs'))};const sources=require(sourceModule);require.cache[sourceModule].exports={...sources,searchPDFSources:async()=>[]};
    const annaModule=${JSON.stringify(path.join(__dirname, '../experimental/anna-search.cjs'))};const anna=require(annaModule);require.cache[annaModule].exports={...anna,searchAnnaPages:async function*(){}};
    global.fetch = async url => {
    const query = new URL(url).searchParams.get('q');
    require('node:fs').writeFileSync(require('node:path').join(process.env.DOC88_DATA_DIR, 'query.json'), JSON.stringify(query));
    return new Response('<div id="pageResult"></div>');
  };`,
  );
  const origin = 'http://127.0.0.1:18969';
  const child = spawn(
    process.execPath,
    ['--require', preload, path.join(__dirname, '../server.cjs')],
    {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        DOC88_PORT: '18969',
        DOC88_DATA_DIR: directory,
        DECLIPDF_DEV_PASSWORD: 'fixture-password',
      },
    },
  );
  t.after(async () => {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await exited;
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('doc88-edition-test-'));
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
    child.on('error', reject);
  });
  const login = await fetch(origin + '/api/dev/login', {
    method: 'POST',
    headers: { Origin: origin, 'x-doc88-request': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'fixture-password' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const post = (id, action, input, requestOrigin = origin) =>
    fetch(`${origin}/api/jobs/${id}/${action}`, {
      method: 'POST',
      headers: {
        Origin: requestOrigin,
        'x-doc88-request': '1',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    });
  assert.equal((await (await fetch(`${origin}/api/jobs/${ids[0]}`)).json()).stage, 'choosing');
  assert.equal((await fetch(origin + '/query.js')).status, 200);
  assert.equal(
    (await post(ids[0], 'edition', { reference: editions[0].reference }, 'https://evil.test'))
      .status,
    403,
  );
  for (const reference of ['ISO 129-1:2015', 'ISO 129-1:2018/Amd 1:2020', 'ISO 9999:2025'])
    assert.equal((await post(ids[0], 'edition', { reference })).status, 400);
  const results = await Promise.all(
    [1, 2].map(() =>
      post(ids[0], 'edition', { reference: 'ISO 129:1985', sourceURL: 'https://evil.test/' }),
    ),
  );
  assert.deepEqual(results.map((result) => result.status).sort(), [202, 409]);
  let job;
  for (let attempt = 0; attempt < 100; attempt++) {
    job = await (await fetch(`${origin}/api/jobs/${ids[0]}`)).json();
    if (job.stage === 'error') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(job.stage, 'error');
  assert.equal(job.query, 'ISO 129-1:2015');
  assert.equal(job.resolvedQuery, 'ISO 129:1985');
  assert.equal(job.isoEdition, undefined);
  const diagnostic = await (
    await fetch(`${origin}/api/jobs/${ids[0]}`, { headers: { cookie } })
  ).json();
  assert.equal(diagnostic.isoEdition.sourceURL, editions[1].sourceURL);
  assert.deepEqual(
    diagnostic.sourceAttempts.map((attempt) => attempt.provider),
    ['doc88', 'anna'],
  );
  assert.equal(
    require('../dist/query.js').normalizeQuery(
      JSON.parse(await fs.readFile(path.join(directory, 'query.json'), 'utf8')),
    ),
    'ISO 129',
  );
  assert.equal((await post(ids[1], 'cancel', {})).status, 200);
  assert.equal((await (await fetch(`${origin}/api/jobs/${ids[1]}`)).json()).stage, 'cancelled');
  assert.equal((await post(ids[1], 'edition', { reference: editions[0].reference })).status, 409);
  const recheck = await fetch(origin + '/api/search', {
    method: 'POST',
    headers: { Origin: origin, 'x-doc88-request': '1', 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({
      query: 'iso 5458-2013',
      sourceJobId: legacyId,
      candidateURL: 'https://www.doc88.com/p-123.html',
    }),
  });
  assert.equal(recheck.status, 202);
  const normalized = await recheck.json();
  assert.equal(normalized.query, 'ISO 5458:2013');
  assert.equal(normalized.resolvedQuery, 'ISO 5458:1998');
});
