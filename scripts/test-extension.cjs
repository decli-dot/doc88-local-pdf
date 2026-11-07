// End-to-end test with a real MV3 extension in an isolated Chromium profile.
// Default: local converter + synthetic viewer. Optional: published converter/real Doc88.
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { PDFDocument, PDFName } = require('pdf-lib');
const root = path.resolve(__dirname, '..');
const publicSite = process.env.DOC88_BROWSER_TEST_PUBLIC === '1';
const site = publicSite
  ? 'https://decli-dot.github.io/doc88-local-pdf/'
  : 'http://127.0.0.1:18970/doc88-local-pdf/';
const realURL = process.env.DOC88_BROWSER_TEST_URL;
const docURL = realURL || 'https://www.doc88.com/p-111.html';
const output = path.join(root, '.data/browser-check');
const mime = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.gz': 'application/gzip',
};
let context, server, monitor;
(async () => {
  await fs.mkdir(output, { recursive: true });
  let extension = path.join(root, 'extension');
  if (!publicSite) {
    server = http.createServer(async (request, response) => {
      try {
        const relative =
          new URL(request.url, site).pathname.slice('/doc88-local-pdf/'.length) || 'index.html';
        const file = path.resolve(root, '.web-build', relative);
        assert.ok(file.startsWith(path.join(root, '.web-build') + path.sep));
        const bytes = await fs.readFile(file);
        response.writeHead(200, {
          'Content-Type': mime[path.extname(file)] || 'application/octet-stream',
        });
        response.end(bytes);
      } catch {
        response.writeHead(404);
        response.end('Not found');
      }
    });
    await new Promise((resolve) => server.listen(18970, '127.0.0.1', resolve));
    // Only the test copy points to localhost; public distribution permissions stay narrow.
    extension = path.join(output, 'test-extension');
    await fs.cp(path.join(root, 'extension'), extension, { recursive: true });
    const manifest = JSON.parse(await fs.readFile(path.join(extension, 'manifest.json'), 'utf8'));
    manifest.homepage_url = site;
    manifest.host_permissions.push('http://127.0.0.1/*');
    manifest.content_scripts[1].matches = ['http://127.0.0.1/doc88-local-pdf/*'];
    await fs.writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
  }
  context = await chromium.launchPersistentContext(
    path.join(
      output,
      (publicSite ? 'public-profile-' : 'local-profile-') + require('node:crypto').randomUUID(),
    ),
    {
      channel: 'chromium',
      headless: true,
      deviceScaleFactor: 1.5,
      acceptDownloads: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    },
  );
  if (!realURL) {
    const images = await Promise.all(
      [1, 2, 3].map(
        async (number) =>
          'data:image/png;base64,' +
          (await fs.readFile(path.join(root, `tests/fixtures/fixture-${number}.png`))).toString(
            'base64',
          ),
      ),
    );
    await context.route(docURL, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><meta http-equiv="Content-Security-Policy" content="script-src 'self' 'unsafe-inline'; img-src data:; object-src 'none'"><title>English OCR integration</title><h1 title="English OCR integration">Test document</h1><div><input id="pageNumInput" value="1"> / 3</div>${images.map((_, i) => `<canvas id="page_${i + 1}"></canvas>`).join('')}<script>window.Map=function LegacyMap(){};${images.map((src, i) => `(()=>{const image=new Image();image.onload=()=>{const canvas=document.getElementById('page_${i + 1}');canvas.width=image.width;canvas.height=image.height;canvas.getContext('2d').drawImage(image,0,0);canvas.setAttribute('lz','1')};image.src=${JSON.stringify(src)}})();`).join('')}</script>`,
      }),
    );
  }
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent('serviceworker', { timeout: 15000 }));
  for (const tab of context.pages()) await tab.close();
  const page = await context.newPage();
  await page.goto(docURL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForSelector('#doc88-pdf-extension', { state: 'attached', timeout: 15000 });
  if (!realURL)
    await worker.evaluate(() => {
      // Reuse routed fixture tabs: Chromium-created tabs can navigate before Playwright attaches its routing.
      const original = startJob;
      startJob = async (url, source, target, options) => {
        if (source == null) source = (await chrome.tabs.query({ url }))[0]?.id;
        return original(url, source, target, options);
      };
    });
  let resultPage = context.pages().find((page) => page.url().startsWith(site));
  if (!resultPage) {
    resultPage = await context.newPage();
    await resultPage.goto(site);
  }
  await resultPage.waitForFunction(() =>
    document.getElementById('browser-connection')?.textContent.includes('Расширение готово'),
  );
  await resultPage.locator('#url-tab').click();
  await resultPage.locator('#document-url').fill(docURL);
  await resultPage.locator('#start-url').click();
  resultPage.on('pageerror', (error) => console.error('Converter: ' + error.message));
  let previous = '';
  monitor = setInterval(async () => {
    try {
      const state = await resultPage.locator('#job-message').textContent({ timeout: 500 });
      if (state !== previous) {
        console.log(state);
        previous = state;
      }
    } catch {}
  }, 5000);
  const downloadPromise = resultPage.waitForEvent('download', { timeout: 8 * 60 * 1000 });
  downloadPromise.catch(() => {});
  await resultPage.waitForFunction(
    () => {
      const error = document.getElementById('form-error');
      if (error && !error.hidden) throw new Error(error.textContent);
      const status = document.getElementById('status-pill')?.textContent;
      if (status === 'Ошибка') throw new Error(document.getElementById('job-message')?.textContent);
      return document.getElementById('result-actions')?.hidden === false;
    },
    null,
    { timeout: realURL ? 8 * 60 * 1000 : 60000 },
  );
  await resultPage.locator('#pdf-download').click();
  const download = await downloadPromise;
  const filename = path.join(output, realURL ? 'real-document.pdf' : 'fixture-document.pdf');
  await download.saveAs(filename);
  const pdf = await PDFDocument.load(await fs.readFile(filename));
  assert.equal(pdf.getPageCount(), realURL ? Number(process.env.DOC88_EXPECTED_PAGES || 14) : 3);
  for (const page of pdf.getPages()) {
    const resources = page.node.Resources();
    assert.ok(resources.get(PDFName.of('XObject')), 'page image missing');
    assert.ok(resources.get(PDFName.of('Font')), 'searchable text font missing');
  }
  const stats = await resultPage.locator('#job-meta').textContent();
  assert.match(stats, /стр\./);
  if (!realURL)
    await require('./test-browser-features.cjs')({
      context,
      resultPage,
      worker,
      sourcePage: page,
      docURL,
      output,
    });
  await resultPage.screenshot({
    path: path.join(output, realURL ? 'real-result.png' : 'fixture-result.png'),
    fullPage: true,
  });
  console.log(
    JSON.stringify({
      success: true,
      pages: pdf.getPageCount(),
      filename,
      stats,
      browser: context.browser().version(),
    }),
  );
})()
  .catch(async (error) => {
    console.error(error.stack);
    if (context) {
      for (const page of context.pages())
        console.error(
          JSON.stringify({
            url: page.url(),
            body: (
              await page
                .locator('body')
                .innerText()
                .catch(() => '')
            ).slice(-700),
          }),
        );
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    clearInterval(monitor);
    if (context) await context.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  });
