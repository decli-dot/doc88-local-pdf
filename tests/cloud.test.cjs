const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createCloudServer } = require('../cloud-server.cjs');

async function fixture(t, run) {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'doc88-cloud-test-'));
  const port = 20000 + Math.floor(Math.random() * 10000);
  const base = `http://127.0.0.1:${port}`;
  const app = createCloudServer({ port, origin: base, data, run, ttl: 1000 });
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(port, '127.0.0.1', resolve);
  });
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    app.server.closeAllConnections();
    if (
      path.dirname(data) !== path.resolve(os.tmpdir()) ||
      !path.basename(data).startsWith('doc88-cloud-test-')
    )
      throw new Error('Invalid test cleanup path.');
    await fs.rm(data, { recursive: true, force: true });
  });
  async function request(route, cookie, method = 'GET', value, origin = app.origin) {
    return fetch(base + route, {
      method,
      headers: {
        Origin: origin,
        'x-doc88-request': '1',
        ...(cookie ? { Cookie: cookie } : {}),
        ...(value !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(value !== undefined ? { body: JSON.stringify(value) } : {}),
    });
  }
  async function session() {
    const response = await request('/api/config');
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';')[0];
  }
  return { ...app, request, session };
}
const input = { url: 'https://www.doc88.com/p-2592543989165.html', fromPage: 1, toPage: 2 };

test('cloud jobs and files stay private, reject cross-site writes, and serialize work', async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const app = await fixture(t, async (job) => {
    job.update({ stage: 'downloading', archiveReady: true });
    await gate;
    await fs.writeFile(path.join(job.directory, 'result.pdf'), '%PDF-test');
    job.update({
      stage: 'done',
      pdfReady: true,
      pdfFilename: 'Example.pdf',
      finishedAt: new Date().toISOString(),
    });
  });
  const owner = await app.session();
  const stranger = await app.session();
  assert.notEqual(owner, stranger);
  assert.equal(
    (await app.request('/api/jobs', owner, 'POST', input, 'https://foreign.test')).status,
    403,
  );
  assert.equal((await app.request('/api/jobs', owner, 'POST', null)).status, 400);
  assert.equal(
    (await app.request('/api/jobs', owner, 'POST', { ...input, url: 'http://127.0.0.1/private' }))
      .status,
    400,
  );
  assert.equal(
    (await app.request('/api/jobs', owner, 'POST', { ...input, toPage: 41 })).status,
    400,
  );
  const created = await app.request('/api/jobs', owner, 'POST', input);
  assert.equal(created.status, 202);
  const job = await created.json();
  for (const key of ['owner', 'url', 'directory', 'controller']) assert.equal(job[key], undefined);
  assert.equal((await app.request('/api/jobs', owner)).status, 404);
  assert.equal((await app.request(`/api/jobs/${job.id}`, stranger)).status, 404);
  assert.equal((await app.request(`/api/jobs/${job.id}/pdf`, stranger)).status, 404);
  assert.equal((await app.request(`/api/jobs/${job.id}/cancel`, stranger, 'POST')).status, 404);
  assert.equal((await app.request(`/api/jobs/${job.id}/zip`, owner)).status, 409);
  assert.equal((await app.request('/api/jobs', stranger, 'POST', input)).status, 409);
  release();
  for (let attempt = 0; attempt < 50 && app.jobs.get(job.id).stage !== 'done'; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  const pdf = await app.request(`/api/jobs/${job.id}/pdf`, owner);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('cache-control'), 'no-store');
  assert.equal(await pdf.text(), '%PDF-test');
  app.jobs.get(job.id).finishedAt = new Date(Date.now() - 2000).toISOString();
  assert.equal((await app.request(`/api/jobs/${job.id}/pdf`, owner)).status, 404);
  for (let attempt = 0; attempt < 50 && app.jobs.get(job.id)?.readers; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  await app.cleanup();
  assert.equal(app.jobs.size, 0);
});

test('cloud cancellation withholds partial files and releases the worker', async (t) => {
  const app = await fixture(t, async (job) => {
    job.update({ stage: 'ocr', archiveReady: true, pdfReady: true });
    await new Promise((resolve) =>
      job.controller.signal.addEventListener('abort', resolve, { once: true }),
    );
    throw new Error('aborted');
  });
  const owner = await app.session();
  const response = await app.request('/api/jobs', owner, 'POST', input);
  const job = await response.json();
  assert.equal((await app.request(`/api/jobs/${job.id}/cancel`, owner, 'POST')).status, 200);
  const stopped = await (await app.request(`/api/jobs/${job.id}`, owner)).json();
  assert.equal(stopped.stage, 'cancelled');
  assert.equal(stopped.pdfReady, false);
  assert.equal(stopped.archiveReady, false);
  assert.equal((await app.request(`/api/jobs/${job.id}/pdf`, owner)).status, 409);
  const second = await app.request('/api/jobs', owner, 'POST', input);
  assert.equal(second.status, 202);
  const next = await second.json();
  await app.request(`/api/jobs/${next.id}/cancel`, owner, 'POST');
});
