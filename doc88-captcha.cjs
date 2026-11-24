'use strict';
const { createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { allowedDocument } = require('./challenge-view.cjs');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const failure = (code) => Object.assign(Error(code), { code });

// Read the observed public puzzle widget; never change its validation state.
function inspectDoc88() {
  const root = document.getElementById('captcha_reading');
  const shown = (n) =>
    Boolean(n?.getClientRects().length && getComputedStyle(n).visibility !== 'hidden');
  const rect = (n) => {
    if (!n || !shown(n)) return null;
    const r = n.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  const bar = root?.querySelector('.scale[id^="bar_"]');
  const button = bar?.querySelector('span[id^="btn_"]');
  const bg = root?.querySelector('.safe-bg');
  const piece = root?.querySelector('.safe-captcha');
  const source = bg
    ? getComputedStyle(bg).backgroundImage.match(/^url\(["']?(.*?)["']?\)$/)?.[1]
    : null;
  return {
    visible: shown(root),
    variant: root?.querySelector('.read-shape-board') ? 'shapes' : 'puzzle',
    widget: button?.id || null,
    bar: rect(bar),
    button: rect(button),
    background: rect(bg),
    piece: rect(piece),
    imageURL: source || null,
    scrollX,
    scrollY,
    viewportWidth: innerWidth,
    viewportHeight: innerHeight,
    contentReady: Boolean(document.getElementById('page_1')),
  };
}
const inspectExpression = '(' + inspectDoc88.toString() + ')()';
function dragTarget(state, points, image) {
  const { background: bg, piece, button, bar } = state;
  if (!bg || !piece || !button || !bar || !Array.isArray(points) || points.length !== 1)
    throw failure('CAPTCHA_SERVICE_RESPONSE');
  for (const p of points)
    if (
      !Number.isFinite(p?.x) ||
      !Number.isFinite(p?.y) ||
      p.x < 0 ||
      p.x >= image.width ||
      p.y < 0 ||
      p.y >= image.height
    )
      throw failure('CAPTCHA_COORDINATES_INVALID');
  const [last] = points.map((p) => ({
    x: (p.x * bg.width) / image.width,
    y: (p.y * bg.height) / image.height,
  }));
  const px = piece.x - bg.x,
    py = piece.y - bg.y;
  const first = { x: px + piece.width / 2, y: py + piece.height / 2 };
  if (last.x <= px + piece.width || last.y < py - 3 || last.y > py + piece.height + 3)
    throw failure('CAPTCHA_COORDINATES_INVALID');
  const ratio = (bar.width - button.width) / (bg.width - piece.width);
  const x = button.x + button.width / 2 + (last.x - first.x) * ratio;
  if (
    !Number.isFinite(ratio) ||
    ratio <= 0 ||
    x < bar.x + button.width / 2 ||
    x > bar.x + bar.width - button.width / 2
  )
    throw failure('CAPTCHA_COORDINATES_INVALID');
  return { x, y: button.y + button.height / 2 };
}
function createDoc88CaptchaSolver(service, job, { sleep = delay } = {}) {
  const pages = new WeakMap();
  return async function tryDoc88({ page, cdp, evaluate, allowed, signal: operationSignal }) {
    const signal = operationSignal
      ? AbortSignal.any([job.controller.signal, operationSignal])
      : job.controller.signal;
    const guard = () => {
      signal.throwIfAborted();
      if (page.isClosed() || !allowedDocument(page.url()) || !allowed(page.url()))
        throw failure('CAPTCHA_PAGE_CHANGED');
    };
    if (!service.summary().enabled || !service.summary().configured) return false;
    let state = pages.get(page);
    if (!state) pages.set(page, (state = { started: Date.now(), stopped: false }));
    if (state.stopped) return false;
    let pressed = false,
      answer,
      variant;
    const publish = (status, code) =>
      job.update({
        captchaDiagnostics: {
          provider: 'rucaptcha',
          type: 'doc88-slider',
          ...(variant ? { variant } : {}),
          status,
          ...(code ? { code } : {}),
        },
      });
    const inspect = async () => {
      guard();
      return evaluate(inspectExpression);
    };
    const release = async () => {
      if (pressed) {
        pressed = false;
        await page.mouse.up().catch(() => {});
      }
    };
    const shot = async (s) => {
      guard();
      const { data } = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: false,
        clip: {
          x: s.background.x + s.scrollX,
          y: s.background.y + s.scrollY,
          width: s.background.width,
          height: s.background.height,
          scale: 1,
        },
      });
      return Buffer.from(data, 'base64');
    };
    try {
      let current = await inspect();
      if (!current.visible) return false;
      variant = current.variant;
      if (!current.button || !current.bar || !current.imageURL) {
        if (Date.now() - state.started < 15000) return true;
        throw failure('CAPTCHA_UNSUPPORTED');
      }
      const imageURL = new URL(current.imageURL, page.url());
      if (
        imageURL.origin !== new URL(page.url()).origin ||
        imageURL.pathname !== '/api.php' ||
        imageURL.searchParams.get('act') !== 'verify_img'
      )
        throw failure('CAPTCHA_UNSUPPORTED');
      if (
        current.button.y < 140 ||
        current.button.y + current.button.height > current.viewportHeight - 20
      ) {
        await evaluate(
          `document.getElementById(${JSON.stringify(current.widget)})?.scrollIntoView({block:'center',inline:'center'})`,
        );
        current = await inspect();
      }
      const initial = {
        x: current.button.x + current.button.width / 2,
        y: current.button.y + current.button.height / 2,
      };
      guard();
      job.update({
        captchaSolving: true,
        challengeAvailable: false,
        stage: 'waiting',
        message: 'Проверяем доступ…',
      });
      publish('detecting');
      // Enter the handle normally before waiting for the provider. The shape
      // widget observes pointer entry/hover as part of its ordinary gesture.
      await page.mouse.move(initial.x, initial.y);
      await sleep(500, undefined, { signal });
      // The newer shape board is already open. Only the older hidden puzzle
      // needs a short press; do not submit an unnecessary zero-distance drag.
      if (!current.background || !current.piece) {
        await page.mouse.move(initial.x, initial.y);
        await page.mouse.down();
        pressed = true;
        await release();
      }
      // Loading the same public image through the browser image cache waits
      // for decoding; no puzzle is sent while its background is still blank.
      const loaded = await evaluate(
        `new Promise(resolve=>{const img=new Image();const timer=setTimeout(()=>resolve(false),12000);img.onload=()=>{clearTimeout(timer);resolve(img.naturalWidth>0)};img.onerror=()=>{clearTimeout(timer);resolve(false)};img.src=${JSON.stringify(imageURL.href)};})`,
        true,
      );
      if (!loaded) throw failure('CAPTCHA_IMAGE_UNAVAILABLE');
      await sleep(150, undefined, { signal });
      current = await inspect();
      if (
        !current.background ||
        !current.piece ||
        current.background.width < 100 ||
        current.background.height < 40 ||
        current.background.width > 1000 ||
        current.background.height > 1000
      )
        throw failure('CAPTCHA_UNSUPPORTED');
      const bytes = await shot(current);
      if (bytes.length > 600000) throw failure('CAPTCHA_IMAGE_LIMIT');
      const enlarged = await require('sharp')(bytes)
        .resize({
          width: Math.min(1000, Math.round(current.background.width * 3)),
          height: Math.min(1000, Math.round(current.background.height * 3)),
          fit: 'inside',
        })
        .png()
        .toBuffer();
      const submitted = enlarged.length <= 600000 ? enlarged : bytes;
      const image = await require('sharp')(submitted).metadata();
      const fingerprint = hash(Buffer.concat([Buffer.from(imageURL.href), bytes]));
      publish('processing');
      answer = await service.solve(
        job.id,
        {
          type: 'CoordinatesTask',
          body: submitted.toString('base64'),
          minClicks: 1,
          maxClicks: 1,
          comment:
            variant === 'shapes'
              ? 'The FILLED movable shape at the far LEFT is the reference. Click ONE point at the CENTRE of the empty OUTLINE with the SAME shape, size and orientation. Ignore outlines of other shapes. Do NOT click the filled reference shape or an edge.'
              : 'Click ONE point exactly at the centre of the empty WHITE puzzle-shaped HOLE in the background (on the right). Do NOT click the small movable puzzle piece at the far LEFT. We need the centre of the empty hole, not its edge.',
        },
        { signal, fingerprint },
      );
      guard();
      const fresh = await inspect();
      if (
        fresh.widget !== current.widget ||
        fresh.variant !== current.variant ||
        fresh.imageURL !== current.imageURL ||
        !fresh.background ||
        Math.abs(fresh.background.x - current.background.x) > 0.5 ||
        Math.abs(fresh.background.y - current.background.y) > 0.5 ||
        hash(await shot(fresh)) !== hash(bytes)
      )
        throw failure('CAPTCHA_CHANGED');
      const target = dragTarget(fresh, answer.solution.coordinates, image);
      const start = {
        x: fresh.button.x + fresh.button.width / 2,
        y: fresh.button.y + fresh.button.height / 2,
      };
      guard();
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      pressed = true;
      for (let i = 1; i <= 24; i++) {
        guard();
        await page.mouse.move(
          start.x + ((target.x - start.x) * i) / 24,
          start.y + ((target.y - start.y) * i) / 24,
        );
        await sleep(20, undefined, { signal });
      }
      await release();
      for (let i = 0; i < 120; i++) {
        await sleep(250, undefined, { signal });
        const after = await inspect();
        if (!after.visible && after.contentReady) {
          await service.finish(answer.id, 'passed');
          publish('passed');
          return true;
        }
        if (after.visible && after.widget && after.widget !== current.widget) {
          await service.finish(answer.id, 'unconfirmed', { code: 'CAPTCHA_NOT_ACCEPTED' });
          state.started = Date.now();
          publish('retrying', 'CAPTCHA_NOT_ACCEPTED');
          return true;
        }
      }
      throw failure('CAPTCHA_NOT_ACCEPTED');
    } catch (error) {
      const code = signal.aborted
        ? 'CAPTCHA_CANCELLED'
        : /^[A-Z\d_]{1,80}$/.test(error.code || '')
          ? error.code
          : 'CAPTCHA_BROWSER_ERROR';
      if (answer)
        await service.finish(answer.id, signal.aborted ? 'cancelled' : 'unconfirmed', { code });
      signal.throwIfAborted();
      state.stopped = true;
      publish('manual', code);
      return false;
    } finally {
      await release();
      if (job.captchaSolving) job.update({ captchaSolving: false });
    }
  };
}
module.exports = { inspectDoc88, inspectExpression, dragTarget, createDoc88CaptchaSolver };
