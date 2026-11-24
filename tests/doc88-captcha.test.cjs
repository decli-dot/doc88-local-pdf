'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { dragTarget, createDoc88CaptchaSolver } = require('../doc88-captcha.cjs');
const { createBrowserCaptchaSolver } = require('../captcha-browser.cjs');

test('puzzle coordinates map to the handle travel and invalid/unrelated points cannot move it', () => {
  const state = {
    background: { x: 200, y: 200, width: 270, height: 100 },
    piece: { x: 202, y: 232, width: 36, height: 36 },
    bar: { x: 200, y: 320, width: 270, height: 36 },
    button: { x: 202, y: 320, width: 36, height: 36 },
  };
  const points = [{ x: 188, y: 50 }];
  assert.deepEqual(dragTarget(state, points, { width: 270, height: 100 }), { x: 388, y: 338 });
  assert.deepEqual(
    dragTarget(
      state,
      points.map((p) => ({ x: p.x * 2, y: p.y * 2 })),
      { width: 540, height: 200 },
    ),
    { x: 388, y: 338 },
  );
  for (const wrong of [
    [points[0], points[0]],
    [{ x: Infinity, y: 50 }],
    [{ x: 999, y: 50 }],
    [],
    [{ x: 20, y: 50 }],
    [{ x: 188, y: 99 }],
  ])
    assert.throws(() => dragTarget(state, wrong, { width: 270, height: 100 }));
});

async function fixture(t, { variant = 'puzzle' } = {}) {
  const { chromium } = require('playwright');
  const { createCanvas } = require('@napi-rs/canvas');
  const canvas = createCanvas(270, 136),
    g = canvas.getContext('2d');
  g.fillStyle = '#83b6df';
  g.fillRect(0, 0, 270, 100);
  if (variant === 'shapes') {
    const triangle = (x, y) => {
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + 36, y);
      g.lineTo(x + 18, y + 36);
      g.closePath();
    };
    g.strokeStyle = '#eff5f9';
    g.lineWidth = 2;
    triangle(170, 32);
    g.stroke();
    g.strokeRect(230, 32, 36, 36);
    g.fillStyle = '#b95b22';
    triangle(0, 100);
    g.fill();
  } else {
    g.fillStyle = '#eff5f9';
    g.fillRect(170, 32, 36, 36);
    g.fillStyle = '#334d66';
    g.fillRect(0, 100, 36, 36);
  }
  const png = canvas.toBuffer('image/png');
  const browser = await chromium.launch({
    channel: require('../runtime.cjs').browserChannel(),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 1,
  });
  const url = 'https://www.doc88.com/p-123456.html';
  await page.route('https://www.doc88.com/**', (route) => {
    if (new URL(route.request().url()).pathname === '/api.php')
      return route.fulfill({ contentType: 'image/png', body: png });
    return route.fulfill({
      contentType: 'text/html',
      body: `<style>
   #captcha_reading{position:absolute;left:200px;top:200px;width:270px;height:160px}
   .safefixed{display:${variant === 'shapes' ? 'block' : 'none'}}.safe-bg{position:absolute;left:0;top:0;width:270px;height:100px;background:url('/api.php?act=verify_img&v=fixture${variant === 'shapes' ? '&reader_shape=1' : ''}')}
   .safe-captcha{position:absolute;left:0;top:32px;width:36px;height:36px;background:url('/api.php?act=verify_img&v=fixture${variant === 'shapes' ? '&reader_shape=1' : ''}') 0 -100px}
   .scale{position:absolute;left:0;top:120px;width:270px;height:36px;background:#ddd}.scale>span{position:absolute;left:0;top:0;width:36px;height:36px;background:#456}
   </style><div id="captcha_reading"><div class="safefixed ${variant === 'shapes' ? 'read-shape-board' : ''}"><div class="safe-bg"></div><div class="safe-captcha"></div></div><div id="bar_fixture" class="scale"><span id="btn_fixture"></span></div></div>
   <script>let origin,left=0;window.down=false;window.downCount=0;window.moveCount=0;window.positions=[];document.querySelector('.scale>span').onmousedown=e=>{window.downCount++;origin=e.clientX-left;window.down=true;document.querySelector('.safefixed').style.display='block'};
   document.onmousemove=e=>{window.moveCount++;if(!window.down)return;left=Math.max(0,Math.min(234,e.clientX-origin));window.positions.push(left);document.querySelector('.scale>span').style.left=left+'px';document.querySelector('.safe-captcha').style.left=left+'px'};
   document.onmouseup=()=>{if(!window.down)return;window.down=false;if(Math.abs(left-170)<1){document.getElementById('captcha_reading').style.display='none';document.body.insertAdjacentHTML('beforeend','<canvas id="page_1"></canvas>')}};
   window.Map=class LegacyMap{};</script>`,
    });
  });
  await page.goto(url);
  const cdp = await page.context().newCDPSession(page);
  const evaluate = async (expression, awaitPromise = false) => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw Error(r.exceptionDetails.text);
    return r.result.value;
  };
  const job = {
    id: 'doc88',
    controller: new AbortController(),
    update(value) {
      Object.assign(this, value);
    },
  };
  const finished = [],
    submitted = [];
  let respond = async () => ({
    id: 'fixture-answer',
    solution: {
      coordinates: [{ x: 564, y: 150 }],
    },
  });
  const service = {
    summary: () => ({ enabled: true, configured: true }),
    solve: async (id, task, options) => {
      assert.equal(
        await evaluate('window.down'),
        false,
        'the pointer is released while waiting for the provider',
      );
      assert.ok(
        await evaluate('window.moveCount > 0'),
        'the visible handle receives normal pointer entry before provider waiting',
      );
      submitted.push({ id, task, options });
      return respond();
    },
    finish: async (...args) => finished.push(args),
  };
  return {
    page,
    cdp,
    evaluate,
    job,
    service,
    finished,
    submitted,
    setRespond: (f) => (respond = f),
    options: { page, cdp, evaluate, allowed: (value) => value === url },
  };
}

test('Doc88 public widget is solved from provider points even when the page replaces Map', async (t) => {
  const f = await fixture(t);
  const solve = createBrowserCaptchaSolver(f.service, f.job, { sleep: async () => {} });
  assert.equal(await solve(f.options), true);
  assert.equal(f.job.captchaDiagnostics.type, 'doc88-slider');
  assert.equal(f.job.captchaDiagnostics.status, 'passed');
  assert.equal(f.job.captchaSolving, false);
  assert.equal(await f.evaluate('Boolean(document.getElementById("page_1"))'), true);
  assert.equal(await f.evaluate('window.down'), false);
  assert.equal(f.submitted.length, 1);
  assert.equal(f.submitted[0].task.type, 'CoordinatesTask');
  assert.equal(f.submitted[0].task.minClicks, 1);
  assert.match(f.submitted[0].task.comment, /WHITE/);
  const meta = await require('sharp')(Buffer.from(f.submitted[0].task.body, 'base64')).metadata();
  assert.equal(meta.width, 810);
  assert.equal(meta.height, 300);
  assert.equal(f.finished.at(-1)[1], 'passed');
});

test('the visible shape-matching board requests the matching outline and skips the opening press', async (t) => {
  const f = await fixture(t, { variant: 'shapes' });
  assert.equal(
    await createBrowserCaptchaSolver(f.service, f.job, { sleep: async () => {} })(f.options),
    true,
  );
  assert.equal(f.job.captchaDiagnostics.variant, 'shapes');
  assert.equal(f.job.captchaDiagnostics.status, 'passed');
  assert.equal(f.submitted.length, 1);
  assert.equal(f.submitted[0].task.maxClicks, 1);
  assert.match(f.submitted[0].task.comment, /FILLED movable shape.*LEFT/);
  assert.match(f.submitted[0].task.comment, /OUTLINE.*SAME shape, size and orientation/);
  assert.equal(await f.evaluate('window.downCount'), 1);
  assert.equal(await f.evaluate('window.down'), false);
  assert.equal(f.finished.at(-1)[1], 'passed');
});

test('cancelling Doc88 solving releases the mouse and does not submit a drag result', async (t) => {
  const f = await fixture(t);
  f.setRespond(async () => {
    f.job.controller.abort();
    return {
      id: 'cancelled-answer',
      solution: {
        coordinates: [{ x: 564, y: 150 }],
      },
    };
  });
  await assert.rejects(
    createDoc88CaptchaSolver(f.service, f.job, { sleep: async () => {} })(f.options),
    { name: 'AbortError' },
  );
  assert.equal(await f.evaluate('window.down'), false);
  assert.equal(await f.evaluate('Boolean(document.getElementById("page_1"))'), false);
  assert.equal(f.finished.at(-1)[1], 'cancelled');
  assert.equal(f.job.captchaSolving, false);
});

test('closing a downloader during the actual drag releases its pointer without aborting the parent job', async (t) => {
  const f = await fixture(t),
    operation = new AbortController();
  let moves = 0;
  await assert.rejects(
    createDoc88CaptchaSolver(f.service, f.job, {
      sleep: async (ms) => {
        if (ms === 20 && ++moves === 3) operation.abort();
      },
    })({ ...f.options, signal: operation.signal }),
    { name: 'AbortError' },
  );
  assert.equal(f.job.controller.signal.aborted, false);
  assert.equal(await f.evaluate('window.down'), false);
  assert.equal(await f.evaluate('Boolean(document.getElementById("page_1"))'), false);
  assert.equal(f.finished.at(-1)[1], 'cancelled');
});

test('changed pictures, malformed provider points and changed page scopes stop before dragging', async (t) => {
  for (const variant of ['stale', 'invalid', 'scope'])
    await t.test(variant, async (t) => {
      const f = await fixture(t);
      if (variant === 'scope') f.options.allowed = () => false;
      f.setRespond(async () => {
        if (variant === 'stale')
          await f.evaluate(
            `document.querySelector('.safe-bg').style.backgroundImage='url("/api.php?act=verify_img&v=changed")'`,
          );
        return {
          id: 'rejected-answer',
          solution: {
            coordinates: variant === 'invalid' ? [{ x: 999, y: 150 }] : [{ x: 564, y: 150 }],
          },
        };
      });
      assert.equal(
        await createDoc88CaptchaSolver(f.service, f.job, { sleep: async () => {} })(f.options),
        false,
      );
      assert.equal(await f.evaluate('window.down'), false);
      assert.equal(await f.evaluate('Boolean(document.getElementById("page_1"))'), false);
      assert.equal(await f.evaluate('Math.max(0,...window.positions)'), 0);
      assert.equal(f.submitted.length, variant === 'scope' ? 0 : 1);
    });
});
