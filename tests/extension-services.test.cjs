const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
function fixture() {
  const calls = [],
    storage = { isoSession: { session: 'owned', owner: 5, tabId: 9 } };
  const job = {
    id: 'capture',
    targetTab: 5,
    sourceTab: 7,
    url: 'https://www.doc88.com/p-123.html',
    phase: 'capturing',
    challenge: true,
  };
  const context = vm.createContext({
    URL,
    crypto: { randomUUID },
    setTimeout,
    clearTimeout,
    AbortSignal,
    Blob,
    fetch: () => {
      throw Error('Unexpected network request');
    },
    isSite: (url) => url === 'https://decli-dot.github.io/doc88-local-pdf/',
    docURL: (url) => {
      const value = new URL(url);
      if (value.hostname !== 'www.doc88.com' || !/^\/p-\d+\.html$/.test(value.pathname))
        throw Error('Invalid Doc88 URL');
      return value.href;
    },
    getJob: async () => job,
    chrome: {
      storage: {
        session: {
          get: async (key) => ({ [key]: storage[key] }),
          remove: async (key) => {
            delete storage[key];
          },
          set: async (value) => Object.assign(storage, value),
        },
      },
      tabs: {
        get: async () => ({ url: job.url }),
        remove: async (id) => calls.push(['remove', id]),
      },
      scripting: {
        executeScript: async () => [
          { result: { x: 10, y: 20, left: 10, top: 20, width: 400, height: 100 } },
        ],
      },
      debugger: {
        attach: async () => calls.push(['attach']),
        detach: async () => calls.push(['detach']),
        sendCommand: async (target, method, input) => {
          calls.push([method, input]);
          return { data: 'test-jpeg' };
        },
      },
    },
  });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../extension/services.js'), 'utf8'),
    context,
  );
  const sender = {
    frameId: 0,
    url: 'https://decli-dot.github.io/doc88-local-pdf/',
    tab: { id: 5 },
  };
  return { context, sender, calls, job, storage };
}
test('extension network services reject foreign callers, arbitrary hosts and another tab’s catalogue session', async () => {
  const { context, sender, calls } = fixture();
  for (const url of [
    'http://www.iso.org/search.html?q=ISO',
    'https://evil.test/standard/1.html',
    'https://www.iso.org:8443/standard/1.html',
    'https://user@www.iso.org/standard/1.html',
    'https://www.iso.org/other',
  ])
    assert.throws(() => context.isoAddress(url));
  await assert.rejects(
    context.handleService({ type: 'ISO_OPEN' }, { ...sender, url: 'https://evil.test/' }),
  );
  await assert.rejects(context.handleService({ type: 'ISO_OPEN' }, { ...sender, frameId: 1 }));
  await assert.rejects(
    context.handleService({ type: 'ISO_CLOSE', session: 'owned' }, { ...sender, tab: { id: 6 } }),
  );
  await assert.rejects(context.handleService({ type: 'SEARCH', query: '\nISO 5458' }, sender));
  assert.equal(calls.length, 0);
});
test('inline challenge controls target only the active Doc88 challenge and validate session tokens and coordinates', async () => {
  const { context, sender, calls, job } = fixture();
  await assert.rejects(context.handleService({ type: 'CHALLENGE_FRAME', id: 'other' }, sender));
  const frame = await context.handleService({ type: 'CHALLENGE_FRAME', id: 'capture' }, sender);
  assert.match(frame.image, /^data:image\/jpeg;base64,/);
  const input = { type: 'down', token: frame.token, x: 0.2, y: 0.5 };
  const send = (value) =>
    context.handleService({ type: 'CHALLENGE_INPUT', id: 'capture', input: value }, sender);
  await assert.rejects(send({ ...input, token: 'wrong' }));
  await assert.rejects(send({ ...input, x: 1.2 }));
  await assert.rejects(send({ ...input, y: NaN }));
  assert.equal(calls.filter((call) => call[0] === 'Input.dispatchMouseEvent').length, 0);
  await send(input);
  await send({ ...input, type: 'move', x: 0.7 });
  await send({ ...input, type: 'up', x: 0.7 });
  assert.deepEqual(
    calls.filter((call) => call[0] === 'Input.dispatchMouseEvent').map((call) => call[1].type),
    ['mousePressed', 'mouseMoved', 'mouseReleased'],
  );
  job.challenge = false;
  await assert.rejects(send(input));
  job.challenge = true;
  await context.releaseChallenge(job);
  await context.handleService({ type: 'CHALLENGE_FRAME', id: 'capture' }, sender);
  assert.equal(calls.filter((call) => call[0] === 'attach').length, 2);
});
