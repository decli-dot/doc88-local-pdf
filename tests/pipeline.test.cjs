const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { dependency } = require('../runtime.cjs');
const {
  validateURL,
  validateRange,
  unpackArchive,
  convertArchive,
  nativeAvailable,
} = require('../pipeline.cjs');
const JSZip = dependency('jszip');
const { PDFDocument } = dependency('pdf-lib');
const fixture = (name) => fs.readFile(path.join(__dirname, 'fixtures', name));

function jobAt(directory, extras = {}) {
  return {
    directory,
    title: 'English integration test',
    url: null,
    total: 0,
    controller: new AbortController(),
    update(changes) {
      Object.assign(this, changes);
    },
    log() {},
    ...extras,
  };
}
async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'doc88-app-test-'));
  t.after(async () => {
    const absolute = path.resolve(directory);
    assert.equal(path.dirname(absolute), path.resolve(os.tmpdir()));
    assert.ok(path.basename(absolute).startsWith('doc88-app-test-'));
    await fs.rm(absolute, { recursive: true, force: true });
  });
  return directory;
}

test('only document URLs are accepted and numeric ranges are validated', () => {
  assert.equal(
    validateURL('http://www.doc88.com/p-123.html?x=1#top'),
    'https://www.doc88.com/p-123.html',
  );
  for (const url of [
    'https://evil.com/p-123.html',
    'file:///etc/passwd',
    'https://doc88.com.evil.com/p-123.html',
    'https://user:pass@doc88.com/p-123.html',
    'https://www.doc88.com/',
    'http://127.0.0.1/p-123.html',
    'https://www.doc88.com:8000/p-123.html',
  ])
    assert.throws(() => validateURL(url));
  assert.deepEqual(validateRange('1', ''), { fromPage: 1, toPage: null });
  for (const range of [
    [0, 2],
    [3, 2],
    [1.5, 3],
    [1, 'word'],
  ])
    assert.throws(() => validateRange(...range));
});

test('real OCR retains page images, natural order, landscape page, blank page', async (t) => {
  const directory = await temporary(t);
  const zip = new JSZip();
  zip.file('page010.png', await fixture('fixture-3.png'));
  zip.file('page002.png', await fixture('fixture-2.png'));
  zip.file('page001.png', await fixture('fixture-1.png'));
  await fs.writeFile(
    path.join(directory, 'archive.zip'),
    await zip.generateAsync({ type: 'nodebuffer' }),
  );
  const job = jobAt(directory);
  await convertArchive(job);
  assert.equal(job.stage, 'done');
  assert.equal(job.total, 3);
  assert.equal(job.blankPages, 1);
  assert.ok(job.textChars > 100);
  const pdf = await PDFDocument.load(await fs.readFile(path.join(directory, 'result.pdf')));
  assert.equal(pdf.getPageCount(), 3);
  const pages = pdf.getPages();
  assert.ok(pages[0].getWidth() < pages[0].getHeight());
  assert.ok(pages[1].getWidth() > pages[1].getHeight());
  for (const page of pages)
    assert.ok(
      page.node.Resources().lookup(dependency('pdf-lib').PDFName.of('XObject')).keys().length > 0,
    );
  if (nativeAvailable) {
    assert.match(await fs.readFile(path.join(directory, 'ocr/page00001.txt'), 'utf8'), /24680/);
    assert.match(await fs.readFile(path.join(directory, 'ocr/page00002.txt'), 'utf8'), /13579/);
  }
});

test('bad archives and missing downloaded pages cannot produce a PDF', async (t) => {
  const directory = await temporary(t);
  for (const entries of [{ 'notes.txt': 'text' }, { 'page001.jpg': 'not an image' }]) {
    const zip = new JSZip();
    for (const [name, data] of Object.entries(entries)) zip.file(name, data);
    await fs.writeFile(
      path.join(directory, 'archive.zip'),
      await zip.generateAsync({ type: 'nodebuffer' }),
    );
    await assert.rejects(unpackArchive(jobAt(directory)));
  }
  const zip = new JSZip();
  zip.file('page001.png', await fixture('fixture-1.png'));
  await fs.writeFile(
    path.join(directory, 'archive.zip'),
    await zip.generateAsync({ type: 'nodebuffer' }),
  );
  await assert.rejects(
    convertArchive(jobAt(directory, { url: 'https://www.doc88.com/p-1.html', total: 2 })),
    /ожидалось 2/,
  );
  await assert.rejects(fs.stat(path.join(directory, 'result.pdf')));
});

test('cancellation never exposes an incomplete result', async (t) => {
  const directory = await temporary(t);
  const zip = new JSZip();
  zip.file('page001.png', await fixture('fixture-1.png'));
  await fs.writeFile(
    path.join(directory, 'archive.zip'),
    await zip.generateAsync({ type: 'nodebuffer' }),
  );
  const job = jobAt(directory);
  job.controller.abort();
  await assert.rejects(convertArchive(job), /остановлена/);
  assert.notEqual(job.pdfReady, true);
  await assert.rejects(fs.stat(path.join(directory, 'result.pdf')));
});

test('local API accepts ZIP, creates a downloadable searchable PDF, rejects foreign origins', async (t) => {
  const directory = await temporary(t);
  const port = 18968;
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(__dirname, '../server.cjs')], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DOC88_PORT: String(port),
      DOC88_DATA_DIR: directory,
      DOC88_OCR_ENGINE: 'wasm',
    },
  });
  t.after(() => child.kill());
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server did not start')), 15000);
    child.stdout.on('data', (bytes) => {
      if (bytes.toString().includes('DOC88_READY')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code) reject(new Error('Server exited: ' + code));
    });
  });
  assert.equal(
    (
      await fetch(origin + '/api/jobs', {
        method: 'POST',
        headers: { Origin: 'https://evil.com', 'Content-Type': 'application/json' },
        body: '{}',
      })
    ).status,
    403,
  );
  const zip = new JSZip();
  zip.file('page001.png', await fixture('fixture-1.png'));
  const response = await fetch(origin + '/api/upload', {
    method: 'POST',
    headers: {
      Origin: origin,
      'x-doc88-request': '1',
      'Content-Type': 'application/zip',
      'x-filename': encodeURIComponent('Тест английского OCR.zip'),
    },
    body: await zip.generateAsync({ type: 'nodebuffer' }),
  });
  assert.equal(response.status, 202);
  let job = await response.json();
  for (let i = 0; i < 450 && !['done', 'error'].includes(job.stage); i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    job = await (await fetch(origin + '/api/jobs/' + job.id)).json();
  }
  assert.equal(job.stage, 'done', job.message);
  assert.equal(job.pdfReady, true);
  assert.equal(job.total, 1);
  const download = await fetch(origin + '/api/jobs/' + job.id + '/pdf');
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition'), /filename\*=UTF-8/);
  const pdf = await PDFDocument.load(await download.arrayBuffer());
  assert.equal(pdf.getPageCount(), 1);
  assert.equal((await fetch(origin + '/api/jobs/' + job.id + '/zip')).status, 200);

  const upload = async () =>
    fetch(origin + '/api/upload', {
      method: 'POST',
      headers: { Origin: origin, 'x-doc88-request': '1', 'Content-Type': 'application/zip' },
      body: await zip.generateAsync({ type: 'nodebuffer' }),
    });
  const waitForJob = async (id, condition) => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const current = await (await fetch(origin + '/api/jobs/' + id)).json();
      if (condition(current)) return current;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Job did not reach the expected state.');
  };
  const waitIdle = async () => {
    for (let i = 0; i < 300; i++) {
      const state = await (await fetch(origin + '/api/status')).json();
      if (!state.activeId) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Cancelled job did not release the processing slot.');
  };
  const cancel = async (id) =>
    fetch(origin + '/api/jobs/' + id + '/cancel', {
      method: 'POST',
      headers: { Origin: origin, 'x-doc88-request': '1' },
    });

  await t.test('simultaneous uploads reserve only one processing slot', async () => {
    await waitIdle();
    const responses = await Promise.all([upload(), upload()]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [202, 409]);
    const started = await responses.find((response) => response.status === 202).json();
    await cancel(started.id);
    const stopped = await waitForJob(started.id, (value) => value.stage === 'cancelled');
    assert.equal(stopped.pdfReady, false);
    await waitIdle();
  });

  await t.test('cancelling an active WebAssembly recognition releases the slot', async () => {
    const started = await (await upload()).json();
    await waitForJob(started.id, (value) =>
      value.message.startsWith('Распознаём английский текст:'),
    );
    await cancel(started.id);
    const stopped = await waitForJob(started.id, (value) => value.stage === 'cancelled');
    assert.equal(stopped.pdfReady, false);
    assert.equal((await fetch(origin + '/api/jobs/' + started.id + '/pdf')).status, 409);
    await waitIdle();
  });
  await fetch(origin + '/api/shutdown', {
    method: 'POST',
    headers: { Origin: origin, 'x-doc88-request': '1' },
  });
  await new Promise((resolve) => child.on('exit', resolve));
});
