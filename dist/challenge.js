'use strict';
(() => {
  const panel = document.getElementById('challenge-panel');
  const image = document.getElementById('challenge-image');
  const status = document.getElementById('challenge-status');
  const loading = document.getElementById('challenge-loading');
  const screen = document.getElementById('challenge-screen');
  let jobId = null;
  let frame = null;
  let timer = null;
  let fetching = false;
  let generation = 0;
  let dragging = null;
  let actions = Promise.resolve();
  let pendingMove = null;
  let lastMove = 0;
  async function request(url, value) {
    const response = await (window.Doc88Browser?.fetch || fetch)(url, {
      method: value ? 'POST' : 'GET',
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
      headers: { 'x-doc88-request': '1', ...(value ? { 'Content-Type': 'application/json' } : {}) },
      ...(value ? { body: JSON.stringify(value) } : {}),
    });
    const data = await response.json();
    if (!response.ok)
      throw Object.assign(new Error(data.error || 'Не удалось обновить проверку.'), {
        status: response.status,
      });
    return data;
  }
  async function refresh() {
    if (!jobId || fetching) return;
    fetching = true;
    const current = generation;
    const id = jobId;
    try {
      const next = await request(`/api/jobs/${id}/challenge/frame`);
      if (current !== generation) return;
      if (dragging && dragging.token !== next.token) dragging = null;
      frame = next;
      image.src = next.image;
      image.hidden = false;
      loading.hidden = true;
      screen.setAttribute('aria-busy', 'false');
      status.textContent = 'Передвинь ползунок. После подтверждения обработка продолжится сама.';
    } catch (error) {
      if (current !== generation) return;
      status.textContent = [404, 409].includes(error.status)
        ? 'Проверяем подтверждение…'
        : 'Не удалось обновить изображение. Нажми «Обновить изображение».';
    } finally {
      fetching = false;
      if (current === generation && jobId) timer = setTimeout(refresh, 350);
      else if (jobId) void refresh();
    }
  }
  function coordinates(event) {
    const rect = image.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    };
  }
  function send(type, point, source = dragging || (frame && { token: frame.token, jobId })) {
    if (!source?.jobId) return;
    const input = { type, token: source.token, ...point };
    if (
      type === 'move' &&
      pendingMove?.jobId === source.jobId &&
      pendingMove.input.token === source.token
    ) {
      pendingMove.input = input;
      return;
    }
    const action = { jobId: source.jobId, input };
    if (type === 'move') pendingMove = action;
    const pending = actions.then(() => {
      if (pendingMove === action) pendingMove = null;
      return request(`/api/jobs/${action.jobId}/challenge/input`, action.input);
    });
    actions = pending.catch((error) => {
      if (source.jobId === jobId && ![404, 409].includes(error.status))
        status.textContent = 'Движение не передалось. Отпусти ползунок и обнови изображение.';
    });
  }
  image.onpointerdown = (event) => {
    if (!frame || !jobId || event.button !== 0 || dragging) return;
    event.preventDefault();
    dragging = { token: frame.token, jobId, pointerId: event.pointerId, point: coordinates(event) };
    image.setPointerCapture(event.pointerId);
    send('down', dragging.point);
  };
  image.onpointermove = (event) => {
    if (!frame || !jobId || (dragging && dragging.pointerId !== event.pointerId)) return;
    if (dragging) {
      event.preventDefault();
      dragging.point = coordinates(event);
    }
    const now = performance.now();
    if (now - lastMove < 32) return;
    lastMove = now;
    send('move', coordinates(event));
  };
  function finish(event) {
    if (!dragging || dragging.pointerId !== event.pointerId) return;
    const previous = dragging;
    const point =
      event.type === 'pointercancel' || event.type === 'lostpointercapture'
        ? previous.point
        : coordinates(event);
    send('move', point, previous);
    send('up', point, previous);
    dragging = null;
    if (image.hasPointerCapture(event.pointerId)) image.releasePointerCapture(event.pointerId);
  }
  image.onpointerup = finish;
  image.onpointercancel = finish;
  image.onlostpointercapture = finish;
  image.ondragstart = (event) => event.preventDefault();
  function render(job) {
    const next =
      job?.challengeAvailable && !['done', 'error', 'cancelled'].includes(job.stage)
        ? job.id
        : null;
    if (next === jobId) return;
    if (dragging) {
      send('up', dragging.point, dragging);
      dragging = null;
    }
    jobId = next;
    generation++;
    clearTimeout(timer);
    frame = null;
    image.hidden = true;
    image.removeAttribute('src');
    loading.hidden = false;
    screen.setAttribute('aria-busy', 'true');
    panel.hidden = !next;
    document.querySelector('.workspace').classList.toggle('has-challenge', Boolean(next));
    if (next) void refresh();
  }
  document.getElementById('challenge-refresh').onclick = () => {
    clearTimeout(timer);
    void refresh();
  };
  window.addEventListener('pagehide', () => {
    if (dragging)
      (window.Doc88Browser?.fetch || fetch)(`/api/jobs/${dragging.jobId}/challenge/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-doc88-request': '1' },
        body: JSON.stringify({ type: 'up', token: dragging.token, ...dragging.point }),
        keepalive: true,
      }).catch(() => {});
  });
  window.Doc88Challenge = { render };
})();
