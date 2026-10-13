'use strict';
// Only runs on our converter page. No document data is sent to a server.
window.addEventListener('message', async (event) => {
  if (
    event.source !== window ||
    event.origin !== location.origin ||
    event.data?.channel !== 'DOC88_PAGE_COMMAND'
  )
    return;
  const { type, request, id, url } = event.data;
  if (!['PING', 'READY', 'START_URL', 'CANCEL', 'FINISH'].includes(type)) return;
  let result;
  try {
    result = await chrome.runtime.sendMessage({ channel: 'DOC88_PDF', type, id, url });
  } catch {
    result = { error: 'Расширение отключено или обновлено. Перезагрузи страницу.' };
  }
  window.postMessage({ channel: 'DOC88_EXT_REPLY', request, result }, location.origin);
});
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || message?.channel !== 'DOC88_PDF') return;
  window.postMessage({ ...message, channel: 'DOC88_EXT_EVENT' }, location.origin);
  reply({ ok: true });
});
