'use strict';
const path = require('node:path');
// One ordinary browser session per job. Pages release their own tabs, while
// cookies and site state remain available for search, records and downloads.
function createAnnaBrowser(dataDirectory, signal, { launchContext } = {}) {
  let pending,
    closing,
    closed = false;
  const close = () => {
    if (closing) return closing;
    closed = true;
    signal.removeEventListener('abort', stop);
    closing = (async () => {
      if (pending) {
        const context = await pending.catch(() => null);
        await context?.close().catch(() => {});
      }
    })();
    return closing;
  };
  const stop = () => {
    void close();
  };
  signal.addEventListener('abort', stop, { once: true });
  return {
    async lease() {
      signal.throwIfAborted();
      if (closed) throw Error('Сеанс поиска уже закрыт.');
      pending ||= launchContext
        ? launchContext()
        : require('playwright').chromium.launchPersistentContext(
            path.join(dataDirectory, 'anna-experiment-profile'),
            {
              channel: require('../runtime.cjs').browserChannel(),
              headless: true,
              acceptDownloads: true,
              viewport: { width: 960, height: 720 },
            },
          );
      const context = await pending;
      signal.throwIfAborted();
      if (closed) throw Error('Сеанс поиска уже закрыт.');
      const pages = new Set();
      let released;
      return {
        async newPage() {
          signal.throwIfAborted();
          if (released || closed) throw Error('Страница поиска уже закрыта.');
          const page = await context.newPage();
          pages.add(page);
          return page;
        },
        newCDPSession: (page) => context.newCDPSession(page),
        close() {
          return (released ||= Promise.all([...pages].map((page) => page.close().catch(() => {}))));
        },
      };
    },
    close,
  };
}
module.exports = { createAnnaBrowser };
