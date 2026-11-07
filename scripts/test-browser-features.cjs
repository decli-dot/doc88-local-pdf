'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
const JSZip = require('jszip');
const { PDFDocument, PDFName } = require('pdf-lib');
const prose =
  'The operator shall inspect the workpiece and record the measurement results in the report. The reference system is used to evaluate the toleranced feature. This document explains the test procedure and the requirements for each measurement.';
const esc = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
module.exports = async function checkFeatures({
  context,
  resultPage: page,
  worker,
  sourcePage,
  docURL,
  output,
}) {
  const sections = [
    ['ISO 5458:2018', 'Synthetic document for application testing', '1 Scope', prose, prose],
    [
      'ISO 5458:2018',
      '2 Normative references',
      'ISO 8015:2011, Fundamentals',
      'ISO 1101:2017, Geometrical tolerancing',
      '3 Terms and definitions',
      '3.1 General',
      'The specification defines the acceptable limits for the measured feature. Each result shall be compared with the corresponding tolerance. The instrument must be suitable for the task and the operator shall verify its calibration before use.',
    ],
    [
      'ISO 5458:2018',
      'Annex A',
      '(informative)',
      'Testing example',
      'A.1 Procedure',
      'The following example illustrates the evaluation of a surface. A series of points is measured in the reference coordinate system. The report includes the values and the uncertainty of the measurement. This example is provided for information and has no additional requirements.',
      'Bibliography',
      '[1] ISO 9999:2020, Synthetic bibliography item',
    ],
  ];
  const images = await Promise.all(
    sections.map(async (lines, index) => {
      const wrapped = lines.flatMap((line) =>
        line.length > 90 ? line.match(/.{1,85}(?:\s|$)/g).map((value) => value.trim()) : [line],
      );
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1600"><rect width="1200" height="1600" fill="white"/><g font-family="DejaVu Sans,Arial,sans-serif" font-size="28" fill="black">${wrapped.map((line, i) => `<text x="70" y="${100 + i * 65}">${esc(line)}</text>`).join('')}<text x="70" y="1530">© ISO 2018 — All rights reserved ${index + 1}</text></g></svg>`;
      return sharp(Buffer.from(svg)).png().toBuffer();
    }),
  );
  await worker.evaluate(
    async ({ images, url }) => {
      const [tab] = await chrome.tabs.query({ url });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        args: [images],
        func: async (images) => {
          for (let i = 0; i < images.length; i++) {
            const image = new Image();
            image.src = 'data:image/png;base64,' + images[i];
            await image.decode();
            const canvas = document.getElementById('page_' + (i + 1));
            canvas.width = image.width;
            canvas.height = image.height;
            canvas.getContext('2d').drawImage(image, 0, 0);
            canvas.setAttribute('lz', '1');
          }
          document.querySelector('h1').title = 'ISO 5458:2018';
        },
      });
    },
    { images: images.map((bytes) => bytes.toString('base64')), url: docURL },
  );
  const current = 'https://www.iso.org/standard/65559.html',
    previous = 'https://www.iso.org/standard/11558.html',
    supplement = 'https://www.iso.org/standard/75971.html';
  const card = `<div id="search-results"><div class="card"><div class="card-title"><a href="${current}">ISO 5458:2018</a> Synthetic English test document</div><div class="card-footer">Published</div></div></div>`;
  await context.route('https://www.iso.org/**', (route) => {
    const url = route.request().url();
    if (url.includes('/search.html'))
      return route.fulfill({ contentType: 'text/html', body: card });
    const old = url.startsWith(previous),
      amendment = url.startsWith(supplement),
      label = amendment ? 'ISO 5458:2018/Amd 1:2020' : old ? 'ISO 5458:1998' : 'ISO 5458:2018';
    const lifecycle = `<div id="lifecycle"><div class="step active"><div class="section-head">${old ? 'Withdrawn' : 'Published'}</div></div>${!old && !amendment ? `<div class="time-step"><h3>Previously</h3><div class="step-item"><div class="section-head">Withdrawn</div><h4><a href="${previous}">ISO 5458:1998</a></h4></div></div><div class="sub-step"><div class="step-item"><div class="section-head">Published</div><h4><a href="${supplement}">ISO 5458:2018/Amd 1:2020</a></h4></div></div>` : ''}</div>`;
    return route.fulfill({
      contentType: 'text/html',
      body: `<title>${label} - Synthetic English test document${amendment ? ' - Amendment 1' : ''}</title><div id="content"><h1>${label}</h1>Number of pages: ${amendment ? 1 : 3}${lifecycle}</div>`,
    });
  });
  // Pre-created tabs keep the fixture routing deterministic for extension-driven navigation.
  for (let i = 0; i < 8; i++) {
    const tab = await context.newPage();
    await tab.goto('https://www.iso.org/search.html');
  }
  const searchHTML = `<div class="sd-list-con"><a class="sd-title" href="https://www.doc88.com/p-222.html" title="BS EN ISO 5458:2018">National</a>页数：3 格式：PDF</div><div class="sd-list-con"><a class="sd-title" href="https://www.doc88.com/p-333.html" title="ISO 5458:2018 excerpt">Short</a>页数：1 格式：PDF</div><div class="sd-list-con"><a class="sd-title" href="${docURL}" title="ISO 5458:2018">Full</a>页数：3 格式：PDF</div>`;
  await worker.evaluate(
    ({ html }) => {
      const create = chrome.tabs.create.bind(chrome.tabs);
      chrome.tabs.create = async (options) => {
        if (options.url === 'https://www.iso.org/search.html') {
          const entry = (await chrome.tabs.query({ url: 'https://www.iso.org/search.html' }))[0];
          if (entry) return entry;
        }
        return create(options);
      };
      const network = globalThis.fetch;
      globalThis.fetch = (url, options) =>
        String(url).startsWith('https://www.doc88.com/search/post.do')
          ? Promise.resolve(new Response(html))
          : network(url, options);
    },
    { html: searchHTML },
  );
  const api = (route, body) =>
    page.evaluate(
      async ({ route, body }) => {
        const response = await window.Doc88Browser.fetch(
          route,
          body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) },
        );
        const value = await response.json();
        if (!response.ok) throw Error(value.error);
        return value;
      },
      { route, body },
    );
  const wait = async (id, condition) => {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const job = await api('/api/jobs/' + id);
      if (condition === 'done' && job.stage === 'error') throw Error(job.message);
      if (
        condition === 'done'
          ? job.stage === 'done'
          : condition === 'ocr'
            ? job.stage === 'ocr' && job.current >= 1
            : job.stage === condition
      )
        return job;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw Error(
      'Timed out waiting for ' + condition + ': ' + JSON.stringify(await api('/api/jobs/' + id)),
    );
  };
  const findJob = async (predicate) => {
    for (let i = 0; i < 200; i++) {
      const job = (await api('/api/status')).jobs.find(predicate);
      if (job) return job;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw Error('New browser job was not created');
  };
  await page.locator('#search-tab').click();
  await page.locator('#search-query').fill('iso 5458-2013');
  await page.locator('#start-search').click();
  await page.locator('#edition-dialog').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#search-query').inputValue(), 'ISO 5458:2013');
  assert.match(await page.locator('#edition-dialog').innerText(), /2018/);
  assert.match(await page.locator('#edition-dialog').innerText(), /1998/);
  const state = await api('/api/status'),
    choosing = state.jobs.find((job) => job.stage === 'choosing');
  assert.ok(choosing);
  await api('/api/jobs/' + choosing.id + '/edition', { reference: 'ISO 5458:2018' });
  const result = await wait(choosing.id, 'done');
  await fs.writeFile(path.join(output, 'search-result.json'), JSON.stringify(result, null, 2));
  assert.equal(result.verification.extent.status, 'passed');
  assert.equal(result.verification.language.status, 'passed');
  assert.equal(result.verification.identity.status, 'passed');
  assert.equal(result.searchResults.length, 2);
  assert.equal(result.searchResults[0].status, 'rejected');
  assert.ok(result.pdfFilename.includes('Synthetic English test document'));
  assert.ok(result.documentStructure.nodes.some((node) => node.children.length));
  assert.deepEqual(
    result.normativeReferences.items.map((item) => item.query),
    ['ISO 8015:2011', 'ISO 1101:2017'],
  );
  assert.equal(result.isoEdition.supplements[0].reference, 'ISO 5458:2018/Amd 1:2020');
  await page.waitForFunction(() => !document.getElementById('result-actions').hidden);
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#pdf-download').click();
  const download = await downloadPromise;
  const pdfPath = path.join(output, 'structured-browser.pdf');
  await download.saveAs(pdfPath);
  const pdf = await PDFDocument.load(await fs.readFile(pdfPath));
  assert.equal(pdf.getPageCount(), 3);
  assert.ok(pdf.catalog.get(PDFName.of('Outlines')));
  await page.locator('#iso-supplements button').click();
  const amendment = await findJob((job) => job.query?.includes('/Amd'));
  await wait(amendment.id, 'error');
  const amendmentResult = await api('/api/jobs/' + amendment.id);
  assert.equal(amendmentResult.isoEdition.pageCount, 1);
  assert.equal(amendmentResult.pdfReady, false);
  // A stopped OCR resumes after reload, using only complete, hash-validated page caches.
  const zip = new JSZip();
  images.forEach((image, index) => zip.file(`page${index + 1}.png`, image));
  const archive = await zip.generateAsync({ type: 'nodebuffer' });
  await page.locator('#zip-tab').click();
  await page.locator('#archive-file').setInputFiles({
    name: 'Browser resume test.zip',
    mimeType: 'application/zip',
    buffer: archive,
  });
  await page.locator('#start-zip').click();
  const created = await findJob((job) => job.title === 'Browser resume test');
  assert.ok(created);
  await wait(created.id, 'ocr');
  await api('/api/jobs/' + created.id + '/cancel', {});
  await wait(created.id, 'cancelled');
  await page.reload();
  await page.waitForFunction(() => window.Doc88Browser);
  await api('/api/jobs/' + created.id + '/resume', {});
  const restored = await wait(created.id, 'done');
  assert.ok(restored.reusedOCRPages >= 1);
  assert.equal(restored.total, 3);
  await page.locator('#find-references').click();
  let selected;
  for (let i = 0; i < 200 && !selected; i++) {
    selected = (await api('/api/status')).batches[0];
    if (!selected) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(selected.total, 2);
  await api('/api/batches/' + selected.id + '/cancel', {});
  for (let i = 0; i < 100 && (await api('/api/status')).activeId; i++)
    await new Promise((resolve) => setTimeout(resolve, 30));
  const batch = await api('/api/batches', {
    queries: ['ISO 5458', 'ISO 5458:2013'],
    enhanceImages: true,
  });
  await wait(batch.items[0].id, 'done');
  await wait(batch.items[1].id, 'choosing');
  const archivePromise = page.waitForEvent('download');
  await page.evaluate((id) => {
    const a = document.createElement('a');
    a.href = window.Doc88Browser.link('/api/batches/' + id + '/zip');
    document.body.append(a);
    a.click();
    a.remove();
  }, batch.id);
  const batchDownload = await archivePromise,
    batchPath = path.join(output, 'browser-batch.zip');
  await batchDownload.saveAs(batchPath);
  const batchZip = await JSZip.loadAsync(await fs.readFile(batchPath));
  assert.equal(Object.keys(batchZip.files).filter((name) => name.endsWith('.pdf')).length, 1);
  assert.ok(batchZip.file('Отчёт.txt'));
  await api('/api/batches/' + batch.id + '/cancel', {});
  await worker.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const box = document.createElement('div');
        box.id = 'captcha_reading';
        box.style.cssText =
          'position:fixed;left:40px;top:40px;width:400px;height:140px;background:white;border:2px solid green;z-index:99999';
        box.textContent = 'Synthetic manual verification';
        const button = document.createElement('button');
        button.textContent = 'Slide';
        button.style.cssText = 'position:absolute;left:20px;top:70px;width:60px;height:35px';
        box.append(button);
        document.body.append(box);
        globalThis.doc88FixtureEvents = [];
        let start = null;
        button.addEventListener('mousedown', (event) => {
          globalThis.doc88FixtureEvents.push([
            'down',
            event.clientX,
            event.clientY,
            event.isTrusted,
            event.buttons,
          ]);
          if (event.isTrusted) start = event.clientX;
        });
        document.addEventListener('mousemove', (event) => {
          globalThis.doc88FixtureEvents.push([
            'move',
            event.clientX,
            event.clientY,
            event.isTrusted,
            event.buttons,
          ]);
          if (
            start !== null &&
            event.isTrusted &&
            event.buttons === 1 &&
            event.clientX - start > 180
          ) {
            box.remove();
            start = null;
          }
        });
      },
    });
  }, docURL);
  const ranged = await api('/api/jobs', {
    url: docURL,
    fromPage: 2,
    toPage: 3,
    enhanceImages: true,
  });
  await page.locator('#challenge-image').waitFor({ state: 'visible', timeout: 15000 });
  await page.locator('#challenge-image').evaluate((image) => image.decode());
  await page.locator('#challenge-image').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'manual-challenge.png'), fullPage: true });
  await page.locator('#challenge-image').evaluate((image) => {
    globalThis.doc88HostEvents = [];
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'lostpointercapture'])
      image.addEventListener(type, (e) =>
        globalThis.doc88HostEvents.push([type, e.clientX, e.clientY]),
      );
  });
  const box = await page.locator('#challenge-image').boundingBox();
  await page.mouse.move(box.x + box.width * 0.12, box.y + box.height * 0.65);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.65, { steps: 14 });
  await page.mouse.up();
  let pointerEvents;
  for (let i = 0; i < 100; i++) {
    pointerEvents = await worker.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url });
      return (
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => ({
            present: !!document.getElementById('captcha_reading'),
            events: globalThis.doc88FixtureEvents,
          }),
        })
      )[0].result;
    }, docURL);
    if (!pointerEvents.present) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(
    pointerEvents.present,
    false,
    JSON.stringify({
      ...pointerEvents,
      status: await page.locator('#challenge-status').innerText(),
      host: await page.evaluate(() => globalThis.doc88HostEvents),
    }),
  );
  const rangedResult = await wait(ranged.id, 'done');
  assert.equal(rangedResult.total, 2);
  await worker.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => document.getElementById('page_2').removeAttribute('lz'),
    });
  }, docURL);
  const interrupted = await api('/api/jobs', {
    url: docURL,
    fromPage: 1,
    toPage: 3,
    enhanceImages: true,
  });
  for (let i = 0; i < 300; i++) {
    const job = await api('/api/jobs/' + interrupted.id);
    if (job.current >= 1) break;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  await page.reload();
  await page.waitForFunction(() => window.Doc88Browser);
  const stopped = await api('/api/jobs/' + interrupted.id);
  assert.equal(stopped.stage, 'interrupted');
  await worker.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => document.getElementById('page_2').setAttribute('lz', '1'),
    });
  }, docURL);
  await api('/api/jobs/' + interrupted.id + '/resume', {});
  const continued = await wait(interrupted.id, 'done');
  assert.ok(continued.reusedDownloadPages >= 1);
  const baselineZIP = new JSZip();
  baselineZIP.file('page1.png', images[0]);
  await page.locator('#zip-tab').click();
  await page.locator('#enhance-images').uncheck();
  await page.locator('#archive-file').setInputFiles({
    name: 'Geometry baseline.zip',
    mimeType: 'application/zip',
    buffer: await baselineZIP.generateAsync({ type: 'nodebuffer' }),
  });
  await page.locator('#start-zip').click();
  const baselineJob = await findJob((job) => job.title === 'Geometry baseline');
  const baselineResult = await wait(baselineJob.id, 'done');
  assert.equal(baselineResult.imageEnhancement.pages.length, 0);
  const baselineDownload = page.waitForEvent('download');
  await page.evaluate((id) => {
    const a = document.createElement('a');
    a.href = window.Doc88Browser.link('/api/jobs/' + id + '/pdf');
    document.body.append(a);
    a.click();
    a.remove();
  }, baselineJob.id);
  const baselinePath = path.join(output, 'browser-geometry-baseline.pdf');
  await (await baselineDownload).saveAs(baselinePath);
  const baselinePDF = await PDFDocument.load(await fs.readFile(baselinePath));
  assert.ok(Math.abs(baselinePDF.getPage(0).getWidth() - pdf.getPage(0).getWidth()) < 0.5);
  assert.ok(Math.abs(baselinePDF.getPage(0).getHeight() - pdf.getPage(0).getHeight()) < 0.5);
  await page.locator('#enhance-images').check();
  await page.evaluate((id) => selectJob(id), choosing.id);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: path.join(output, 'workspace-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1450, height: 1050 });
  await page.screenshot({ path: path.join(output, 'workspace-result.png'), fullPage: true });
  console.log(
    JSON.stringify({
      browserFeatures: true,
      editionPicker: true,
      internationalISOOnly: true,
      shortExcerptRejected: true,
      outline: true,
      normativeReferences: 2,
      supplement: true,
      resumedOCRPages: restored.reusedOCRPages,
      resumedDownloadPages: continued.reusedDownloadPages,
      batchZip: true,
      inlineManualChallenge: true,
      pageRange: true,
      mobileOverflow: false,
      physicalPageSizePreserved: true,
    }),
  );
};
