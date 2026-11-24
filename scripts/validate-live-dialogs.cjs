'use strict';
// Uses live catalogue results produced by validate-real-workflow.cjs.
// A separate server keeps ordinary history untouched; processing is real.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');
const { digest } = require('../page-check.cjs');
const root = path.resolve(__dirname, '..');
const shared = path.join(root, '.data');
const output = path.join(shared, 'workflow-review/dialogs');
const directory = path.join(output, 'server');
const origin = 'http://127.0.0.1:18983';
let child, browser;
async function stop() {
  if (child && child.exitCode === null) {
    const ended = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await ended;
  }
}
async function start() {
  child = spawn(
    process.execPath,
    ['--require', path.join(output, 'shared-services.cjs'), path.join(root, 'server.cjs')],
    {
      windowsHide: true,
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DOC88_PORT: '18983', DOC88_DATA_DIR: directory },
    },
  );
  child.stderr.on('data', (bytes) => console.log(bytes.toString().trim()));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Isolated app did not start')), 20000);
    child.stdout.on('data', (bytes) => {
      if (bytes.toString().includes('DOC88_READY')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('error', reject);
  });
}
const get = async (suffix) => (await fetch(origin + '/api/' + suffix)).json();
const post = async (suffix, body = {}) => {
  const response = await fetch(origin + '/api/' + suffix, {
    method: 'POST',
    headers: { Origin: origin, 'x-doc88-request': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  if (!response.ok) throw Error(JSON.stringify(json));
  return json;
};
async function waitFor(predicate, timeout = 360000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = await predicate();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw Error('Timed out waiting for live workflow.');
}
async function saved(id) {
  return JSON.parse(await fs.readFile(path.join(directory, 'jobs', id, 'job.json')));
}
async function resources(id) {
  const base = path.join(directory, 'jobs', id, 'candidates'),
    result = [];
  for (const candidate of await fs.readdir(base).catch(() => [])) {
    const folder = path.join(base, candidate, 'resource-cache');
    for (const name of await fs.readdir(folder).catch(() => [])) {
      if (!/^[a-f\d]{64}\.ebt$/.test(name)) continue;
      const file = path.join(folder, name),
        stat = await fs.stat(file);
      result.push({ file, mtime: stat.mtimeMs, sha256: digest(await fs.readFile(file)) });
    }
  }
  return result;
}
(async () => {
  const ordinary = await (await fetch('http://127.0.0.1:8968/api/status')).json();
  assert.equal(ordinary.activeId, null);
  await fs.mkdir(path.join(directory, 'jobs'), { recursive: true });
  const ids = {};
  for (const [name, key] of [
    ['iso-series', 'series'],
    ['iso-wrong-year', 'year'],
    ['din-129-1', 'language'],
  ]) {
    const snapshot = JSON.parse(
      await fs.readFile(path.join(shared, 'workflow-review', name, 'job.json')),
    );
    const id = randomUUID();
    ids[key] = id;
    await fs.mkdir(path.join(directory, 'jobs', id), { recursive: true });
    await fs.writeFile(
      path.join(directory, 'jobs', id, 'job.json'),
      JSON.stringify({ ...snapshot, id, createdAt: new Date().toISOString() }),
    );
  }
  const search = path.join(root, 'search.cjs');
  await fs.writeFile(
    path.join(output, 'shared-services.cjs'),
    `const file=${JSON.stringify(search)};const original=require(file);require.cache[file].exports={...original,runSearchJob:(job,_data,options)=>{job.cacheDirectory=${JSON.stringify(path.join(shared, 'models'))};return original.runSearchJob(job,${JSON.stringify(shared)},{...options,downloadOptions:{...options.downloadOptions,rejectChallenges:true}});}};`,
  );
  await start();
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } }),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  async function select(id) {
    await page.goto(origin);
    await page.evaluate((id) => localStorage.setItem('doc88-selected', id), id);
    await page.reload();
  }
  await select(ids.year);
  await page.locator('#edition-dialog').waitFor();
  const years = await page
    .locator('#edition-options input')
    .evaluateAll((inputs) => inputs.map((input) => input.value));
  assert.ok(years.includes('ISO 5458:2018'));
  assert.ok(!years.includes('ISO 5458:2013'));
  await page.screenshot({ path: path.join(output, 'invalid-year.png'), fullPage: true });
  await page.locator('#edition-cancel').click();
  await page.locator('#edition-dialog').waitFor({ state: 'hidden' });
  await select(ids.language);
  await page.locator('#language-dialog').waitFor();
  const languages = await page
    .locator('#language-options input')
    .evaluateAll((inputs) => inputs.map((input) => input.value));
  assert.deepEqual(languages, ['eng', 'deu']);
  assert.equal(await page.locator('#language-reference').innerText(), 'DIN EN ISO 129-1:2022-02');
  await page.screenshot({ path: path.join(output, 'din-language.png'), fullPage: true });
  await page.locator('#language-cancel').click();
  await page.locator('#language-dialog').waitFor({ state: 'hidden' });
  await select(ids.series);
  await page.locator('#series-dialog').waitFor();
  const series = await page
    .locator('#series-options input')
    .evaluateAll((inputs) => inputs.map((input) => input.value));
  assert.equal(series.length, 4);
  await page.locator('#series-all').click();
  assert.equal(await page.locator('#series-options input:checked').count(), 4);
  await page.locator('#series-none').click();
  await page.locator('#series-options input').nth(2).check();
  await page.locator('#series-options input').nth(3).check();
  await page.screenshot({ path: path.join(output, 'iso-series.png'), fullPage: true });
  await page.locator('#series-submit').click();
  await page.locator('#series-dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#language-dialog').isVisible(), false);
  const batch = await waitFor(async () =>
    (await get('status')).batches.find((b) => b.items.some((item) => item.id === ids.series)),
  );
  assert.deepEqual(
    batch.items.map((item) => item.query),
    series.slice(2),
  );
  console.log('Real series queued: ' + series.slice(2).join(', '));
  await waitFor(async () => {
    const job = await get('jobs/' + ids.series);
    if (job.stage === 'error' || job.stage === 'done')
      throw Error('Expected active processing before cancellation: ' + job.stage);
    return (
      ['downloading', 'merging', 'ocr'].includes(job.stage) &&
      (await resources(ids.series)).length > 0
    );
  });
  const before = await resources(ids.series);
  await post('jobs/' + ids.series + '/cancel');
  await waitFor(async () => !(await get('status')).activeId);
  assert.equal((await get('jobs/' + ids.series)).stage, 'cancelled');
  await stop();
  await start();
  assert.equal((await get('jobs/' + ids.series)).stage, 'cancelled');
  assert.equal((await get('jobs/' + ids.series)).query, series[2]);
  await select(ids.series);
  await page.locator('#resume').click();
  const ready = await waitFor(async () => {
    const job = await get('jobs/' + ids.series);
    if (job.stage === 'error') throw Error('Resume failed: ' + job.message);
    return job.stage === 'done' && job.pdfReady ? job : null;
  });
  const after = await resources(ids.series);
  const reused = before.filter((old) =>
    after.some(
      (current) =>
        old.file === current.file && old.sha256 === current.sha256 && old.mtime === current.mtime,
    ),
  );
  assert.ok(reused.length > 0, 'At least one saved resource must be reused without rewriting');
  assert.equal((await fetch(origin + '/api/jobs/' + ids.series + '/pdf')).status, 200);
  await page.locator('#result-actions').waitFor();
  assert.equal(await page.locator('#search-results-section').isVisible(), false);
  assert.doesNotMatch(await page.locator('body').innerText(), /doc88|PRIVATE_DETAILS/i);
  await page.screenshot({ path: path.join(output, 'resumed-document.png'), fullPage: true });
  const raw = await saved(ids.series);
  assert.equal(raw.verification.identity.status, 'passed');
  assert.equal(raw.verification.language.status, 'passed');
  assert.equal(raw.verification.extent.status, 'passed');
  assert.equal(raw.verification.completeness.status, 'passed');
  assert.deepEqual(errors, []);
  const report = {
    checkedAt: new Date().toISOString(),
    realCatalogueMetadata: true,
    realProcessing: true,
    years,
    languages,
    series,
    selectedParts: series.slice(2),
    cancelAndRestart: true,
    reusedResourceFiles: reused.length,
    pages: ready.total,
    pdfFilename: ready.pdfFilename,
    jobDirectory: path.join(directory, 'jobs', ids.series),
    checks: raw.verification,
  };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      pages: ready.total,
      reusedResourceFiles: reused.length,
      cancelAndRestart: true,
      errors,
    }),
  );
})()
  .catch((error) => {
    console.error(error.stack);
    process.exitCode = 1;
  })
  .finally(async () => {
    await browser?.close();
    await stop();
  });
