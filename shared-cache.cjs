'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path');
const { randomUUID } = require('node:crypto');
const { digest } = require('./page-check.cjs');
const { PDFDocument } = require('pdf-lib');
const designation = require('./dist/standard-reference.js');
const {
  reference,
  formatReference,
  officialFullTitle,
  officialPDFName,
} = require('./iso-catalog.cjs');
const VERSION = 'verified-document-v2';
const MAX_FILE = 300 * 1024 * 1024,
  MAX_RESULT = 1024 * 1024 * 1024,
  MAX_ASSETS = 800 * 1024 * 1024;
function fileLimit(name) {
  if (name === 'result.pdf') return MAX_RESULT;
  if (name === 'manifest.json' || name === 'job.json') return 16 * 1024 * 1024;
  return MAX_FILE;
}
const fields = [
  'title',
  'sourceTitle',
  'url',
  'total',
  'pdfFilename',
  'archiveFilename',
  'textChars',
  'blankPages',
  'textlessPages',
  'ocrQuality',
  'pdfOptimization',
  'verification',
  'scriptVerification',
  'pageIntegrity',
  'documentStructure',
  'normativeReferences',
  'imageEnhancement',
  'processingEngine',
  'nativeTextPages',
  'repairedOCRPages',
  'copyTextReady',
  'archiveReady',
  'catalogueExtentUnknown',
];
function identity(job) {
  const query = job.resolvedQuery || job.query;
  const parsed = designation.parse(query) || reference(query);
  const edition = job.catalogueEdition || job.isoEdition;
  if (
    !parsed?.year ||
    !edition?.title ||
    !job.documentLanguage ||
    (!edition.pageCount && edition.extentPolicy !== 'source')
  )
    return null;
  const ref = parsed.publisher ? designation.format(parsed) : formatReference(parsed);
  return {
    version: VERSION,
    reference: ref,
    language: job.documentLanguage,
    mode: job.processingMode || 'auto',
    enhance: job.enhanceImages !== false,
    title: edition.title.normalize('NFKC').replace(/\s+/g, ' ').trim(),
    pages: edition.pageCount || null,
    extentPolicy: edition.extentPolicy || 'catalogue',
  };
}
function keyFor(value) {
  return digest(JSON.stringify(value));
}
function verified(job) {
  const requested = designation.parse(job.resolvedQuery || job.query || '');
  if (requested?.reaffirmed && job.verification?.identity?.reaffirmed !== requested.reaffirmed)
    return false;
  const checks = job.verification,
    script = job.scriptVerification || checks?.language?.scriptVerification;
  return Boolean(
    job.stage === 'done' &&
    job.pdfReady &&
    Number.isSafeInteger(job.total) &&
    job.total > 0 &&
    job.total <= 2000 &&
    checks?.language?.version === 2 &&
    checks.language.status === 'passed' &&
    checks.language.matchedLanguages?.includes(job.documentLanguage) &&
    checks.identity?.status === 'passed' &&
    checks.completeness?.status === 'passed' &&
    checks.completeness.pages === job.total &&
    checks.completeness.declaredPages === job.total &&
    (checks.extent?.status === 'passed' || job.catalogueEdition?.extentPolicy === 'source') &&
    script?.version === 1 &&
    script.status === 'passed' &&
    script.evidence?.some(
      (item) => ['Latin', 'Fraktur'].includes(item.script) && item.confidence >= 0.5,
    ) &&
    job.pageIntegrity?.status !== 'failed' &&
    checks.pageIntegrity?.status !== 'failed' &&
    (/^https:\/\/www\.doc88\.com\/p-\d+\.html$/.test(job.url || '') ||
      /^https:\/\/annas-archive\.pk\/md5\/[a-f\d]{32}$/.test(job.url || '')),
  );
}
function safePath(root, name) {
  if (
    typeof name !== 'string' ||
    !name ||
    name.includes('\\') ||
    name.includes(':') ||
    name.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw Error('Unsafe cache path.');
  const target = path.resolve(root, ...name.split('/'));
  if (!target.startsWith(path.resolve(root) + path.sep))
    throw Error('Cache path escaped its directory.');
  return target;
}
function allowedAsset(name) {
  return (
    /^(?:archive\.zip|download-complete\.json)$/.test(name) ||
    /^source\.pdf$/.test(name) ||
    /^scanned-pages\/(?:archive\.zip|ocr\/page\d{5}\.(?:json|pdf|txt))$/.test(name) ||
    /^ocr\/page\d{5}\.(?:json|pdf|txt)$/.test(name) ||
    /^direct\/(?:download-report\.json|converted\.json|source\.pdf|text\.txt|result\.pdf|swf\/page\d{5}\.swf)$/.test(
      name,
    ) ||
    /^resource-cache\/[a-f\d]{64}\.ebt(?:\.sha256)?$/.test(name)
  );
}
async function bytesAt(root, name) {
  const file = safePath(root, name),
    stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > fileLimit(name))
    throw Error('Invalid cache file.');
  return fs.readFile(file);
}
async function checkedFile(root, entry) {
  if (
    !entry ||
    !Number.isSafeInteger(entry.size) ||
    entry.size < 0 ||
    entry.size > fileLimit(entry.path) ||
    !/^[a-f\d]{64}$/.test(entry.sha256)
  )
    return null;
  try {
    const bytes = await bytesAt(root, entry.path);
    return bytes.length === entry.size && digest(bytes) === entry.sha256 ? bytes : null;
  } catch {
    return null;
  }
}
async function atomic(file, bytes) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    await fs.writeFile(temp, bytes);
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}
async function readEntry(dataDirectory, wanted) {
  const key = keyFor(wanted),
    base = path.join(dataDirectory, 'document-cache');
  try {
    const index = JSON.parse(await fs.readFile(path.join(base, 'index', key + '.json'), 'utf8'));
    if (!/^[a-f\d-]{36}$/.test(index.generation || '')) return null;
    const directory = path.join(base, 'entries', key, index.generation);
    const bytes = await bytesAt(directory, 'manifest.json');
    if (digest(bytes) !== index.sha256) return null;
    const manifest = JSON.parse(bytes);
    if (
      JSON.stringify(manifest.identity) !== JSON.stringify(wanted) ||
      manifest.version !== VERSION ||
      !Array.isArray(manifest.files) ||
      manifest.files.length > 10000
    )
      return null;
    if (
      !verified({
        ...manifest.meta,
        stage: 'done',
        pdfReady: true,
        documentLanguage: wanted.language,
        catalogueEdition: wanted.extentPolicy === 'source' ? { extentPolicy: 'source' } : null,
      })
    )
      return null;
    return { directory, manifest, key };
  } catch {
    return null;
  }
}
async function assetNames(directory) {
  const result = [];
  async function walk(relative) {
    let entries;
    try {
      entries = await fs.readdir(path.join(directory, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const name = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isFile() && allowedAsset(name)) result.push(name);
      else if (
        entry.isDirectory() &&
        [
          'ocr',
          'direct',
          'direct/swf',
          'resource-cache',
          'scanned-pages',
          'scanned-pages/ocr',
        ].includes(name)
      )
        await walk(name);
    }
  }
  await walk('');
  return result.sort();
}
async function saveSharedCache(job, child, dataDirectory) {
  const wanted = identity(job);
  if (!wanted || !verified(job)) return false;
  const pdf = await bytesAt(job.directory, 'result.pdf');
  if (
    (await PDFDocument.load(pdf, { parseSpeed: 1500, updateMetadata: false })).getPageCount() !==
    job.total
  )
    return false;
  const key = keyFor(wanted),
    generation = randomUUID(),
    base = path.join(dataDirectory, 'document-cache');
  const directory = path.join(base, 'entries', key, generation),
    files = [];
  async function store(name, bytes) {
    await atomic(safePath(directory, name), bytes);
    files.push({ path: name, size: bytes.length, sha256: digest(bytes) });
  }
  await store('result.pdf', pdf);
  if (job.archiveReady) {
    try {
      await store('assets/archive.zip', await bytesAt(job.directory, 'archive.zip'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (job.copyTextReady)
    try {
      await store('copy-text.txt', await bytesAt(job.directory, 'copy-text.txt'));
    } catch {
      /* Copy text is optional. */
    }
  let assetBytes = 0;
  for (const name of await assetNames(child.directory)) {
    if (files.some((file) => file.path === 'assets/' + name)) continue;
    job.controller?.signal.throwIfAborted();
    try {
      const bytes = await bytesAt(child.directory, name);
      if (assetBytes + bytes.length > MAX_ASSETS) continue;
      await store('assets/' + name, bytes);
      assetBytes += bytes.length;
    } catch (error) {
      job.controller?.signal.throwIfAborted();
      if (error.code !== 'ENOENT') job.log?.('Cache asset skipped: ' + name);
    }
  }
  const meta = Object.fromEntries(
    fields.filter((field) => job[field] !== undefined).map((field) => [field, job[field]]),
  );
  const manifest = Buffer.from(
    JSON.stringify({
      version: VERSION,
      identity: wanted,
      meta,
      files,
      createdAt: new Date().toISOString(),
    }),
  );
  await atomic(path.join(directory, 'manifest.json'), manifest);
  await atomic(
    path.join(base, 'index', key + '.json'),
    JSON.stringify({ generation, sha256: digest(manifest) }),
  );
  return true;
}
async function seedExisting(job, dataDirectory, wanted) {
  const jobs = path.join(dataDirectory, 'jobs');
  let ids;
  try {
    ids = await fs.readdir(jobs);
  } catch {
    return false;
  }
  for (const id of ids.reverse()) {
    job.controller.signal.throwIfAborted();
    if (!/^[a-f\d-]{36}$/.test(id) || id === job.id) continue;
    try {
      const directory = path.join(jobs, id),
        saved = JSON.parse(await bytesAt(directory, 'job.json'));
      if (
        saved.id !== id ||
        !verified(saved) ||
        JSON.stringify(identity(saved)) !== JSON.stringify(wanted)
      )
        continue;
      const old = { ...saved, directory, controller: job.controller, log: job.log };
      const child = {
        directory: path.join(directory, 'candidates', digest(saved.url).slice(0, 24)),
      };
      if (await saveSharedCache(old, child, dataDirectory)) return true;
    } catch {
      job.controller.signal.throwIfAborted();
    }
  }
  return false;
}
async function loadSharedCache(job, dataDirectory) {
  const wanted = identity(job);
  if (!wanted) return null;
  let entry = await readEntry(dataDirectory, wanted);
  if (!entry && (await seedExisting(job, dataDirectory, wanted)))
    entry = await readEntry(dataDirectory, wanted);
  if (!entry) return null;
  const { manifest, directory } = entry,
    meta = manifest.meta;
  const provider = meta.url?.startsWith('https://annas-archive.pk/') ? 'anna' : 'doc88';
  if (!require('./source-policy.cjs').providersFor(job.sourcePolicy).includes(provider))
    return null;
  if (
    (
      await require('./document-review.cjs').reviewFor(
        { resolvedQuery: wanted.reference, documentLanguage: wanted.language, url: meta.url },
        dataDirectory,
      )
    )?.rating === 'bad'
  )
    return null;
  const pdfEntry = manifest.files.find((item) => item.path === 'result.pdf');
  const pdf = await checkedFile(directory, pdfEntry);
  let validPDF = false;
  if (pdf)
    try {
      validPDF =
        (
          await PDFDocument.load(pdf, { parseSpeed: 1500, updateMetadata: false })
        ).getPageCount() === meta.total;
    } catch {
      /* Rebuild from independently checked assets. */
    }
  const text = await checkedFile(
    directory,
    manifest.files.find((item) => item.path === 'copy-text.txt'),
  );
  const archive = meta.archiveReady
    ? await checkedFile(
        directory,
        manifest.files.find((item) => item.path === 'assets/archive.zip'),
      )
    : null;
  if (validPDF && (!meta.copyTextReady || text) && (!meta.archiveReady || archive)) {
    job.controller.signal.throwIfAborted();
    await atomic(path.join(job.directory, 'result.pdf'), pdf);
    if (text) await atomic(path.join(job.directory, 'copy-text.txt'), text);
    if (archive) await atomic(path.join(job.directory, 'archive.zip'), archive);
    job.controller.signal.throwIfAborted();
    job.update({
      ...meta,
      title: officialFullTitle(job.catalogueEdition || job.isoEdition),
      pdfFilename: officialPDFName(job.catalogueEdition || job.isoEdition),
      stage: 'done',
      pdfReady: true,
      bytes: pdf.length,
      current: meta.total,
      archiveReady: Boolean(archive),
      copyTextReady: Boolean(text),
      errorCode: null,
      failureKind: null,
      reusedDownloadPages: meta.total,
      reusedOCRPages: meta.processingEngine === 'ocr' ? meta.total : meta.repairedOCRPages || 0,
      cacheUsage: { status: 'hit', key: entry.key, pages: meta.total },
      searchResults: [],
      message: 'Документ готов.',
      finishedAt: new Date().toISOString(),
    });
    return { ready: true };
  }
  if (provider === 'anna') return null;
  const target = path.join(job.directory, 'candidates', digest(meta.url).slice(0, 24));
  let restored = 0;
  for (const file of manifest.files) {
    job.controller.signal.throwIfAborted();
    if (!file.path.startsWith('assets/') || !allowedAsset(file.path.slice(7))) continue;
    const bytes = await checkedFile(directory, file);
    if (!bytes) continue;
    await atomic(safePath(target, file.path.slice(7)), bytes);
    restored++;
  }
  job.update({
    cacheUsage: { status: restored ? 'assets' : 'miss', key: entry.key, restoredFiles: restored },
  });
  return restored
    ? {
        candidate: {
          url: meta.url,
          title: meta.sourceTitle || meta.title,
          pageCount: meta.total,
          format: 'PDF',
          status: 'unverified',
          checks: null,
          fromSharedCache: true,
        },
      }
    : null;
}
module.exports = { identity, keyFor, verified, loadSharedCache, saveSharedCache };
