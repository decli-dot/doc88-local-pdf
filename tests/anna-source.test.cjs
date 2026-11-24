'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os');
const { createHash } = require('node:crypto');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { chromium } = require('playwright');
const source = require('../experimental/anna-source.cjs');
const { runSearchJob } = require('../search.cjs');
const { importPDF } = require('../pdf-input.cjs');
const body =
  'This document specifies the requirements for the measurement of manufactured parts.\nThe method shall be used with the specified reference system.\nEach feature is measured independently and the results are recorded in the report.\nThe operator should check that the equipment is suitable for the measurement.\nA surface can be evaluated by more than one method and the selected method shall be stated.';
async function fixture(t, cover = 'ISO 129-1:2018') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'declipdf-anna-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('declipdf-anna-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let n = 0; n < 4; n++)
    pdf.addPage([600, 800]).drawText(
      cover +
        '\n' +
        body
          .split('\n')
          .map(
            (line) =>
              ['Inspection: ', 'Calibration: ', 'Measurement: ', 'Verification: '][n] + line,
          )
          .join('\n') +
        '\nPage ' +
        (n + 1),
      {
        font,
        x: 30,
        y: 750,
        size: 10,
        lineHeight: 17,
      },
    );
  const bytes = Buffer.from(await pdf.save()),
    md5 = createHash('md5').update(bytes).digest('hex');
  const ref = source.references('https://annas-archive.pk/md5/' + md5);
  return {
    directory,
    bytes,
    md5,
    ref,
    job: {
      directory,
      url: ref.card,
      query: 'ISO 129-1:2018',
      documentLanguage: 'eng',
      ocrLanguage: 'eng',
      controller: new AbortController(),
      update(value) {
        Object.assign(this, value);
      },
      log() {},
    },
  };
}
async function browserFixture(t, f, { challenge = false, transientNavigation = false } = {}) {
  const browser = await chromium.launch({
    channel: require('../runtime.cjs').browserChannel(),
    headless: true,
  });
  t.after(() => browser.close());
  let page;
  const direct = 'https://files.example.test/' + f.md5 + '.pdf';
  const ready = '<title>Slow downloads</title><a href="' + direct + '">Download PDF now</a>';
  const launchContext = async () => {
    const context = await browser.newContext({ viewport: { width: 960, height: 720 } });
    context.on('page', (value) => {
      page = value;
      if (transientNavigation) {
        const evaluate = page.evaluate.bind(page);
        let first = true;
        page.evaluate = (expression, ...args) => {
          if (first && expression === source.inspectPage) {
            first = false;
            return Promise.reject(
              Error('Execution context was destroyed, most likely because of a navigation'),
            );
          }
          return evaluate(expression, ...args);
        };
      }
    });
    await context.route('https://annas-archive.pk/**', (route) => {
      const card = new URL(route.request().url()).pathname.startsWith('/md5/');
      const html = card
        ? '<title>Record</title><a href="https://metadata.example.test/' +
          f.md5 +
          '">Source metadata</a><a href="/slow_download/' +
          f.md5 +
          '/0/0">Slow Partner Server 1</a>'
        : challenge
          ? `<title>DDOS-GUARD</title><form style="margin:120px" id="human"><label>Synthetic local verification<input id="answer"></label><button>Continue</button></form><script>document.getElementById('human').onsubmit=e=>{e.preventDefault();if(document.getElementById('answer').value==='TEST'){document.title='Downloads';document.body.innerHTML=${JSON.stringify(ready)};}}</script>`
          : ready;
      return route.fulfill({ status: 200, contentType: 'text/html', body: html });
    });
    return context;
  };
  return { launchContext, getPage: () => page };
}
test('Anna experiment constrains card identities and does not accept unrelated download pages', () => {
  const hash = 'a'.repeat(32),
    ref = source.references(
      'https://annas-archive.pk/md5/' + hash + '?check=1',
      'https://annas-archive.pk/slow_download/' + hash + '/0/0',
    );
  assert.equal(ref.card, 'https://annas-archive.pk/md5/' + hash);
  assert.equal(source.allowedPage(ref.card + '?check=1', ref), true);
  assert.equal(source.allowedPage(ref.card + '/', ref), true);
  for (const card of [
    'http://annas-archive.pk/md5/' + hash,
    'https://annas-archive.pk.evil.test/md5/' + hash,
    'https://annas-archive.pk/account',
    'https://user:pass@annas-archive.pk/md5/' + hash,
  ])
    assert.throws(() => source.references(card));
  assert.throws(() =>
    source.references(
      ref.card,
      'https://annas-archive.pk/slow_download/' + 'b'.repeat(32) + '/0/0',
    ),
  );
  assert.equal(source.allowedPage('https://annas-archive.pk/account', ref), false);
  const links = source.downloadLinks(
    {
      links: [
        { url: 'http://127.0.0.1/file.pdf', text: 'Download' },
        { url: 'javascript:alert(1)', text: 'Download' },
        { url: 'https://files.example.test/' + hash + '.pdf', text: 'Download' },
      ],
    },
    ref,
  );
  assert.equal(links.length, 1);
});
test('card to slow page to PDF validates MD5 and reuses only a complete source checkpoint', async (t) => {
  const f = await fixture(t),
    b = await browserFixture(t, f, { transientNavigation: true });
  let requests = 0;
  const options = {
    launchContext: b.launchContext,
    pollMs: 10,
    request: async () => {
      requests++;
      return { bytes: f.bytes };
    },
  };
  await source.downloadAnnaPDF(f.job, f.directory, options);
  assert.equal(f.job.total, 4);
  assert.equal(requests, 1);
  assert.deepEqual(await fs.readFile(path.join(f.directory, 'source.pdf')), f.bytes);
  await source.downloadAnnaPDF(f.job, f.directory, {
    launchContext: () => assert.fail('Valid checkpoint must skip browser navigation'),
  });
  assert.equal(f.job.sourcePDFReused, true);
  assert.equal(f.job.stage, 'checking');
  assert.equal(f.job.reusedDownloadPages, 4);
  await fs.writeFile(path.join(f.directory, 'source.pdf'), 'damaged');
  await assert.rejects(
    source.downloadAnnaPDF(f.job, f.directory, {
      ...options,
      request: async () => ({ bytes: Buffer.from('%PDF-wrong file') }),
    }),
    { code: 'DOCUMENT_MISMATCH' },
  );
  assert.equal(
    await fs.readFile(path.join(f.directory, 'source.pdf'), 'utf8'),
    'damaged',
    'mismatching files are not committed',
  );
});
test('human-only challenge relay supports literal text on a local fixture and cancellation closes the source browser', async (t) => {
  const f = await fixture(t),
    b = await browserFixture(t, f, { challenge: true });
  let action;
  await source.downloadAnnaPDF(f.job, f.directory, {
    launchContext: b.launchContext,
    pollMs: 10,
    request: async () => ({ bytes: f.bytes }),
    onBrowserView: (view) => {
      if (!view) return;
      action = (async () => {
        const frame = await view.frame();
        assert.equal(frame.keyboard, true);
        assert.equal(frame.width, 960);
        const box = await b.getPage().locator('#answer').boundingBox();
        const point = {
          token: frame.token,
          x: (box.x + 10) / (frame.width - 1),
          y: (box.y + 10) / (frame.height - 1),
        };
        await view.input({ ...point, type: 'down' });
        await view.input({ ...point, type: 'up' });
        await assert.rejects(view.input({ token: frame.token, type: 'key', key: 'Control+L' }));
        await view.input({ token: frame.token, type: 'text', text: 'TEST' });
        await view.input({ token: frame.token, type: 'key', key: 'Enter' });
      })();
      action.catch(() => {});
    },
  });
  await action;
  assert.equal(f.job.challengeAvailable, false);
  const other = await fixture(t),
    guard = await browserFixture(t, other, { challenge: true });
  await assert.rejects(
    source.downloadAnnaPDF(other.job, other.directory, {
      launchContext: guard.launchContext,
      pollMs: 10,
      onBrowserView: (view) => {
        if (view) other.job.controller.abort();
      },
    }),
  );
  assert.equal(other.job.challengeAvailable, false);
  await assert.rejects(fs.access(path.join(other.directory, 'source.pdf')));
});
test('experimental PDF candidates are off by default and still obey publisher, edition, language and extent checks', async (t) => {
  const f = await fixture(t);
  const candidate = {
    provider: 'anna',
    url: f.ref.card,
    title: 'Technical product documentation',
    pageCount: null,
    format: 'PDF',
  };
  const edition = {
    reference: 'ISO 129-1:2018',
    title: 'Official fixture title',
    pageCount: 4,
    status: 'Published',
  };
  let downloads = 0;
  const options = {
    candidates: [candidate],
    downloadPDF: async (child) => {
      downloads++;
      await fs.writeFile(path.join(child.directory, 'source.pdf'), f.bytes);
    },
    importPDF,
  };
  f.job.isoEdition = edition;
  await assert.rejects(runSearchJob(f.job, f.directory, options));
  assert.equal(downloads, 0);
  await runSearchJob(f.job, f.directory, { ...options, experimentalAnna: true });
  assert.equal(downloads, 1);
  assert.equal(f.job.stage, 'done');
  assert.equal(f.job.total, 4);
  for (const check of ['identity', 'language', 'extent', 'completeness'])
    assert.equal(f.job.verification[check].status, 'passed');
  assert.match(f.job.pdfFilename, /ISO 129-1 2018 Official fixture title/);
  await assert.rejects(
    fs.access(path.join(f.directory, 'document-cache/index')),
    'experimental results cannot affect ordinary shared searches',
  );
  const wrong = await fixture(t, 'BS ISO 129-1:2018');
  wrong.job.isoEdition = edition;
  await assert.rejects(
    runSearchJob(wrong.job, wrong.directory, {
      experimentalAnna: true,
      candidates: [{ ...candidate, url: wrong.ref.card }],
      downloadPDF: async (child) =>
        fs.writeFile(path.join(child.directory, 'source.pdf'), wrong.bytes),
      importPDF,
    }),
  );
  assert.equal(wrong.job.pdfReady, false);
  assert.equal(wrong.job.searchResults[0].checks.identity.status, 'failed');
});

test('native PDF imports check rendered scripts even when an English text layer is present', async (t) => {
  const f = await fixture(t),
    pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica);
  const image = await pdf.embedPng(
    await fs.readFile(path.join(__dirname, 'fixtures/language-chinese.png')),
  );
  for (let n = 0; n < 3; n++) {
    const page = pdf.addPage([600, 800]);
    page.drawImage(image, { x: 0, y: 100, width: 600, height: (600 * 1500) / 1400 });
    page.drawText('ISO 129-1:2018 English', { font, size: 8, x: 10, y: 5 });
  }
  await fs.writeFile(path.join(f.directory, 'source.pdf'), await pdf.save());
  f.job.cacheDirectory = path.resolve(__dirname, '../.data/models');
  await assert.rejects(source.verifyScripts(f.job), { code: 'FOREIGN_SCRIPT' });
  assert.equal(f.job.scriptVerification.status, 'failed');
});

test('a discovered card reuses only checksum-valid original bytes from a previous local job', async (t) => {
  const f = await fixture(t);
  const record = {
    version: 1,
    card: f.ref.card,
    md5: f.md5,
    sha256: createHash('sha256').update(f.bytes).digest('hex'),
    pages: 4,
    bytes: f.bytes.length,
  };
  const prior = path.join(
    f.directory,
    'jobs',
    '11111111-1111-4111-8111-111111111111',
    'candidates',
    require('../page-check.cjs').digest(f.ref.card).slice(0, 24),
  );
  await fs.mkdir(prior, { recursive: true });
  await fs.writeFile(path.join(prior, 'source.pdf'), f.bytes);
  await fs.writeFile(path.join(prior, 'anna-download.json'), JSON.stringify(record));
  const result = await source.downloadAnnaPDF(f.job, f.directory, {
    launchContext: () => assert.fail('A verified local original must skip browser confirmation'),
  });
  assert.deepEqual(await fs.readFile(result), f.bytes);
  assert.equal(f.job.sourcePDFReused, true);
  await fs.rm(result);
  await fs.rm(path.join(f.directory, 'anna-download.json'));
  await fs.writeFile(path.join(prior, 'source.pdf'), Buffer.from('damaged'));
  await assert.rejects(
    source.downloadAnnaPDF(f.job, f.directory, {
      launchContext: async () => {
        throw Error('Browser required');
      },
    }),
    /Browser required/,
  );
});
