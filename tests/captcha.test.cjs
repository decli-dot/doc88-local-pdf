'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createCaptchaService } = require('../captcha-service.cjs');
const { createBrowserCaptchaSolver } = require('../captcha-browser.cjs');
const KEY = '0123456789abcdef0123456789abcdef';
async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'declipdf-captcha-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const calls = [];
  const service = await createCaptchaService(dir, {
    sleep: async () => {},
    fetchImpl: async (url, init) => {
      const input = JSON.parse(init.body);
      calls.push({ method: url.split('/').pop(), input });
      assert.equal(input.clientKey, KEY);
      assert.equal(init.redirect, 'error');
      return {
        ok: true,
        json: async () =>
          input.task
            ? { errorId: 0, taskId: calls.length }
            : input.taskId
              ? { errorId: 0, status: 'ready', solution: { text: 'abc123' }, cost: '0.01' }
              : { errorId: 0, balance: 150 },
      };
    },
    ...options,
  });
  await service.update({ enabled: true, apiKey: KEY });
  return { dir, calls, service };
}
const task = { type: 'ImageToTextTask', body: 'TEST_IMAGE' };
test('captcha settings and free balance never expose keys or reserve a paid task', async (t) => {
  const { dir, calls, service } = await fixture(t);
  const result = await service.balance();
  assert.equal(result.balance, 150);
  assert.equal(result.attemptsToday, 0);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(KEY));
  assert.deepEqual(
    calls.map((c) => c.method),
    ['getBalance'],
  );
  await assert.rejects(service.update({ maxPerDay: 0 }));
  await assert.rejects(service.update({ enabled: 'true' }));
  await assert.rejects(service.update({ apiKey: 'short' }));
  assert.equal((await service.update({ enabled: false })).configured, true);
  await assert.rejects(service.solve('job', task), { code: 'CAPTCHA_DISABLED' });
  await service.update({ apiKey: '' });
  assert.equal(service.summary().configured, false);
  const stored = JSON.parse(await fs.readFile(path.join(dir, 'captcha-settings.json')));
  assert.equal(stored.apiKey, '');
});
test('paid reservations survive resumes, deduplicate images and enforce job and daily limits', async (t) => {
  const { dir, service, calls } = await fixture(t);
  await service.update({ maxPerJob: 1, maxPerDay: 2 });
  const answer = await service.solve('one', task, { fingerprint: 'first' });
  await service.finish(answer.id, 'passed');
  assert.equal(answer.solution.text, 'abc123');
  await assert.rejects(service.solve('one', task, { fingerprint: 'first' }), {
    code: 'CAPTCHA_ALREADY_ATTEMPTED',
  });
  await assert.rejects(service.solve('one', task, { fingerprint: 'second' }), {
    code: 'CAPTCHA_ATTEMPT_LIMIT',
  });
  await service.solve('two', task, { fingerprint: 'another' });
  await assert.rejects(service.solve('three', task), { code: 'CAPTCHA_ATTEMPT_LIMIT' });
  assert.equal(calls.filter((c) => c.method === 'createTask').length, 2);
  const reloaded = await createCaptchaService(dir);
  await assert.rejects(reloaded.solve('one', task, { fingerprint: 'first' }), {
    code: 'CAPTCHA_ALREADY_ATTEMPTED',
  });
  const ledger = await fs.readFile(path.join(dir, 'captcha-usage.json'), 'utf8');
  assert.doesNotMatch(ledger, /0123456789abcdef|TEST_IMAGE|abc123|clientKey|solution/);
  assert.equal(reloaded.summary().recent[0].status, 'passed');
});
test('uncertain paid request is reserved once and provider messages cannot echo secrets', async (t) => {
  let calls = 0;
  const { dir, service } = await fixture(t, {
    fetchImpl: async () => {
      calls++;
      throw Error(KEY + ' network failure');
    },
  });
  await assert.rejects(service.solve('one', task, { fingerprint: 'a' }), {
    code: 'CAPTCHA_SERVICE_CONNECTION',
  });
  await assert.rejects(service.solve('one', task, { fingerprint: 'a' }), {
    code: 'CAPTCHA_ALREADY_ATTEMPTED',
  });
  assert.equal(calls, 1);
  assert.equal(service.summary().attemptsToday, 1);
  assert.doesNotMatch(
    await fs.readFile(path.join(dir, 'captcha-usage.json'), 'utf8'),
    new RegExp(KEY),
  );
});
test('concurrent paid attempts cannot exceed the daily limit', async (t) => {
  const { service, calls } = await fixture(t);
  await service.update({ maxPerDay: 1 });
  const values = await Promise.allSettled([service.solve('one', task), service.solve('two', task)]);
  assert.equal(values.filter((v) => v.status === 'fulfilled').length, 1);
  assert.equal(calls.filter((c) => c.method === 'createTask').length, 1);
});
test('cancellation stops polling without another paid submission', async (t) => {
  const controller = new AbortController();
  const { service, calls } = await fixture(t, {
    sleep: async (_, __, { signal }) => {
      controller.abort();
      signal.throwIfAborted();
    },
  });
  await assert.rejects(service.solve('one', task, { signal: controller.signal }), {
    name: 'AbortError',
  });
  assert.deepEqual(
    calls.map((c) => c.method),
    ['createTask'],
  );
  assert.equal(service.summary().recent[0].code, 'CAPTCHA_CANCELLED');
});
test('browser adapter submits only the provider answer and unknown challenges stay manual', async (t) => {
  const { service, calls } = await fixture(t);
  const { chromium } = require('playwright');
  const { createCanvas } = require('@napi-rs/canvas');
  const canvas = createCanvas(180, 80),
    ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, 180, 80);
  ctx.fillStyle = 'black';
  ctx.font = '28px Arial';
  ctx.fillText('abc123', 10, 45);
  const src = canvas.toDataURL('image/png');
  const browser = await chromium.launch({
    channel: require('../runtime.cjs').browserChannel(),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(
    '<title>DDOS-GUARD</title><iframe id="ddg-iframe" style="width:400px;height:500px"></iframe>',
  );
  const frame = await (await page.$('#ddg-iframe')).contentFrame();
  await frame.setContent(
    `<img class="ddg-modal__captcha-image" src="${src}"><input class="ddg-modal__input"><button class="ddg-modal__submit" onclick="if(document.querySelector('input').value==='abc123'){parent.document.title='Search';parent.document.body.innerHTML='<main>RESULTS 1-1</main>'}">Submit</button>`,
  );
  const job = {
    id: 'browser',
    controller: new AbortController(),
    update(v) {
      Object.assign(this, v);
    },
  };
  const solve = createBrowserCaptchaSolver(service, job, { sleep: async () => {} });
  assert.equal(
    await solve({ page, allowed: (u) => u === 'about:blank' }),
    true,
    JSON.stringify(job.captchaDiagnostics),
  );
  assert.equal(await page.title(), 'Search');
  assert.equal(job.captchaSolving, false);
  assert.equal(job.captchaDiagnostics.status, 'passed');
  assert.equal(calls[0].input.task.type, 'ImageToTextTask');
  assert.match(calls[0].input.task.body, /^iVBOR/);
  assert.equal(calls[0].input.task.websiteURL, undefined);
  const retryPage = await browser.newPage();
  await retryPage.setContent(
    '<title>DDOS-GUARD</title><iframe id="ddg-iframe" style="width:400px;height:500px"></iframe>',
  );
  const retryFrame = await (await retryPage.$('#ddg-iframe')).contentFrame();
  await retryFrame.setContent(`<img class="ddg-modal__captcha-image" src="${src}"><input class="ddg-modal__input"><p class="ddg-modal__error"></p>
    <button class="ddg-modal__submit" onclick="if(window.refreshed){parent.document.title='Search';parent.document.body.innerHTML='<main>RESULTS</main>'}else{document.querySelector('p').textContent='Incorrect text'}">Submit</button>
    <button class="ddg-modal__refresh" onclick="window.refreshed=true;document.querySelector('p').textContent='';document.querySelector('img').style.opacity='0.5'">Refresh</button>`);
  const retryJob = { ...job, id: 'retry', captchaSolving: false };
  const retrySolve = createBrowserCaptchaSolver(service, retryJob, { sleep: async () => {} });
  assert.equal(await retrySolve({ page: retryPage, allowed: () => true }), true);
  assert.equal(retryJob.captchaDiagnostics.status, 'retrying');
  assert.equal(await retrySolve({ page: retryPage, allowed: () => true }), true);
  assert.equal(retryJob.captchaDiagnostics.status, 'passed');
  assert.equal(calls.filter((c) => c.method === 'createTask').length, 3);
  const stalePage = await browser.newPage();
  await stalePage.setContent(
    '<title>DDOS-GUARD</title><iframe id="ddg-iframe" style="width:400px;height:500px"></iframe>',
  );
  const staleFrame = await (await stalePage.$('#ddg-iframe')).contentFrame();
  await staleFrame.setContent(
    `<img class="ddg-modal__captcha-image" src="${src}"><input class="ddg-modal__input"><button class="ddg-modal__submit">Submit</button>`,
  );
  const finished = [];
  const staleJob = { ...job, id: 'stale', captchaSolving: false };
  const staleSolve = createBrowserCaptchaSolver(
    {
      summary: () => ({ enabled: true, configured: true }),
      solve: async () => {
        await staleFrame.locator('img').evaluate((img) => (img.style.opacity = '0.5'));
        return { id: 'changed', solution: { text: 'abc123' } };
      },
      finish: async (id, status) => finished.push({ id, status }),
    },
    staleJob,
  );
  assert.equal(await staleSolve({ page: stalePage, allowed: () => true }), true);
  assert.equal(staleJob.captchaDiagnostics.status, 'retrying');
  assert.equal(await staleFrame.locator('input').inputValue(), '');
  assert.deepEqual(finished, [{ id: 'changed', status: 'stale' }]);
  const count = calls.length;
  const unknown = await browser.newPage();
  await unknown.setContent('<title>Unsupported verification</title><input type="password">');
  assert.equal(await solve({ page: unknown, allowed: () => true }), false);
  assert.equal(calls.length, count);
  assert.equal(await solve({ page: unknown, allowed: () => false }), false);
});

test('unlimited configuration removes job and day quotas while retaining the submission ledger', async (t) => {
  const { service, calls } = await fixture(t);
  await service.update({ maxPerJob: null, maxPerDay: null });
  for (let i = 0; i < 12; i++)
    await service.solve('unlimited', task, { fingerprint: 'unique-' + i });
  assert.equal(calls.filter((c) => c.method === 'createTask').length, 12);
  assert.equal(service.summary().attemptsToday, 12);
  assert.equal(service.summary().maxPerDay, null);
  assert.equal(service.summary().maxPerJob, null);
});

test('temporary result-poll errors keep the same paid task and do not leak numeric timeout codes', async (t) => {
  const methods = [];
  let polls = 0;
  const { service, dir } = await fixture(t, {
    fetchImpl: async (url, init) => {
      const method = url.split('/').pop(),
        input = JSON.parse(init.body);
      methods.push(method);
      if (method === 'createTask')
        return { ok: true, json: async () => ({ errorId: 0, taskId: 12345 }) };
      assert.equal(input.taskId, 12345);
      if (++polls === 1) throw new DOMException('Timed out', 'TimeoutError');
      if (polls === 2) return { ok: false, status: 503 };
      return {
        ok: true,
        json: async () => ({
          errorId: 0,
          status: 'ready',
          solution: { text: 'safe123' },
          cost: '0.01',
        }),
      };
    },
  });
  const answer = await service.solve('retry-poll', task, { fingerprint: 'same-image' });
  assert.equal(answer.solution.text, 'safe123');
  assert.deepEqual(methods, ['createTask', 'getTaskResult', 'getTaskResult', 'getTaskResult']);
  assert.equal(service.summary().attemptsToday, 1);
  const ledger = JSON.parse(await fs.readFile(path.join(dir, 'captcha-usage.json')));
  assert.equal(ledger.attempts[0].taskId, 12345);
  assert.equal(ledger.attempts[0].pollRetries, 2);
  assert.equal(ledger.attempts[0].status, 'answered');
});

test('repeated result-poll failures are bounded and never create another paid task', async (t) => {
  const methods = [];
  const { service } = await fixture(t, {
    fetchImpl: async (url) => {
      const method = url.split('/').pop();
      methods.push(method);
      if (method === 'createTask')
        return { ok: true, json: async () => ({ errorId: 0, taskId: 9 }) };
      throw new DOMException('Timed out', 'TimeoutError');
    },
  });
  await assert.rejects(service.solve('poll-down', task), { code: 'CAPTCHA_SERVICE_TIMEOUT' });
  assert.equal(methods.filter((m) => m === 'createTask').length, 1);
  assert.equal(methods.filter((m) => m === 'getTaskResult').length, 4);
  assert.equal(service.summary().recent[0].code, 'CAPTCHA_SERVICE_TIMEOUT');
});

test('a title change cannot confirm access while the captcha frame is still visible', async (t) => {
  const { service } = await fixture(t);
  const { chromium } = require('playwright'),
    { createCanvas } = require('@napi-rs/canvas');
  const browser = await chromium.launch({
    channel: require('../runtime.cjs').browserChannel(),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(
    '<title>DDOS-GUARD</title><iframe id="ddg-iframe" style="width:400px;height:500px"></iframe>',
  );
  const frame = await (await page.$('#ddg-iframe')).contentFrame(),
    src = createCanvas(180, 80).toDataURL('image/png');
  await frame.setContent(
    `<img class="ddg-modal__captcha-image" src="${src}"><input class="ddg-modal__input"><button class="ddg-modal__submit" onclick="parent.document.title='Search'">Submit</button>`,
  );
  const job = {
    id: 'title-only',
    controller: new AbortController(),
    update(v) {
      Object.assign(this, v);
    },
  };
  const solve = createBrowserCaptchaSolver(service, job, { sleep: async () => {} });
  assert.equal(await solve({ page, allowed: () => true }), false);
  assert.equal(job.captchaDiagnostics.status, 'manual');
  assert.equal(service.summary().recent[0].status, 'unconfirmed');
});

test('a refreshed challenge after submission is recognized even without an error label', async (t) => {
  const { service, calls } = await fixture(t);
  const { chromium } = require('playwright'),
    { createCanvas } = require('@napi-rs/canvas');
  const first = createCanvas(180, 80),
    second = createCanvas(180, 80);
  second.getContext('2d').fillRect(0, 0, 30, 30);
  const browser = await chromium.launch({
    channel: require('../runtime.cjs').browserChannel(),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(
    '<title>DDOS-GUARD</title><iframe id="ddg-iframe" style="width:400px;height:500px"></iframe>',
  );
  const frame = await (await page.$('#ddg-iframe')).contentFrame();
  await frame.setContent(
    `<img class="ddg-modal__captcha-image" src="${first.toDataURL('image/png')}"><input class="ddg-modal__input"><button class="ddg-modal__submit" onclick="if(window.renewed){parent.document.title='Search';parent.document.body.innerHTML='<main>RESULTS</main>'}else{window.renewed=true;document.querySelector('img').src='${second.toDataURL('image/png')}';document.querySelector('input').value=''}">Submit</button>`,
  );
  const job = {
    id: 'renewed',
    controller: new AbortController(),
    update(value) {
      Object.assign(this, value);
    },
  };
  const solve = createBrowserCaptchaSolver(service, job, { sleep: async () => {} });
  assert.equal(await solve({ page, allowed: () => true }), true);
  assert.equal(job.captchaDiagnostics.code, 'CAPTCHA_REFRESHED');
  assert.equal(service.summary().recent[0].status, 'unconfirmed');
  assert.equal(await solve({ page, allowed: () => true }), true);
  assert.equal(job.captchaDiagnostics.status, 'passed');
  assert.equal(calls.filter((c) => c.method === 'createTask').length, 2);
});
