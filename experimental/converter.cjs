'use strict';
// FFDec is a separate GPL-3.0 application. No doc88_extractor source is bundled.
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const JSZip = require('jszip');
const { requestPublic } = require('../public-http.cjs');
const { atomicWrite } = require('../checkpoints.cjs');
const version = '26.4.0';
const digest = '56ce960aeafc7caf034e2052ba49f878a883f7c7ca690da6eeffca9587b5e4b9';
const pendingInstallations = new Map();
async function ensureConverter(toolsDirectory, signal) {
  const key = path.resolve(toolsDirectory);
  const pending = pendingInstallations.get(key);
  if (pending && pending.signal === signal) return pending.promise;
  const promise = prepareConverter(toolsDirectory, signal);
  pendingInstallations.set(key, { promise, signal });
  try {
    return await promise;
  } finally {
    if (pendingInstallations.get(key)?.promise === promise) pendingInstallations.delete(key);
  }
}
async function prepareConverter(toolsDirectory, signal) {
  const directory = path.join(toolsDirectory, 'ffdec-' + version);
  const jar = path.join(directory, 'ffdec.jar');
  try {
    const record = JSON.parse(await fs.readFile(path.join(directory, 'provenance.json')));
    if (
      record.version === version &&
      record.sha256 === digest &&
      (await fs.stat(jar)).size > 100000
    )
      return jar;
  } catch {
    /* First or interrupted installation. */
  }
  const url = `https://github.com/jindrapetrik/jpexs-decompiler/releases/download/version${version}/ffdec_${version}.zip`;
  const { bytes } = await requestPublic(url, {
    signal,
    maxBytes: 40 * 1024 * 1024,
    timeoutMs: 120000,
    hosts: ['github.com', 'githubusercontent.com'],
  });
  if (createHash('sha256').update(bytes).digest('hex') !== digest)
    throw Error('Converter checksum mismatch.');
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  for (const item of Object.values(zip.files)) {
    if (item.dir) continue;
    const name = item.unsafeOriginalName || item.name;
    if (name.includes('..') || name.includes('\\') || path.isAbsolute(name) || name.includes(':'))
      throw Error('Unsafe converter archive entry.');
    if (!/\.jar$|(?:license|copying)/i.test(name)) continue;
    const target = path.join(directory, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await atomicWrite(target, await item.async('nodebuffer'));
  }
  await atomicWrite(
    path.join(directory, 'provenance.json'),
    JSON.stringify({ version, url, sha256: digest }, null, 2),
  );
  await fs.stat(jar);
  return jar;
}
async function convertSWF(
  jar,
  input,
  output,
  { signal, timeoutMs = 240000, logFile, workers = 3 } = {},
) {
  if (!Number.isInteger(workers) || workers < 1 || workers > 4)
    throw Error('Invalid conversion worker count.');
  if (workers > 1) {
    const files = (await fs.readdir(input)).filter((name) => /^page\d{5}\.swf$/.test(name)).sort();
    if (!files.length) throw Error('No SWF pages to convert.');
    const groupRoot = await fs.mkdtemp(path.join(path.dirname(output), 'conversion-input-'));
    const groups = [];
    for (let worker = 0; worker < Math.min(workers, files.length); worker++) {
      const group = path.join(groupRoot, String(worker));
      await fs.mkdir(group, { recursive: true });
      for (let i = worker; i < files.length; i += workers) {
        const target = path.join(group, files[i]);
        try {
          await fs.link(path.join(input, files[i]), target);
        } catch (error) {
          if (error.code !== 'EEXIST') await fs.copyFile(path.join(input, files[i]), target);
        }
      }
      groups.push(group);
    }
    const started = performance.now();
    const results = await Promise.allSettled(
      groups.map((group, i) =>
        convertSWF(jar, group, output, {
          signal,
          timeoutMs,
          workers: 1,
          logFile: logFile ? logFile + '.' + i : undefined,
        }),
      ),
    );
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
    return { conversionMs: performance.now() - started, conversionWorkers: groups.length };
  }
  await fs.mkdir(output, { recursive: true });
  const args = [
    '-Djava.awt.headless=true',
    '-Xmx768m',
    '-jar',
    jar,
    '-format',
    'frame:pdf',
    '-select',
    '1',
    '-export',
    'frame',
    output,
    input,
  ];
  const started = performance.now();
  let stdout = '',
    stderr = '';
  const code = await new Promise((resolve, reject) => {
    const child = spawn('java', args, {
      windowsHide: true,
      signal,
      timeout: timeoutMs,
      cwd: path.dirname(jar),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (b) => {
      stdout = (stdout + b.toString()).slice(-500000);
    });
    child.stderr.on('data', (b) => {
      stderr = (stderr + b.toString()).slice(-500000);
    });
    child.once('error', reject);
    child.once('close', resolve);
  });
  if (logFile) await atomicWrite(logFile, stdout + '\n' + stderr);
  if (code !== 0) throw Error(`SWF conversion failed (${code}). See conversion log.`);
  return { conversionMs: performance.now() - started };
}
module.exports = { ensureConverter, convertSWF };
