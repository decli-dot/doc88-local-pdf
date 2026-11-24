'use strict';
const { setTimeout: delay } = require('node:timers/promises');
const temporary = (error) =>
  error?.name === 'TimeoutError' ||
  /net::ERR_(?:NAME_NOT_RESOLVED|CONNECTION_(?:TIMED_OUT|RESET|CLOSED)|NETWORK_CHANGED|TIMED_OUT|INTERNET_DISCONNECTED)/.test(
    error?.message || '',
  );
async function gotoSourcePage(
  page,
  url,
  { signal, allowed, onRetry = () => {}, sleep = delay } = {},
) {
  signal?.throwIfAborted();
  if (allowed && !allowed(url))
    throw Object.assign(Error('Источник открыл недопустимый адрес.'), {
      code: 'SOURCE_ACCESS_PENDING',
    });
  for (let attempt = 0; attempt < 3; attempt++) {
    signal?.throwIfAborted();
    try {
      const result = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      if (allowed && !allowed(page.url()))
        throw Object.assign(Error('Источник открыл другую страницу.'), {
          code: 'SOURCE_ACCESS_PENDING',
        });
      if ([429, 500, 502, 503, 504].includes(result?.status())) {
        const retryAfter = result.headers()['retry-after'];
        throw Object.assign(Error('Источник временно недоступен.'), {
          code: 'SOURCE_HTTP_TEMPORARY',
          retryAfter: Number(retryAfter) || 0,
        });
      }
      return result;
    } catch (error) {
      signal?.throwIfAborted();
      if (
        page.isClosed() ||
        (!temporary(error) && error.code !== 'SOURCE_HTTP_TEMPORARY') ||
        attempt === 2 ||
        error.retryAfter > 10
      )
        throw error;
      const milliseconds = Math.max((error.retryAfter || 0) * 1000, attempt ? 1500 : 500);
      onRetry({
        attempt: attempt + 1,
        code:
          error.name === 'TimeoutError'
            ? 'BROWSER_NETWORK_TIMEOUT'
            : error.code || 'BROWSER_CONNECTION_ERROR',
        delayMs: milliseconds,
      });
      await sleep(milliseconds, undefined, { signal });
    }
  }
}
module.exports = { gotoSourcePage };
