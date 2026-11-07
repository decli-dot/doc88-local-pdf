'use strict';
const pending = new Map();
const handlers = [];
window.addEventListener('message', async (event) => {
  if (event.source !== window || event.origin !== location.origin) return;
  const message = event.data;
  if (message?.channel === 'DOC88_EXT_REPLY') {
    const request = pending.get(message.request);
    if (!request) return;
    pending.delete(message.request);
    clearTimeout(request.timer);
    if (message.result?.error) request.reject(Error(message.result.error));
    else request.resolve(message.result);
  } else if (message?.channel === 'DOC88_EXT_EVENT') {
    let error;
    try {
      for (const handler of handlers) await handler(message);
    } catch (failure) {
      error = failure.message;
    }
    if (message.ack)
      window.postMessage(
        { channel: 'DOC88_PAGE_EVENT_ACK', id: message.id, index: message.index, error },
        location.origin,
      );
  }
});
function command(type, extra = {}, timeout = 60000) {
  const request = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(request);
      reject(Error('Расширение не отвечает. Установи или обнови его и перезагрузи страницу.'));
    }, timeout);
    pending.set(request, { resolve, reject, timer });
    window.postMessage({ ...extra, type, request, channel: 'DOC88_PAGE_COMMAND' }, location.origin);
  });
}
async function installed() {
  const result = await command('PING', {}, 1800);
  if (Number(result.version?.split('.')[1]) < 9 && Number(result.version?.split('.')[0]) <= 1)
    throw Error('Обнови расширение до версии 1.9.0 или новее по инструкции над формой.');
  return result;
}
function events(callback) {
  handlers.push(callback);
}
async function catalogueContext() {
  await installed();
  const { session } = await command('ISO_OPEN');
  let data;
  const page = {
    async goto(url) {
      data = (await command('ISO_READ', { session, url }, 250000)).data;
    },
    async waitForFunction() {},
    async evaluate() {
      return data;
    },
  };
  return {
    pages: () => [page],
    async newCDPSession() {
      throw Error('Служебное окно не требуется.');
    },
    close: () => command('ISO_CLOSE', { session }).catch(() => {}),
  };
}
module.exports = { command, installed, events, catalogueContext };
