const test = require('node:test'),
  assert = require('node:assert/strict');
const { gotoSourcePage } = require('../browser-navigation.cjs');
const url = 'https://annas-archive.pk/search?q=DIN';
test('transient DNS navigation retries preserve the same browser page', async () => {
  let attempts = 0;
  const delays = [];
  const page = {
    goto: async (value) => {
      assert.equal(value, url);
      if (++attempts === 1) throw Error('page.goto: net::ERR_NAME_NOT_RESOLVED');
      return { status: () => 200 };
    },
    url: () => url,
    isClosed: () => false,
  };
  await gotoSourcePage(page, url, {
    allowed: (value) => value === url,
    sleep: async (ms) => delays.push(ms),
  });
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [500]);
});
test('unrelated redirects and long Retry-After never result in immediate repeat requests', async () => {
  let calls = 0;
  const page = {
    goto: async () => {
      calls++;
      return { status: () => 200 };
    },
    url: () => 'https://unrelated.test/',
    isClosed: () => false,
  };
  await assert.rejects(
    gotoSourcePage(page, url, {
      allowed: (value) => value === url,
      sleep: async () => assert.fail(),
    }),
    { code: 'SOURCE_ACCESS_PENDING' },
  );
  assert.equal(calls, 1);
  page.url = () => url;
  page.goto = async () => {
    calls++;
    return { status: () => 429, headers: () => ({ 'retry-after': '60' }) };
  };
  await assert.rejects(
    gotoSourcePage(page, url, {
      allowed: (value) => value === url,
      sleep: async () => assert.fail(),
    }),
    { code: 'SOURCE_HTTP_TEMPORARY' },
  );
  assert.equal(calls, 2);
});
test('cancellation stops navigation retries', async () => {
  const controller = new AbortController();
  let calls = 0;
  const page = {
    goto: async () => {
      calls++;
      throw Error('net::ERR_CONNECTION_RESET');
    },
    url: () => url,
    isClosed: () => false,
  };
  await assert.rejects(
    gotoSourcePage(page, url, {
      signal: controller.signal,
      sleep: async (_ms, _value, { signal }) => {
        controller.abort();
        signal.throwIfAborted();
      },
    }),
    { name: 'AbortError' },
  );
  assert.equal(calls, 1);
});
