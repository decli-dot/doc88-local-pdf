'use strict';
const serviceTypes = new Set([
  'SEARCH',
  'ISO_OPEN',
  'ISO_READ',
  'ISO_CLOSE',
  'CHALLENGE_FRAME',
  'CHALLENGE_INPUT',
]);
async function sessionRecord(session, sender) {
  const entry = (await chrome.storage.session.get('isoSession')).isoSession;
  if (!entry || entry.session !== session || entry.owner !== sender.tab.id)
    throw Error('Сеанс каталога ISO закрыт.');
  return entry;
}
function isoAddress(value) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'www.iso.org' ||
    url.port ||
    url.username ||
    url.password ||
    !/^\/(?:search\.html|(?:[a-z]{2}\/)?standard\/[a-z\d-]+(?:\.html)?)$/i.test(url.pathname)
  )
    throw Error('Разрешён только официальный каталог ISO.');
  if (url.pathname === '/search.html') {
    const query = url.searchParams.get('q');
    if (!query || query.length > 180) throw Error('Некорректный запрос ISO.');
    return 'https://www.iso.org/search.html?' + new URLSearchParams({ q: query });
  }
  return url.origin + url.pathname;
}
function readISOPage(search) {
  if (search) {
    if (
      !document.querySelector('#search-results .card') &&
      !/\b0\s*results\s*found/i.test(document.getElementById('stats-container')?.innerText || '')
    )
      return null;
    return [...document.querySelectorAll('#search-results .card')].slice(0, 100).map((card) => {
      const link = card.querySelector('.card-title a');
      return {
        reference: link?.innerText.trim() || '',
        url: link?.href || '',
        status: card.querySelector('.card-footer')?.innerText.trim() || '',
        title: (card.querySelector('.card-title')?.innerText || '')
          .replace(link?.innerText.trim() || '', '')
          .trim(),
      };
    });
  }
  if (!document.querySelector('#content h1')) return null;
  const links = [...document.querySelectorAll('#lifecycle h4 a[href]')]
    .filter((a) => !a.closest('.sub-step'))
    .map((a) => ({
      reference: a.innerText.trim(),
      url: a.href,
      status:
        (a.closest('.step-item') || a.closest('.step'))
          ?.querySelector('.section-head')
          ?.innerText.trim() || '',
      phase: a.closest('.time-step')?.querySelector('h3')?.innerText.trim() || '',
    }));
  return {
    heading: document.querySelector('#content h1')?.innerText || '',
    title: document.title,
    text: (document.querySelector('#content')?.innerText || '').slice(0, 300000),
    status: document.querySelector('#lifecycle .step.active > .section-head')?.innerText.trim(),
    previous: links.filter((link) => /^Previously$/i.test(link.phase)),
    next: links.filter((link) =>
      /^(?:Revised by|Replaced by|Will be replaced by)/i.test(link.phase),
    ),
    supplements: [...document.querySelectorAll('#lifecycle .sub-step h4 a[href]')].map((a) => ({
      reference: a.innerText.trim(),
      url: a.href,
      status:
        (a.closest('.step-item') || a.closest('.step'))
          ?.querySelector('.section-head')
          ?.innerText.trim() || '',
    })),
  };
}
async function releaseChallenge(job) {
  if (!job) return;
  if (challengeState?.id === job.id && challengeState.pressed)
    await chrome.debugger
      .sendCommand({ tabId: job.sourceTab }, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: challengeState.lastX || 0,
        y: challengeState.lastY || 0,
        button: 'left',
        buttons: 0,
        clickCount: 1,
      })
      .catch(() => {});
  await chrome.debugger?.detach({ tabId: job.sourceTab }).catch(() => {});
  if (challengeState?.id === job.id) challengeState = null;
}
async function challengeJob(message, sender) {
  const job = await getJob();
  if (
    !job ||
    job.id !== message.id ||
    job.targetTab !== sender.tab.id ||
    job.phase !== 'capturing' ||
    !job.challenge
  )
    throw Error('Проверка Doc88 уже закрыта.');
  const tab = await chrome.tabs.get(job.sourceTab);
  if (docURL(tab.url) !== job.url) throw Error('Вкладка проверки перешла на другой адрес.');
  return job;
}
function challengeBounds() {
  const element = ['captcha_reading', 'continue_page']
    .map((id) => document.getElementById(id))
    .find((value) => value && value.getBoundingClientRect().width > 0);
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return {
    x: Math.max(0, rect.x + scrollX),
    y: Math.max(0, rect.y + scrollY),
    left: Math.max(0, rect.x),
    top: Math.max(0, rect.y),
    width: Math.min(rect.width, 1600),
    height: Math.min(rect.height, 1200),
  };
}
let challengeState;
async function handleService(message, sender) {
  if (!isSite(sender.url) || sender.frameId !== 0) throw Error('Открой программу на её странице.');
  if (message.type === 'SEARCH') {
    if (
      typeof message.query !== 'string' ||
      message.query.trim().length < 3 ||
      message.query.length > 180 ||
      /[\u0000-\u001f]/.test(message.query)
    )
      throw Error('Некорректный поисковый запрос.');
    const url = new URL('https://www.doc88.com/search/post.do');
    url.search = new URLSearchParams({
      from: '1',
      f: '0',
      h: '1',
      pageRange: '0',
      pageNum: '0',
      format: '',
      p: '1',
      q: message.query.replace(/:/g, ' '),
      sDate: '',
      eDate: '',
      ct: '0',
    });
    const response = await fetch(url, {
      credentials: 'include',
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw Error('Поиск Doc88 недоступен: HTTP ' + response.status);
    const reader = response.body.getReader(),
      chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 3 * 1024 * 1024) throw Error('Слишком большой ответ поиска.');
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    return { html: await new Blob(chunks).text() };
  }
  if (message.type === 'ISO_OPEN') {
    const existing = (await chrome.storage.session.get('isoSession')).isoSession;
    if (existing) throw Error('Каталог ISO уже используется. Дождись завершения поиска.');
    const tab = await chrome.tabs.create({ url: 'https://www.iso.org/search.html', active: false });
    const entry = { session: crypto.randomUUID(), owner: sender.tab.id, tabId: tab.id };
    await chrome.storage.session.set({ isoSession: entry });
    return { session: entry.session };
  }
  if (message.type === 'ISO_CLOSE') {
    const entry = await sessionRecord(message.session, sender);
    await chrome.storage.session.remove('isoSession');
    await chrome.tabs.remove(entry.tabId).catch(() => {});
    return { ok: true };
  }
  if (message.type === 'ISO_READ') {
    const entry = await sessionRecord(message.session, sender),
      url = isoAddress(message.url);
    await chrome.tabs.update(entry.tabId, { url });
    const deadline = Date.now() + 240000;
    let prompted = false;
    while (Date.now() < deadline) {
      await sessionRecord(message.session, sender);
      const tab = await chrome.tabs.get(entry.tabId);
      let address;
      try {
        address = isoAddress(tab.url);
      } catch {
        address = null;
      }
      if (tab.status === 'complete' && address === url) {
        const result = await chrome.scripting.executeScript({
          target: { tabId: entry.tabId },
          func: readISOPage,
          args: [new URL(url).pathname === '/search.html'],
        });
        const data = result[0]?.result;
        if (data !== null && data !== undefined) return { data };
        if (!prompted && Date.now() > deadline - 225000) {
          prompted = true;
          await notify(sender.tab.id, {
            type: 'CATALOGUE_WAIT',
            message:
              'Каталог ISO ещё не загрузился. Проверь открывшуюся вкладку ISO; если появилась проверка посетителя, пройди её — поиск продолжится.',
          }).catch(() => {});
          await chrome.tabs.update(entry.tabId, { active: true });
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
    throw Error('Каталог ISO не загрузился. Проверь его вкладку и повтори поиск.');
  }
  if (message.type === 'CHALLENGE_FRAME' || message.type === 'CHALLENGE_INPUT') {
    const job = await challengeJob(message, sender),
      target = { tabId: job.sourceTab };
    if (message.type === 'CHALLENGE_FRAME') {
      const result = await chrome.scripting.executeScript({ target, func: challengeBounds });
      const box = result[0]?.result;
      if (!box || box.width < 1 || box.height < 1) throw Error('Проверка больше не отображается.');
      if (!challengeState || challengeState.id !== job.id) {
        await chrome.debugger.attach(target, '1.3');
        challengeState = { id: job.id, token: crypto.randomUUID(), box, pressed: false };
      }
      challengeState.box = box;
      const screenshot = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', {
        format: 'jpeg',
        quality: 82,
        captureBeyondViewport: true,
        clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 },
      });
      return {
        token: challengeState.token,
        image: 'data:image/jpeg;base64,' + screenshot.data,
        width: box.width,
        height: box.height,
      };
    }
    const input = message.input,
      state = challengeState;
    if (
      !state ||
      state.id !== job.id ||
      input?.token !== state.token ||
      !['down', 'move', 'up'].includes(input.type) ||
      !Number.isFinite(input.x) ||
      !Number.isFinite(input.y) ||
      input.x < 0 ||
      input.x > 1 ||
      input.y < 0 ||
      input.y > 1
    )
      throw Error('Некорректное движение в панели проверки.');
    const type = { down: 'mousePressed', move: 'mouseMoved', up: 'mouseReleased' }[input.type];
    if (input.type === 'down') state.pressed = true;
    state.lastX = state.box.left + input.x * state.box.width;
    state.lastY = state.box.top + input.y * state.box.height;
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type,
      x: state.lastX,
      y: state.lastY,
      button: state.pressed || input.type === 'up' ? 'left' : 'none',
      buttons: input.type === 'up' ? 0 : state.pressed ? 1 : 0,
      clickCount: input.type === 'move' ? 0 : 1,
    });
    if (input.type === 'up') state.pressed = false;
    return { ok: true };
  }
  throw Error('Неизвестный запрос расширения.');
}
