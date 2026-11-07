const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { dependency } = require('../runtime.cjs');
const { validateBatch } = require('../batch.cjs');
const JSZip = dependency('jszip');

test('batch input normalizes and deduplicates ISO designations and bounds the list', () => {
  assert.deepEqual(validateBatch('iso 5458 2013\niso 5458-2013\nISO 129-1:2004'), [
    'ISO 5458:2013',
    'ISO 129-1:2004',
  ]);
  for (const input of ['', ['ab'], new Array(31).fill('ISO 5458')])
    assert.throws(() => validateBatch(input));
});
test('queue survives interruptions, skips waiting choices, serializes workers and archives only ready PDFs', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'doc88-batch-test-'));
  const origin = 'http://127.0.0.1:18970';
  const restored = '44444444-4444-4444-8444-444444444444';
  await fs.mkdir(path.join(directory, 'jobs', restored), { recursive: true });
  await fs.writeFile(
    path.join(directory, 'jobs', restored, 'job.json'),
    JSON.stringify({
      id: restored,
      kind: 'search',
      query: 'ISO 888:2020',
      title: 'Interrupted',
      stage: 'ocr',
      createdAt: new Date().toISOString(),
    }),
  );
  const preload = path.join(directory, 'worker-fixture.cjs');
  await fs.writeFile(
    preload,
    `
    const fs=require('node:fs/promises'), path=require('node:path');
    const file=${JSON.stringify(require.resolve('../search.cjs'))}; const original=require(file);
    let running=0;
    require.cache[file].exports={...original,runSearchJob:async(job,data,options)=>{
      running++;
      await fs.appendFile(path.join(data,'events.jsonl'),JSON.stringify({event:'start',running,id:job.id})+'\\n');
      try {
        if(job.query.includes('2013')&&!job.resolvedQuery){job.update({stage:'choosing',isoChoices:[{reference:'ISO 5458:2018',title:'Official fixture',pageCount:44,status:'Published',sourceURL:'https://www.iso.org/standard/65559.html'}],message:'Choose an edition'});return;}
        job.update({stage:'checking',message:'Fixture worker'});
        await new Promise(resolve=>setTimeout(resolve,150));
        job.controller.signal.throwIfAborted();
        if(job.query.includes('999:')&&!options.resume)throw Error('Simulated interruption');
        await fs.writeFile(path.join(job.directory,'result.pdf'),'%PDF-fixture');
        job.update({stage:'done',pdfReady:true,pdfFilename:'Same official title.pdf',total:1,bytes:12,message:'Ready'});
      }finally{running--;await fs.appendFile(path.join(data,'events.jsonl'),JSON.stringify({event:'end',running,id:job.id})+'\\n');}
    }};
  `,
  );
  const child = spawn(
    process.execPath,
    ['--require', preload, path.join(__dirname, '../server.cjs')],
    {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DOC88_PORT: '18970', DOC88_DATA_DIR: directory },
    },
  );
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await exited;
    }
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('doc88-batch-test-'));
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
  const get = async (url) => (await fetch(origin + url)).json();
  const post = (url, value = {}, requestOrigin = origin) =>
    fetch(origin + url, {
      method: 'POST',
      headers: {
        Origin: requestOrigin,
        'x-doc88-request': '1',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(value),
    });
  const wait = async (url, predicate) => {
    for (let i = 0; i < 300; i++) {
      const value = await get(url);
      if (predicate(value)) return value;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw Error('Queue did not settle');
  };
  assert.equal((await get('/api/jobs/' + restored)).stage, 'interrupted');
  assert.equal((await get('/api/jobs/' + restored)).canResume, true);
  assert.equal(
    (await post('/api/batches', { queries: ['ISO 100:2020'] }, 'https://evil.test')).status,
    403,
  );
  assert.equal(
    (await post('/api/batches', { queries: new Array(31).fill('ISO 100:2020') })).status,
    400,
  );
  const created = await post('/api/batches', {
    queries: ['iso 5458 2013', 'ISO 100:2020', 'ISO 101:2020', 'ISO 999:2020'],
  });
  assert.equal(created.status, 202);
  const batch = await created.json();
  const settled = await wait(
    '/api/batches/' + batch.id,
    (b) => b.ready === 2 && b.waiting === 1 && b.resumable === 1,
  );
  assert.equal(settled.total, 4);
  const zipped = await fetch(origin + '/api/batches/' + batch.id + '/zip');
  assert.equal(zipped.status, 200);
  const zip = await JSZip.loadAsync(await zipped.arrayBuffer());
  assert.ok(zip.file('Same official title.pdf'));
  assert.ok(zip.file('Same official title (2).pdf'));
  assert.ok(zip.file('Отчёт.txt'));
  assert.equal(Object.keys(zip.files).filter((name) => name.endsWith('.pdf')).length, 2);
  assert.equal((await post('/api/batches/' + batch.id + '/resume')).status, 200);
  const waiting = settled.items.find((item) => item.stage === 'choosing');
  assert.equal(
    (await post('/api/jobs/' + waiting.id + '/edition', { reference: 'ISO 5458:2018' })).status,
    202,
  );
  await wait('/api/batches/' + batch.id, (b) => b.ready === 4);
  assert.equal((await post('/api/jobs/' + restored + '/resume')).status, 202);
  await wait('/api/jobs/' + restored, (j) => j.stage === 'done');
  const cancelling = await (
    await post('/api/batches', { queries: ['ISO 200:2020', 'ISO 201:2020', 'ISO 202:2020'] })
  ).json();
  await post('/api/batches/' + cancelling.id + '/cancel');
  const stopped = await wait('/api/batches/' + cancelling.id, (b) =>
    b.items.every((item) => item.stage === 'cancelled'),
  );
  assert.equal(stopped.ready, 0);
  assert.equal((await fetch(origin + '/api/batches/' + cancelling.id + '/zip')).status, 409);
  const events = (await fs.readFile(path.join(directory, 'events.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.ok(events.every((event) => event.running <= 1));
});
