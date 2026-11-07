const test = require('node:test');
const assert = require('node:assert/strict');
const { createChallengeView, allowedDocument } = require('../challenge-view.cjs');
function fixture() {
  const calls = [];
  let url = 'https://www.doc88.com/p-123.html';
  let visible = true;
  const page = {
    url: () => url,
    isClosed: () => false,
    mouse: {
      move: async (x, y) => calls.push(['move', x, y]),
      down: async () => calls.push(['down']),
      up: async () => calls.push(['up']),
    },
  };
  const cdp = {
    send: async (method, options) => {
      calls.push([method, options]);
      return { data: 'cG5n' };
    },
  };
  const evaluate = async () =>
    visible
      ? {
          id: 'captcha_reading',
          x: 500,
          y: 350,
          width: 270,
          height: 36,
          scrollX: 0,
          scrollY: 100,
          viewportWidth: 1280,
          viewportHeight: 900,
        }
      : null;
  return {
    view: createChallengeView({ page, cdp, evaluate }),
    calls,
    setURL: (value) => (url = value),
    setVisible: (value) => (visible = value),
  };
}
test('challenge control stays on Doc88 document pages and validates pointer tokens and bounds', async () => {
  for (const url of [
    'http://www.doc88.com/p-1.html',
    'https://www.doc88.com.evil.test/p-1.html',
    'https://www.doc88.com/member.php',
    'https://x:y@www.doc88.com/p-1.html',
    'https://www.doc88.com:444/p-1.html',
  ])
    assert.equal(allowedDocument(url), false);
  const app = fixture();
  const frame = await app.view.frame();
  assert.equal(frame.width, 440);
  assert.equal(frame.height, 360);
  assert.match(frame.image, /^data:image\/png;base64,/);
  const shot = app.calls.find(([name]) => name === 'Page.captureScreenshot')[1];
  assert.equal(shot.clip.y, 171); // Screenshot uses document coordinates; pointer uses viewport coordinates.
  for (const value of [
    { type: 'down', token: 'wrong', x: 0.5, y: 0.5 },
    { type: 'key', token: frame.token, x: 0.5, y: 0.5 },
    { type: 'down', token: frame.token, x: NaN, y: 0.5 },
    { type: 'down', token: frame.token, x: 1.1, y: 0.5 },
  ])
    await assert.rejects(app.view.input(value));
  assert.equal(
    app.calls.some(([name]) => name === 'down'),
    false,
  );
  app.setURL('https://evil.test/');
  await assert.rejects(app.view.input({ type: 'down', token: frame.token, x: 0.5, y: 0.5 }));
  await assert.rejects(app.view.frame());
  await app.view.close();
});
test('human drag events preserve order and release the mouse when a challenge closes', async () => {
  const app = fixture();
  const first = await app.view.frame();
  const pointer = (type, x, y) => app.view.input({ token: first.token, type, x, y });
  await Promise.all([
    pointer('down', 0.1, 0.8),
    pointer('move', 0.6, 0.8),
    pointer('up', 0.6, 0.8),
  ]);
  assert.deepEqual(
    app.calls.filter(([name]) => ['move', 'down', 'up'].includes(name)).map(([name]) => name),
    ['move', 'down', 'move', 'up'],
  );
  await pointer('down', 0.2, 0.8);
  await app.view.reset();
  assert.equal(app.calls.at(-1)[0], 'up');
  const second = await app.view.frame();
  assert.notEqual(second.token, first.token);
  await assert.rejects(pointer('down', 0.2, 0.8));
  await app.view.input({ type: 'down', token: second.token, x: 0.2, y: 0.8 });
  app.setVisible(false);
  await app.view.input({ type: 'up', token: second.token, x: 0.2, y: 0.8 });
  assert.equal(app.calls.at(-1)[0], 'up');
  await app.view.close();
  await assert.rejects(app.view.frame());
});
