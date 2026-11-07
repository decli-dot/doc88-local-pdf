'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { dependency } = require('./runtime.cjs');
const { digest } = require('./page-check.cjs');
const JSZip = dependency('jszip');
const MAX_IMAGE = 30 * 1024 * 1024;
const MAX_TOTAL = 800 * 1024 * 1024;
async function atomicWrite(file, bytes) {
  await fs.writeFile(file + '.tmp', bytes);
  await fs.rename(file + '.tmp', file);
}
function imageType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  return null;
}
async function readJSON(file) {
  try {
    if ((await fs.stat(file)).size > 1024 * 1024) return null;
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}
async function cachedArchive(job) {
  const record = await readJSON(path.join(job.directory, 'download-complete.json'));
  if (
    !record ||
    record.url !== job.url ||
    record.fromPage !== job.fromPage ||
    record.toPage !== job.toPage
  )
    return false;
  try {
    const file = path.join(job.directory, 'archive.zip');
    if ((await fs.stat(file)).size > 250 * 1024 * 1024) return false;
    if (digest(await fs.readFile(file)) !== record.hash) return false;
    job.update({
      title: record.title,
      total: record.total,
      current: record.total,
      archiveReady: true,
      archiveFilename: record.filename,
      reusedDownloadPages: record.total,
    });
    return true;
  } catch {
    return false;
  }
}
async function capturePages(job, info, capture) {
  const first = job.fromPage,
    last = job.toPage ?? info.count;
  const identity = JSON.stringify({ url: job.url, first, last, count: info.count });
  const directory = path.join(job.directory, 'download-pages', digest(identity).slice(0, 24));
  await fs.mkdir(directory, { recursive: true });
  const manifestFile = path.join(directory, 'checkpoint.json');
  const saved = await readJSON(manifestFile);
  const manifest =
    saved?.identity === identity && saved.pages && typeof saved.pages === 'object'
      ? saved
      : { identity, pages: {} };
  const zip = new JSZip();
  let totalBytes = 0,
    reused = 0;
  for (let page = first; page <= last; page++) {
    job.controller.signal.throwIfAborted();
    const record = manifest.pages[page];
    let bytes;
    if (record && ['jpg', 'png'].includes(record.type)) {
      try {
        const file = path.join(directory, `page${page}.${record.type}`);
        if ((await fs.stat(file)).size <= MAX_IMAGE) {
          const candidate = await fs.readFile(file);
          if (digest(candidate) === record.hash && imageType(candidate)) {
            bytes = candidate;
            reused++;
          }
        }
      } catch {
        /* A missing or damaged page is captured again. */
      }
    }
    if (!bytes) {
      bytes = await capture(page);
      job.controller.signal.throwIfAborted();
      if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_IMAGE || !imageType(bytes))
        throw Error(`Не удалось сохранить изображение страницы ${page}.`);
      const type = imageType(bytes);
      await atomicWrite(path.join(directory, `page${page}.${type}`), bytes);
      manifest.pages[page] = { type, hash: digest(bytes) };
      await atomicWrite(manifestFile, JSON.stringify(manifest));
    }
    totalBytes += bytes.length;
    if (totalBytes > MAX_TOTAL)
      throw Error('Изображения документа превышают допустимый объём. Укажи диапазон.');
    zip.file(`page${String(page).padStart(5, '0')}.${imageType(bytes)}`, bytes);
    job.update({
      stage: 'downloading',
      current: page - first + 1,
      reusedDownloadPages: reused,
      message: `Сохранено страниц: ${page - first + 1} из ${last - first + 1}${reused ? `; восстановлено: ${reused}` : ''}`,
    });
  }
  const archive = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  job.controller.signal.throwIfAborted();
  if (archive.length > 250 * 1024 * 1024)
    throw Error('Архив больше 250 МБ. Укажи диапазон страниц.');
  await atomicWrite(path.join(job.directory, 'archive.zip'), archive);
  const filename = info.filename || 'pages.zip';
  await atomicWrite(
    path.join(job.directory, 'download-complete.json'),
    JSON.stringify({
      url: job.url,
      fromPage: job.fromPage,
      toPage: job.toPage,
      total: last - first + 1,
      title: info.title,
      filename,
      hash: digest(archive),
    }),
  );
  job.update({ archiveReady: true, archiveFilename: filename });
}
module.exports = { atomicWrite, readJSON, imageType, capturePages, cachedArchive };
