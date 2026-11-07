'use strict';
// Only runs on our converter page. No document data is sent to a server.
window.addEventListener('message', async (event) => {
  if (
    event.source !== window ||
    event.origin !== location.origin ||
    event.data?.channel !== 'DOC88_PAGE_COMMAND'
  )
    return;
  const { type, request, ...payload } = event.data;
  if (
    ![
      'PING',
      'READY',
      'START_URL',
      'CANCEL',
      'FINISH',
      'GET_CAPTURE',
      'RESET_CAPTURE',
      'SEARCH',
      'ISO_OPEN',
      'ISO_READ',
      'ISO_CLOSE',
      'CHALLENGE_FRAME',
      'CHALLENGE_INPUT',
    ].includes(type)
  )
    return;
  let result;
  try {
    result = await chrome.runtime.sendMessage({ ...payload, channel: 'DOC88_PDF', type });
  } catch {
    result = { error: 'Расширение отключено или обновлено. Перезагрузи страницу.' };
  }
  window.postMessage({ channel: 'DOC88_EXT_REPLY', request, result }, location.origin);
});
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || message?.channel !== 'DOC88_PDF') return;
  if (message.ack) {
    const timer = setTimeout(() => {
      window.removeEventListener('message', acknowledge);
      reply({ error: 'Страница обработки не подтвердила сохранение изображения.' });
    }, 30000);
    function acknowledge(event) {
      if (
        event.source !== window ||
        event.origin !== location.origin ||
        event.data?.channel !== 'DOC88_PAGE_EVENT_ACK' ||
        event.data.id !== message.id ||
        event.data.index !== message.index
      )
        return;
      clearTimeout(timer);
      window.removeEventListener('message', acknowledge);
      reply(event.data.error ? { error: event.data.error } : { ok: true });
    }
    window.addEventListener('message', acknowledge);
    window.postMessage({ ...message, channel: 'DOC88_EXT_EVENT' }, location.origin);
    return true;
  }
  window.postMessage({ ...message, channel: 'DOC88_EXT_EVENT' }, location.origin);
  reply({ ok: true });
});
