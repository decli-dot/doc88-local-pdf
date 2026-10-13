// One-off cloud preflight. Only metadata is kept in the public Actions report.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { PDFDocument, PDFName } = require('pdf-lib');
const { validateURL, downloadArchive, convertArchive } = require('../pipeline.cjs');
const root = path.resolve(__dirname, '..');

(async () => {
  const url = validateURL(
    process.env.DOC88_CHECK_URL || 'https://www.doc88.com/p-2592543989165.html',
  );
  const expected = Number(process.env.DOC88_CHECK_PAGES || 14);
  if (!Number.isSafeInteger(expected) || expected < 1 || expected > 500)
    throw new Error('Expected page count must be between 1 and 500.');
  const directory = path.join(root, '.data', 'cloud-check', randomUUID());
  await fs.mkdir(directory, { recursive: true });
  let lastProgress = '';
  const job = {
    directory,
    url,
    fromPage: 1,
    toPage: null,
    title: 'Cloud check',
    controller: new AbortController(),
    update(value) {
      Object.assign(this, value);
      const progress = `${this.stage}: ${this.current || 0}/${this.total || '?'} ${this.message || ''}`;
      if (progress !== lastProgress) {
        console.log(progress);
        lastProgress = progress;
      }
    },
    log(value) {
      console.log(String(value).slice(0, 200));
    },
  };
  const report = {
    checkedAt: new Date().toISOString(),
    documentURL: url,
    expectedPages: expected,
    runtime: {
      os: os.platform(),
      architecture: os.arch(),
      node: process.version,
      githubHosted: process.env.GITHUB_ACTIONS === 'true',
    },
    success: false,
    download: { success: false },
    ocr: { success: false },
  };
  const started = Date.now();
  const timeout = setTimeout(() => job.controller.abort(), 5 * 60 * 1000);
  try {
    const downloadStarted = Date.now();
    await downloadArchive(job, directory, {
      headless: true,
      channel: 'chromium',
      rejectChallenges: true,
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1.5,
    });
    const archive = await fs.stat(path.join(directory, 'archive.zip'));
    report.download = {
      success: true,
      pages: job.total,
      bytes: archive.size,
      seconds: Number(((Date.now() - downloadStarted) / 1000).toFixed(1)),
      title: job.title,
    };
    if (job.total !== expected)
      throw new Error(`Document contains ${job.total} pages, expected ${expected}.`);
    const ocrStarted = Date.now();
    await convertArchive(job);
    const bytes = await fs.readFile(path.join(directory, 'result.pdf'));
    const pdf = await PDFDocument.load(bytes);
    if (pdf.getPageCount() !== expected) throw new Error('PDF page count does not match.');
    for (const page of pdf.getPages()) {
      const resources = page.node.Resources();
      if (!resources?.get(PDFName.of('XObject')) || !resources.get(PDFName.of('Font')))
        throw new Error('PDF image or text font resource is missing.');
    }
    if (!(job.textChars > 0)) throw new Error('OCR returned no text.');
    report.ocr = {
      success: true,
      pages: pdf.getPageCount(),
      bytes: bytes.length,
      textChars: job.textChars,
      blankPages: job.blankPages,
      seconds: Number(((Date.now() - ocrStarted) / 1000).toFixed(1)),
    };
    report.success = true;
  } catch (error) {
    report.error = {
      stage: job.stage,
      message: error.message,
      challengeRequired: job.stage === 'challenge',
    };
    process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
    report.seconds = Number(((Date.now() - started) / 1000).toFixed(1));
    const reportPath = path.join(root, '.data', 'cloud-report.json');
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
    console.log('CLOUD_REPORT=' + JSON.stringify(report));
    if (process.env.GITHUB_STEP_SUMMARY) {
      const summary = [
        '### Doc88 cloud preflight',
        '',
        `Result: **${report.success ? 'passed' : 'failed'}**`,
        `Document: ${url}`,
        `Downloaded: ${report.download.pages || 0} / ${expected} pages`,
        `Searchable PDF: ${report.ocr.pages || 0} pages; ${report.ocr.textChars || 0} recognized characters`,
        `Time: ${report.seconds} seconds (without dependency setup)`,
        report.error
          ? `Error: ${report.error.message}`
          : 'No manual CAPTCHA or login was needed in this run.',
        '',
        'The artifact contains JSON metadata only. Document images, ZIP and PDF are not uploaded.',
        'This checks a GitHub-hosted Linux VM, not a Render deployment.',
      ].join('\n');
      await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
    }
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
