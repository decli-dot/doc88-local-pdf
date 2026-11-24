'use strict';
const { createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const navigating = (error) =>
  /Execution context was destroyed|Cannot find context with specified id|Frame was detached|frame has been detached|Target page, context or browser has been closed/i.test(
    error?.message || '',
  );
async function accessOpened(page, allowed) {
  if (
    page.isClosed() ||
    !allowed(page.url()) ||
    /DDOS-GUARD|Just a moment|Checking your browser/i.test(await page.title())
  )
    return false;
  return page.evaluate(() => {
    const frame = document.querySelector('#ddg-iframe');
    const style = frame && getComputedStyle(frame),
      rect = frame?.getBoundingClientRect();
    const visible =
      frame &&
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      Number(style.opacity) !== 0 &&
      rect.width > 0 &&
      rect.height > 0;
    return document.readyState !== 'loading' && !!document.body?.innerText.trim() && !visible;
  });
}

// Deliberately narrow first adapter: the observed DDoS-Guard text challenge.
// Open the widget normally, send only its image to RuCaptcha, and submit the
// returned literal text. No invented tokens, recognition models or cookie edits.
function createBrowserCaptchaSolver(service, job, { sleep = delay } = {}) {
  const doc88 = require('./doc88-captcha.cjs').createDoc88CaptchaSolver(service, job, { sleep });
  const pages = new WeakMap();
  let lastDiagnostic = '';
  function diagnostic(status, code, phase) {
    const value = {
      provider: 'rucaptcha',
      type: 'ddg-text',
      status,
      ...(code ? { code } : {}),
      ...(phase ? { phase } : {}),
    };
    if (JSON.stringify(value) === lastDiagnostic) return;
    lastDiagnostic = JSON.stringify(value);
    job.update({ captchaDiagnostics: value });
  }
  return async function tryCaptcha(options) {
    const { page, allowed, signal: operationSignal } = options;
    const signal = operationSignal
      ? AbortSignal.any([job.controller.signal, operationSignal])
      : job.controller.signal;
    signal.throwIfAborted();
    if (/^(?:www\.)?doc88\.com$/.test(new URL(page.url()).hostname)) return doc88(options);
    if (!service.summary().enabled || !service.summary().configured) return false;
    if (page.isClosed() || !allowed(page.url())) return false;
    let state = pages.get(page);
    if (!state || state.url !== page.url())
      pages.set(
        page,
        (state = { url: page.url(), opened: false, stopped: false, started: Date.now() }),
      );
    if (state.stopped) return false;
    let answer,
      phase = 'detecting',
      submitted = false;
    try {
      const handle = await page.$('#ddg-iframe');
      const frame = await handle?.contentFrame();
      await handle?.dispose();
      if (!frame) {
        if (/DDOS-GUARD/i.test(await page.title()) && Date.now() - state.started < 25000) {
          diagnostic('detecting');
          return true;
        }
        diagnostic('unsupported', 'CAPTCHA_UNSUPPORTED');
        return false;
      }
      const input = frame.locator('.ddg-modal__input');
      const picture = frame.locator('.ddg-modal__captcha-image');
      if (!(await input.isVisible())) {
        const checkbox = frame.locator('.ddg-captcha__checkbox');
        if (!state.opened && (await checkbox.isVisible())) {
          state.opened = true;
          if (!allowed(page.url())) return false;
          await checkbox.click({ timeout: 3000 });
          await sleep(1000, undefined, { signal });
          return true; // The checkbox can also complete the verification itself.
        }
        return state.opened && Date.now() - state.started < 30000;
      }
      if (!(await picture.isVisible())) return false;
      const valid = await picture.evaluate((img) => img.complete && img.naturalWidth > 0);
      if (!valid) return false;
      phase = 'capture';
      const imageURL = await picture.evaluate((img) => img.currentSrc || img.src);
      const bytes = await picture.screenshot({ type: 'png', timeout: 3000 });
      const dimensions = await picture.boundingBox();
      if (
        !dimensions ||
        dimensions.width > 600 ||
        dimensions.height > 600 ||
        bytes.length > 100000
      ) {
        diagnostic('unsupported', 'CAPTCHA_IMAGE_LIMIT');
        return false;
      }
      const fingerprint = hash(
        Buffer.concat([
          Buffer.from(new URL(page.url()).origin + new URL(page.url()).pathname),
          bytes,
        ]),
      );
      job.update({
        captchaSolving: true,
        challengeAvailable: false,
        stage: 'waiting',
        message: 'Проверяем доступ…',
      });
      diagnostic('processing', undefined, 'provider');
      // The widget is only 180x80 CSS pixels. Enlarge the cropped image for
      // workers while retaining the original capture for the stale-image check.
      const prepared = await require('sharp')(bytes)
        .resize({
          width: Math.min(540, Math.round(dimensions.width * 3)),
          height: Math.min(540, Math.round(dimensions.height * 3)),
          fit: 'inside',
        })
        .png()
        .toBuffer();
      const imageBytes = prepared.length <= 100000 ? prepared : bytes;
      phase = 'provider';
      answer = await service.solve(
        job.id,
        {
          type: 'ImageToTextTask',
          body: imageBytes.toString('base64'),
          case: true,
          comment: 'Введите символы с изображения. Внимательно сохраните регистр букв.',
        },
        { signal, fingerprint },
      );
      signal.throwIfAborted();
      const text = answer.solution.text;
      if (
        typeof text !== 'string' ||
        !text.trim() ||
        text.length > 64 ||
        /[\u0000-\u001f\u007f]/.test(text)
      ) {
        await service.finish(answer.id, 'unconfirmed', { code: 'CAPTCHA_SERVICE_RESPONSE' });
        throw Object.assign(Error('Invalid captcha answer'), { code: 'CAPTCHA_SERVICE_RESPONSE' });
      }
      // A changed challenge must never receive the old image's answer.
      if (
        page.isClosed() ||
        !allowed(page.url()) ||
        !(await picture.isVisible()) ||
        hash(await picture.screenshot({ type: 'png', timeout: 3000 })) !== hash(bytes)
      ) {
        await service.finish(answer.id, 'stale', { code: 'CAPTCHA_CHANGED' });
        const retry = !page.isClosed() && allowed(page.url());
        state.stopped = !retry;
        diagnostic(retry ? 'retrying' : 'manual', 'CAPTCHA_CHANGED', 'capture');
        return retry;
      }
      phase = 'submit';
      await input.fill('', { timeout: 3000 });
      await input.pressSequentially(text.trim(), { delay: 50, timeout: 5000 });
      submitted = true;
      try {
        await frame.locator('.ddg-modal__submit').click({ timeout: 3000 });
      } catch (error) {
        if (!navigating(error)) throw error;
      }
      phase = 'verify';
      let rejected = false,
        renewed = false;
      for (let i = 0; i < 80; i++) {
        await sleep(500, undefined, { signal });
        if (page.isClosed() || !allowed(page.url())) break;
        try {
          if (await accessOpened(page, allowed)) {
            await service.finish(answer.id, 'passed');
            diagnostic('passed');
            return true;
          }
          const errorField = frame.locator('.ddg-modal__error');
          const rejection = (await errorField.isVisible())
            ? await errorField.innerText({ timeout: 500 }).catch(() => '')
            : '';
          if (rejection.trim()) {
            rejected = true;
            break;
          }
          if (
            (await picture.isVisible()) &&
            (await picture.evaluate((img) => img.currentSrc || img.src)) !== imageURL
          ) {
            renewed = true;
            break;
          }
        } catch (error) {
          if (!navigating(error)) throw error;
        }
      }
      await service.finish(answer.id, 'unconfirmed', { code: 'CAPTCHA_NOT_ACCEPTED' });
      if (renewed && allowed(page.url())) {
        state.opened = true;
        state.started = Date.now();
        diagnostic('retrying', 'CAPTCHA_REFRESHED', 'verify');
        return true; // The site supplied a new challenge after submission.
      }
      if (
        rejected &&
        allowed(page.url()) &&
        (await frame.locator('.ddg-modal__refresh').isVisible())
      ) {
        await frame.locator('.ddg-modal__refresh').click({ timeout: 3000 });
        state.opened = true;
        state.started = Date.now();
        diagnostic('retrying', 'CAPTCHA_NOT_ACCEPTED');
        return true; // The shared persisted allowance bounds the next attempt.
      }
      diagnostic('manual', 'CAPTCHA_NOT_ACCEPTED');
      state.stopped = true;
      return false;
    } catch (error) {
      signal.throwIfAborted();
      if (answer && submitted && !page.isClosed() && allowed(page.url())) {
        for (let i = 0; i < 10; i++) {
          try {
            if (await accessOpened(page, allowed)) {
              await service.finish(answer.id, 'passed');
              diagnostic('passed');
              return true;
            }
          } catch (checkError) {
            if (!navigating(checkError)) break;
          }
          await sleep(300, undefined, { signal });
        }
      }
      state.stopped = true;
      const code =
        typeof error.code === 'string' && /^[A-Z][A-Z\d_]{0,79}$/.test(error.code)
          ? error.code
          : error.name === 'TimeoutError'
            ? 'CAPTCHA_BROWSER_TIMEOUT'
            : 'CAPTCHA_BROWSER_ERROR';
      if (answer) await service.finish(answer.id, 'unconfirmed', { code });
      diagnostic('manual', code, phase);
      return false;
    } finally {
      if (job.captchaSolving) job.update({ captchaSolving: false });
    }
  };
}
module.exports = { createBrowserCaptchaSolver };
