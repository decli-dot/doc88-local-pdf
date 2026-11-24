'use strict';
const { randomBytes, scryptSync, timingSafeEqual } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { present } = require('./dist/product.js');
const { feedback } = require('./dist/job-feedback.js');
const COOKIE = 'declipdf_dev';
function passwordRecord(password) {
  const salt = randomBytes(24).toString('hex');
  return { salt, hash: scryptSync(password, salt, 64).toString('hex') };
}
function publicJob(job) {
  const keep = [
    'id',
    'kind',
    'query',
    'resolvedQuery',
    'title',
    'stage',
    'createdAt',
    'finishedAt',
    'canResume',
    'pdfReady',
    'pdfFilename',
    'review',
    'ocrLanguage',
    'documentLanguage',
    'languageChoices',
    'languageScope',
    'languageDocumentCount',
    'languageException',
    'catalogueExtentUnknown',
    'batchId',
    'isoChoices',
    'seriesOptions',
    'seriesReference',
    'choicePublisher',
    'challengeAvailable',
    'captchaSolving',
  ];
  const result = Object.fromEntries(keep.filter((key) => key in job).map((key) => [key, job[key]]));
  if (result.kind === 'anna') result.kind = 'search';
  Object.assign(result, feedback(job));
  result.message = result.problem?.message || result.progress.message;
  if (job.stage === 'done' && job.catalogueExtentUnknown)
    result.message =
      'Объём издания в каталоге EN не указан. Проверена загрузка всех страниц источника.';
  if (job.stage === 'done' && job.pdfReady) {
    for (const key of [
      'total',
      'bytes',
      'isoEdition',
      'catalogueEdition',
      'copyTextReady',
      'documentStructure',
      'normativeReferences',
    ])
      if (key in job) result[key] = job[key];
  }
  return present(result);
}
async function createDevAccess(directory) {
  let record;
  try {
    record = JSON.parse(await fs.readFile(path.join(directory, 'dev-access.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (process.env.DECLIPDF_DEV_PASSWORD) record = passwordRecord(process.env.DECLIPDF_DEV_PASSWORD);
  const sessions = new Map(),
    attempts = new Map();
  const token = (request) =>
    request.headers.cookie
      ?.split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith(COOKIE + '='))
      ?.slice(COOKIE.length + 1);
  function authenticated(request) {
    const key = token(request),
      expiry = sessions.get(key);
    if (expiry > Date.now()) return true;
    if (key) sessions.delete(key);
    return false;
  }
  return {
    configured: Boolean(record),
    authenticated,
    login(request, response, password) {
      const address = request.socket.remoteAddress,
        now = Date.now();
      const recent = (attempts.get(address) || []).filter((at) => now - at < 60000);
      if (recent.length >= 5)
        throw Object.assign(Error('Слишком много попыток. Повторите через минуту.'), {
          status: 429,
        });
      recent.push(now);
      attempts.set(address, recent);
      const valid =
        typeof password === 'string' &&
        password.length > 0 &&
        password.length <= 256 &&
        record &&
        timingSafeEqual(scryptSync(password, record.salt, 64), Buffer.from(record.hash, 'hex'));
      if (!valid) throw Object.assign(Error('Неверный пароль.'), { status: 401 });
      attempts.delete(address);
      for (const [key, expires] of sessions) if (expires <= now) sessions.delete(key);
      if (sessions.size >= 20) sessions.delete(sessions.keys().next().value);
      const key = randomBytes(32).toString('hex');
      sessions.set(key, now + 3600000);
      response.setHeader(
        'Set-Cookie',
        `${COOKIE}=${key}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=3600`,
      );
    },
    logout(request, response) {
      sessions.delete(token(request));
      response.setHeader(
        'Set-Cookie',
        `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/api; Max-Age=0`,
      );
    },
  };
}
module.exports = { passwordRecord, publicJob, createDevAccess };
