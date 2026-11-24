'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { createDoc88Fetcher, networkCode } = require('../doc88-network.cjs');
const url = 'https://www.doc88.com/search/post.do?q=DIN127';
test('a temporary native connection failure retries a fresh HTTPS lookup and preserves the request', async () => {
  const calls = [],
    delays = [];
  const fetcher = createDoc88Fetcher({
    fetchImpl: async () => {
      throw Object.assign(TypeError('fetch failed'), {
        cause: { code: 'UND_ERR_CONNECT_TIMEOUT' },
      });
    },
    request: async (value, options) => {
      calls.push({ value, options });
      return {
        status: 200,
        headers: { 'content-type': 'text/html' },
        bytes: Buffer.from('<div id="pageResult"></div>'),
      };
    },
    sleep: async (ms) => delays.push(ms),
  });
  const response = await fetcher(url, { headers: { Referer: 'https://www.doc88.com/' } });
  assert.equal(await response.text(), '<div id="pageResult"></div>');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].value, url);
  assert.deepEqual(calls[0].options.hosts, ['doc88.com']);
  assert.equal(calls[0].options.headers.Referer, 'https://www.doc88.com/');
  assert.deepEqual(delays, [500]);
});
test('temporary HTTP failures and a broken response stream retry, permanent failures do not', async () => {
  let requests = 0;
  const fetcher = createDoc88Fetcher({
    fetchImpl: async () => new Response('Busy', { status: 503 }),
    sleep: async () => {},
    request: async () => {
      if (++requests === 1) throw Object.assign(Error('HTTP 502'), { status: 502 });
      return { status: 200, headers: {}, bytes: Buffer.from('done') };
    },
  });
  assert.equal(await (await fetcher(url)).text(), 'done');
  assert.equal(requests, 2);
  let retried = 0;
  const permanent = createDoc88Fetcher({
    fetchImpl: async () => new Response('Forbidden', { status: 403 }),
    request: async () => {
      retried++;
    },
    sleep: async () => {},
  });
  assert.equal((await permanent(url)).status, 403);
  assert.equal(retried, 0);
  const broken = createDoc88Fetcher({
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.error(Object.assign(Error('reset'), { code: 'ECONNRESET' }));
          },
        }),
      ),
    request: async () => ({ status: 200, headers: {}, bytes: Buffer.from('complete') }),
    sleep: async () => {},
  });
  assert.equal(await (await broken(url)).text(), 'complete');
});
test('an internal HTTPS deadline does not suppress the remaining retry', async () => {
  let calls = 0;
  const codes = [];
  const fetcher = createDoc88Fetcher({
    fetchImpl: async () => {
      throw Object.assign(Error('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
    },
    request: async () => {
      if (++calls === 1)
        throw Object.assign(Error('Internal deadline'), {
          code: 'ABORT_ERR',
          cause: new DOMException('The operation timed out', 'TimeoutError'),
        });
      return { status: 200, headers: {}, bytes: Buffer.from('recovered') };
    },
    sleep: async () => {},
    onRetry: (info) => codes.push(info.code),
  });
  assert.equal(await (await fetcher(url)).text(), 'recovered');
  assert.equal(calls, 2);
  assert.deepEqual(codes, ['UND_ERR_CONNECT_TIMEOUT', 'ABORT_ERR']);
  assert.equal(networkCode({ code: 'ETIMEDOUT', cause: { code: 'ABORT_ERR' } }), 'ETIMEDOUT');
});
test('cancellation during retry pauses immediately and server retry-after is respected', async () => {
  const controller = new AbortController();
  let requested = 0;
  const fetcher = createDoc88Fetcher({
    fetchImpl: async () => {
      throw Object.assign(Error('reset'), { code: 'ECONNRESET' });
    },
    sleep: async (_ms, _value, { signal }) => {
      controller.abort();
      signal.throwIfAborted();
    },
    request: async () => {
      requested++;
    },
  });
  await assert.rejects(fetcher(url, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(requested, 0);
  const limited = createDoc88Fetcher({
    fetchImpl: async () => new Response('Wait', { status: 429, headers: { 'Retry-After': '60' } }),
    request: async () => {
      requested++;
    },
    sleep: async () => assert.fail('Do not retry before the requested time'),
  });
  await assert.rejects(limited(url), { code: 'DOC88_CONNECTION_FAILED', status: 429 });
  assert.equal(requested, 0);
});
test('only the fixed HTTPS Doc88 search endpoint is accepted and large responses are not retried', async () => {
  let called = 0;
  const fetcher = createDoc88Fetcher({
    fetchImpl: async () => {
      called++;
      return new Response(Buffer.alloc(3 * 1024 * 1024 + 1));
    },
    request: async () => assert.fail('No retry for an oversized response'),
    sleep: async () => {},
  });
  for (const value of [
    'http://www.doc88.com/search/post.do',
    'https://evil.test/search/post.do',
    'https://127.0.0.1/search/post.do',
    'https://www.doc88.com/account',
  ])
    await assert.rejects(fetcher(value));
  assert.equal(called, 0);
  await assert.rejects(fetcher(url), { code: 'DOC88_CONNECTION_FAILED' });
  assert.equal(called, 1);
});
