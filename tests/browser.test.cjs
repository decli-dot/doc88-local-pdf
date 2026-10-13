const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const JSZip = require('jszip');
const OCR = require('../web/ocr.js');
global.JSZip = JSZip;

function extension(storage = {}) {
  const sent = [];
  let nextTab = 10;
  const chrome = {
    storage: {
      session: {
        async get(key) {
          return { [key]: structuredClone(storage[key]) };
        },
        async set(value) {
          Object.assign(storage, structuredClone(value));
        },
        async remove(key) {
          delete storage[key];
        },
      },
    },
    tabs: {
      async create(options) {
        sent.push({ create: options });
        return { id: nextTab++ };
      },
      async sendMessage(tab, message) {
        sent.push({ tab, message });
        return { ok: true };
      },
      async update() {},
      async remove() {},
      onRemoved: { addListener() {} },
    },
    runtime: {
      getManifest: () => ({
        version: '1.2.0',
        homepage_url: 'https://decli-dot.github.io/doc88-local-pdf/',
      }),
      onMessage: { addListener() {} },
      onInstalled: { addListener() {} },
    },
    action: { onClicked: { addListener() {} } },
  };
  const context = vm.createContext({
    chrome,
    crypto: { randomUUID },
    URL,
    setTimeout,
    clearTimeout,
    console,
  });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf8'),
    context,
  );
  const source = { frameId: 0, tab: { id: 1 }, url: 'https://www.doc88.com/p-123.html' };
  const target = (id) => ({
    frameId: 0,
    tab: { id },
    url: 'https://decli-dot.github.io/doc88-local-pdf/',
  });
  const send = (type, sender, extra = {}) =>
    context.handle({ channel: 'DOC88_PDF', type, ...extra }, sender);
  return { context, storage, sent, source, target, send };
}
test('extension owns one job, authenticates both tabs, and preserves state after worker restart', async () => {
  let app = extension();
  const results = await Promise.allSettled([
    app.send('START_DOC88', app.source),
    app.send('START_DOC88', app.source),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const job = app.storage.job;
  const target = app.target(job.targetTab);
  await assert.rejects(
    app.send(
      'READY',
      { ...target, url: 'https://decli-dot.github.io/other-project/' },
      { id: job.id },
    ),
  );
  await assert.rejects(app.send('READY', { ...target, frameId: 1 }, { id: job.id }));
  await app.send('READY', target, { id: job.id });
  await app.send('CAPTURE_META', app.source, { id: job.id, total: 2, title: 'Example' });
  await assert.rejects(
    app.send('CAPTURE_PAGE', app.source, {
      id: job.id,
      index: 1,
      image: 'data:image/jpeg;base64,/9j/',
    }),
  );
  await assert.rejects(app.send('CAPTURE_DONE', app.source, { id: job.id }));
  await app.send('CAPTURE_PAGE', app.source, {
    id: job.id,
    index: 0,
    image: 'data:image/jpeg;base64,/9j/',
  });
  // MV3 suspends and reconstructs background.js; session metadata must survive.
  app = extension(app.storage);
  await app.send('CAPTURE_PAGE', app.source, {
    id: job.id,
    index: 1,
    image: 'data:image/jpeg;base64,/9j/',
  });
  await app.send('CAPTURE_DONE', app.source, { id: job.id });
  assert.equal(app.storage.job.phase, 'ocr');
  await app.send('FINISH', target, { id: job.id });
  assert.equal(app.storage.job, undefined);
  await app.send('START_DOC88', app.source);
  const cancelled = app.storage.job;
  await app.send('CANCEL', app.source, { id: cancelled.id });
  assert.equal(app.storage.job, undefined);
});
test('browser ZIP processing orders pages naturally and rejects invalid or oversized images', async () => {
  const signal = new AbortController().signal;
  const png = fs.readFileSync(path.join(__dirname, 'fixtures/fixture-1.png'));
  const jpg = Buffer.from([255, 216, 255, 1]);
  const zip = new JSZip();
  zip.file('page10.png', png);
  zip.file('page2.jpg', jpg);
  zip.file('__MACOSX/page1.png', png);
  const images = await OCR.unpackZip(
    new Blob([await zip.generateAsync({ type: 'uint8array' })]),
    signal,
  );
  assert.equal(images.length, 2);
  assert.equal(images[0].type, 'image/jpeg');
  assert.equal(images[1].type, 'image/png');
  const invalid = new JSZip();
  invalid.file('page1.jpg', 'not an image');
  await assert.rejects(
    OCR.unpackZip(new Blob([await invalid.generateAsync({ type: 'uint8array' })]), signal),
  );
  await assert.rejects(OCR.unpackZip({ size: 251 * 1024 * 1024 }, signal));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(OCR.unpackZip(new Blob([png]), controller.signal), /остановлена/);
});
