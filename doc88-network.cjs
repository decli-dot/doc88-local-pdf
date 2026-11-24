'use strict';
const { setTimeout: delay } = require('node:timers/promises');
const { requestPublic, webURL } = require('./public-http.cjs');
const LIMIT = 3 * 1024 * 1024;
function networkCode(error) {
  const value = typeof error?.code === 'string' ? error.code : error?.cause?.code;
  if (typeof value === 'string' && /^[A-Z\d_]+$/.test(value)) return value;
  if (error?.name === 'TimeoutError') return 'ETIMEDOUT';
  return null;
}
function transient(error) {
  return (
    /^(?:EAI_AGAIN|ENOTFOUND|ETIMEDOUT|ABORT_ERR|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT)$/.test(
      networkCode(error) || '',
    ) ||
    /HTTP (?:429|50[0234])\b/.test(error?.message || '') ||
    /^(?:429|50[0234])$/.test(String(error?.status || ''))
  );
}
function retryAfter(value) {
  if (!value) return 0;
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.max(0, number * 1000)
    : Math.max(0, Date.parse(value) - Date.now()) || 0;
}
async function buffered(response) {
  const chunks = [];
  let size = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > LIMIT)
          throw Object.assign(Error('Получен слишком большой ответ поиска.'), {
            code: 'DOC88_RESPONSE_LIMIT',
          });
        chunks.push(Buffer.from(value));
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
  const bytes = Buffer.concat(chunks),
    headers = new Headers(response.headers);
  headers.delete('content-encoding');
  headers.set('content-length', String(bytes.length));
  return new Response([204, 205, 304].includes(response.status) ? null : bytes, {
    status: response.status,
    headers,
  });
}
function createDoc88Fetcher({
  fetchImpl = fetch,
  request = requestPublic,
  sleep = delay,
  onRetry = () => {},
  attemptTimeoutMs = 12000,
} = {}) {
  return async function fetchDoc88(value, init = {}) {
    const url = webURL(value, ['doc88.com']);
    if (url.hostname !== 'www.doc88.com' || url.pathname !== '/search/post.do')
      throw Error('Недопустимый адрес поиска.');
    const { signal } = init;
    let last;
    for (let attempt = 0; attempt < 3; attempt++) {
      signal?.throwIfAborted();
      const deadline = AbortSignal.timeout(attemptTimeoutMs);
      const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
      try {
        const response =
          attempt === 0
            ? await fetchImpl(url, { ...init, signal: combined, redirect: 'error' })
            : await request(url.href, {
                signal: combined,
                hosts: ['doc88.com'],
                maxBytes: LIMIT,
                timeoutMs: attemptTimeoutMs,
                headers: init.headers,
              });
        if (attempt === 0) {
          if ([429, 500, 502, 503, 504].includes(response.status)) {
            const wait = retryAfter(response.headers.get('retry-after'));
            await response.body?.cancel();
            throw Object.assign(Error('Источник временно недоступен.'), {
              status: response.status,
              code: 'DOC88_HTTP_TEMPORARY',
              retryAfterMs: wait,
            });
          }
          return await buffered(response);
        }
        return new Response(response.bytes, { status: response.status, headers: response.headers });
      } catch (error) {
        signal?.throwIfAborted();
        if (deadline.aborted)
          error = Object.assign(Error('Истекло время соединения с источником.'), {
            code: 'ETIMEDOUT',
            cause: error,
          });
        last = error;
        const wait = error.retryAfterMs ?? retryAfter(error.retryAfter);
        if (!transient(error) || attempt === 2 || wait > 10000) break;
        onRetry({
          attempt: attempt + 1,
          code: networkCode(error) || 'HTTP_' + error.status,
          delayMs: Math.max(wait, attempt ? 1500 : 500),
        });
        await sleep(Math.max(wait, attempt ? 1500 : 500), undefined, { signal });
      }
    }
    throw Object.assign(
      Error('Не удалось получить доступ к поиску документа. Повторите попытку позже.'),
      {
        code: 'DOC88_CONNECTION_FAILED',
        networkCode: networkCode(last),
        status: last?.status,
        cause: last,
      },
    );
  };
}
async function fetchDoc88(value, init) {
  return createDoc88Fetcher()(value, init);
}
module.exports = { createDoc88Fetcher, fetchDoc88, networkCode };
