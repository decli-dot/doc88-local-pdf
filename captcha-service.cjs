'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { atomicWrite } = require('./checkpoints.cjs');

const defaults = {
  version: 1,
  provider: 'rucaptcha',
  enabled: false,
  apiKey: '',
  maxPerJob: null,
  maxPerDay: null,
};
function configuration(value, previous = defaults) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('Неверные настройки RuCaptcha.');
  const next = { ...previous };
  if (value.provider !== undefined && value.provider !== 'rucaptcha')
    throw Error('Выберите RuCaptcha.');
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== 'boolean') throw Error('Укажите, включено ли решение капч.');
    next.enabled = value.enabled;
  }
  if (value.apiKey !== undefined) {
    if (
      typeof value.apiKey !== 'string' ||
      (value.apiKey && !/^[a-f\d]{32}$/i.test(value.apiKey.trim()))
    )
      throw Error('Ключ RuCaptcha должен содержать 32 символа.');
    next.apiKey = value.apiKey.trim();
  }
  for (const [key, maximum] of [
    ['maxPerJob', 5],
    ['maxPerDay', 50],
  ]) {
    if (value[key] === undefined) continue;
    if (value[key] === null) {
      next[key] = null;
      continue;
    }
    if (!Number.isInteger(value[key]) || value[key] < 1 || value[key] > maximum)
      throw Error('Лимит попыток находится вне допустимого диапазона.');
    next[key] = value[key];
  }
  return next;
}
function failure(code) {
  return Object.assign(Error('RuCaptcha: ' + code), { code });
}

async function createCaptchaService(
  directory,
  { fetchImpl = fetch, sleep = delay, now = Date.now, pollMs = 5000, timeoutMs = 300000 } = {},
) {
  const settingsFile = path.join(directory, 'captcha-settings.json');
  const usageFile = path.join(directory, 'captcha-usage.json');
  async function read(file, fallback) {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return fallback;
    }
  }
  let settings = configuration(await read(settingsFile, defaults));
  let usage = await read(usageFile, { version: 1, jobs: {}, days: {}, attempts: [] });
  if (usage.version !== 1 || !usage.jobs || !usage.days || !Array.isArray(usage.attempts))
    throw Error('Не удалось прочитать счётчик платных попыток.');
  let serial = Promise.resolve();
  let balanceInfo = null;
  const lock = (fn) => {
    const result = serial.then(fn);
    serial = result.catch(() => {});
    return result;
  };
  const day = () => new Date(now()).toISOString().slice(0, 10);
  const summary = () => ({
    provider: 'rucaptcha',
    enabled: settings.enabled,
    configured: Boolean(settings.apiKey),
    maxPerJob: settings.maxPerJob,
    maxPerDay: settings.maxPerDay,
    attemptsToday: usage.days[day()] || 0,
    dayUTC: day(),
    ...(balanceInfo || {}),
    recent: usage.attempts.slice(-5).map(({ id, type, status, code, at, cost, pollRetries }) => ({
      id,
      type,
      status,
      code,
      at,
      cost,
      pollRetries,
    })),
  });
  async function saveUsage() {
    await fs.mkdir(directory, { recursive: true });
    await atomicWrite(usageFile, JSON.stringify(usage));
  }
  async function request(method, key, value, signal) {
    signal?.throwIfAborted();
    const deadline = AbortSignal.timeout(20000);
    try {
      const response = await fetchImpl('https://api.rucaptcha.com/' + method, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: key, ...value }),
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      });
      if (!response.ok)
        throw failure(
          [429, 500, 502, 503, 504].includes(response.status)
            ? 'CAPTCHA_SERVICE_TEMPORARY'
            : 'CAPTCHA_SERVICE_HTTP_ERROR',
        );
      const data = await response.json();
      if (data.errorId !== 0)
        throw failure(
          typeof data.errorCode === 'string' && /^[A-Z\d_]{1,80}$/.test(data.errorCode)
            ? data.errorCode
            : 'CAPTCHA_SERVICE_ERROR',
        );
      return data;
    } catch (error) {
      signal?.throwIfAborted();
      if (deadline.aborted || error.name === 'TimeoutError')
        throw failure('CAPTCHA_SERVICE_TIMEOUT');
      if (typeof error.code === 'string' && /^[A-Z\d_]{1,80}$/.test(error.code))
        throw failure(error.code);
      throw failure('CAPTCHA_SERVICE_CONNECTION');
    }
  }
  async function finish(id, status, extra = {}) {
    return lock(async () => {
      const attempt = usage.attempts.find((a) => a.id === id);
      if (!attempt) return;
      attempt.status = status;
      // Never store the task image, response token, key or external error text.
      if (extra.code && /^[A-Z\d_]{1,80}$/.test(extra.code)) attempt.code = extra.code;
      if (Number.isFinite(Number(extra.cost)) && extra.cost !== undefined)
        attempt.cost = Number(extra.cost);
      if (Number.isSafeInteger(extra.taskId)) attempt.taskId = extra.taskId;
      if (Number.isSafeInteger(extra.pollRetries)) attempt.pollRetries = extra.pollRetries;
      await saveUsage();
    });
  }
  return {
    summary,
    async update(value) {
      return lock(async () => {
        const next = configuration(value, settings);
        await fs.mkdir(directory, { recursive: true });
        await atomicWrite(settingsFile, JSON.stringify(next));
        if (next.apiKey !== settings.apiKey) balanceInfo = null;
        settings = next;
        return summary();
      });
    },
    async balance(signal) {
      if (!settings.apiKey) throw failure('CAPTCHA_KEY_REQUIRED');
      const result = await request('getBalance', settings.apiKey, {}, signal);
      if (!Number.isFinite(result.balance) || result.balance < 0)
        throw failure('CAPTCHA_SERVICE_RESPONSE');
      balanceInfo = { balance: result.balance, balanceCheckedAt: new Date(now()).toISOString() };
      return summary();
    },
    finish,
    async solve(jobId, task, { signal, fingerprint } = {}) {
      signal?.throwIfAborted();
      if (
        ![
          'CoordinatesTask',
          'ImageToTextTask',
          'TurnstileTaskProxyless',
          'RecaptchaV2TaskProxyless',
        ].includes(task?.type)
      )
        throw failure('CAPTCHA_UNSUPPORTED');
      // Reserve before the non-idempotent network request. An uncertain request
      // consumes the allowance too; never retry createTask automatically.
      const { key, attempt } = await lock(async () => {
        signal?.throwIfAborted();
        if (!settings.enabled || !settings.apiKey) throw failure('CAPTCHA_DISABLED');
        if (
          usage.attempts.some(
            (a) => a.jobId === jobId && a.fingerprint === fingerprint && fingerprint,
          )
        )
          throw failure('CAPTCHA_ALREADY_ATTEMPTED');
        if (
          (settings.maxPerJob !== null && (usage.jobs[jobId] || 0) >= settings.maxPerJob) ||
          (settings.maxPerDay !== null && (usage.days[day()] || 0) >= settings.maxPerDay)
        )
          throw failure('CAPTCHA_ATTEMPT_LIMIT');
        const attempt = {
          id: randomUUID(),
          jobId,
          fingerprint,
          type: task.type,
          at: new Date(now()).toISOString(),
          status: 'reserved',
        };
        usage.jobs[jobId] = (usage.jobs[jobId] || 0) + 1;
        usage.days[day()] = (usage.days[day()] || 0) + 1;
        usage.attempts.push(attempt);
        // Keep fingerprints for all attempts of retained jobs, including resumes.
        await saveUsage();
        return { key: settings.apiKey, attempt };
      });
      const combined = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs);
      try {
        const created = await request('createTask', key, { task }, combined);
        if (!Number.isSafeInteger(created.taskId) || created.taskId <= 0)
          throw failure('CAPTCHA_SERVICE_RESPONSE');
        await finish(attempt.id, 'processing', { taskId: created.taskId });
        let pollFailures = 0,
          pollRetries = 0;
        for (;;) {
          await sleep(Math.max(5000, pollMs), undefined, { signal: combined });
          let result;
          try {
            result = await request('getTaskResult', key, { taskId: created.taskId }, combined);
            pollFailures = 0;
          } catch (error) {
            combined.throwIfAborted();
            if (
              [
                'CAPTCHA_SERVICE_CONNECTION',
                'CAPTCHA_SERVICE_TIMEOUT',
                'CAPTCHA_SERVICE_TEMPORARY',
              ].includes(error.code) &&
              ++pollFailures <= 3
            ) {
              await finish(attempt.id, 'processing', { pollRetries: ++pollRetries });
              continue; // Poll the same paid task, never submit another image.
            }
            throw error;
          }
          if (result.status === 'processing') continue;
          if (result.status !== 'ready' || !result.solution || typeof result.solution !== 'object')
            throw failure('CAPTCHA_SERVICE_RESPONSE');
          await finish(attempt.id, 'answered', { cost: result.cost });
          return { id: attempt.id, solution: result.solution };
        }
      } catch (error) {
        const code = signal?.aborted
          ? 'CAPTCHA_CANCELLED'
          : combined.aborted
            ? 'CAPTCHA_TIMEOUT'
            : typeof error.code === 'string'
              ? error.code
              : 'CAPTCHA_SERVICE_ERROR';
        await finish(attempt.id, 'error', { code });
        signal?.throwIfAborted();
        throw failure(code);
      }
    },
  };
}
module.exports = { configuration, createCaptchaService };
