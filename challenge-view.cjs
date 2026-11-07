'use strict';
const { randomUUID } = require('node:crypto');

const visibleChallenge = `(() => {
  for (const id of ['captcha_reading', 'continue_page']) {
    const element = document.getElementById(id);
    if (!element || !element.getClientRects().length) continue;
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    return { id, x: rect.x, y: rect.y, width: rect.width, height: rect.height,
      scrollX, scrollY, viewportWidth: innerWidth, viewportHeight: innerHeight };
  }
  return null;
})()`;
function failure(message, status = 409) {
  return Object.assign(new Error(message), { status });
}
function allowedDocument(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.port &&
      !url.username &&
      !url.password &&
      ['www.doc88.com', 'doc88.com'].includes(url.hostname) &&
      /^\/p-\d+\.html$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

// Only a cropped live image and human pointer events cross the localhost boundary.
// No automatic challenge recognition, mouse paths, HTML proxy, or security overrides.
function createChallengeView({ page, cdp, evaluate, allowed = allowedDocument }) {
  let closed = false;
  let region = null;
  let token = randomUUID();
  let pressed = false;
  let capture = null;
  let actions = Promise.resolve();
  async function state() {
    if (closed || page.isClosed() || !allowed(page.url()))
      throw failure('Окно проверки уже закрыто.');
    const value = await evaluate(visibleChallenge);
    if (!value) throw failure('Подтверждение больше не требуется.');
    return value;
  }
  async function release() {
    if (pressed) {
      pressed = false;
      await page.mouse.up().catch(() => {});
    }
  }
  async function frame() {
    if (capture) return capture;
    capture = (async () => {
      let current = await state();
      if (!region) {
        if (current.y < 180 || current.y + current.height > current.viewportHeight - 30) {
          await evaluate(
            `document.getElementById(${JSON.stringify(current.id)})?.scrollIntoView({block:'center',inline:'center'})`,
          );
          current = await state();
        }
        const width = Math.min(440, current.viewportWidth);
        const height = Math.min(360, current.viewportHeight);
        region = {
          x: Math.max(
            0,
            Math.min(
              current.viewportWidth - width,
              Math.round(current.x + current.width / 2 - width / 2),
            ),
          ),
          y: Math.max(
            0,
            Math.min(
              current.viewportHeight - height,
              Math.round(current.y + current.height - height + 45),
            ),
          ),
          width,
          height,
        };
      }
      const capturedRegion = { ...region };
      const capturedToken = token;
      const { data } = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: false,
        clip: {
          x: capturedRegion.x + current.scrollX,
          y: capturedRegion.y + current.scrollY,
          width: capturedRegion.width,
          height: capturedRegion.height,
          scale: 1,
        },
      });
      if (closed || token !== capturedToken) throw failure('Окно проверки уже изменилось.');
      return {
        token: capturedToken,
        width: capturedRegion.width,
        height: capturedRegion.height,
        image: 'data:image/png;base64,' + data,
      };
    })();
    try {
      return await capture;
    } finally {
      capture = null;
    }
  }
  async function input(value) {
    if (
      !value ||
      !region ||
      value.token !== token ||
      !['move', 'down', 'up'].includes(value.type) ||
      !Number.isFinite(value.x) ||
      !Number.isFinite(value.y) ||
      value.x < 0 ||
      value.x > 1 ||
      value.y < 0 ||
      value.y > 1
    )
      throw failure('Обнови изображение проверки и попробуй снова.', 400);
    const run = async () => {
      if (closed || value.token !== token) throw failure('Окно проверки уже изменилось.');
      if (value.type === 'up') {
        await release();
        return;
      }
      await state();
      if (closed || value.token !== token) throw failure('Окно проверки уже изменилось.');
      const x = region.x + value.x * (region.width - 1);
      const y = region.y + value.y * (region.height - 1);
      await page.mouse.move(x, y);
      if (value.type === 'down' && !pressed) {
        pressed = true;
        await page.mouse.down();
      }
    };
    const pending = actions.then(run);
    actions = pending.catch(() => {});
    return pending;
  }
  async function reset() {
    token = randomUUID();
    region = null;
    await actions;
    await release();
  }
  async function close() {
    closed = true;
    await reset();
  }
  return { frame, input, reset, close };
}
module.exports = { createChallengeView, visibleChallenge, allowedDocument };
