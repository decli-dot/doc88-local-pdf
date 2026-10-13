// Exercise the actual deployed HTTP pipeline. Only metadata is published in CI.
const fs = require('node:fs/promises');
const path = require('node:path');
const { PDFDocument, PDFName } = require('pdf-lib');
const base = new URL(process.env.DOC88_CHECK_BASE || 'http://127.0.0.1:18973').origin;
const documentURL = process.env.DOC88_CHECK_URL || 'https://www.doc88.com/p-2592543989165.html';
const expected = Number(process.env.DOC88_CHECK_PAGES || 14);
const started = Date.now();
const report = { checkedAt: new Date().toISOString(), success: false, expectedPages: expected };
let cookie;
async function request(route, method = 'GET', value) {
  return fetch(base + route, {
    method,
    headers: {
      Origin: base,
      'x-doc88-request': '1',
      ...(cookie ? { Cookie: cookie } : {}),
      ...(value ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(value ? { body: JSON.stringify(value) } : {}),
    signal: AbortSignal.timeout(90000),
  });
}
(async () => {
  try {
    let config;
    for (let attempt = 0; attempt < 90; attempt++) {
      try {
        config = await request('/api/config');
        if (config.ok) break;
      } catch {
        /* Container starting. */
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!config?.ok) throw new Error('Cloud server did not start.');
    cookie = config.headers.get('set-cookie')?.split(';')[0];
    if (!cookie) throw new Error('Session cookie is missing.');
    const response = await request('/api/jobs', 'POST', {
      url: documentURL,
      fromPage: 1,
      toPage: null,
    });
    const created = await response.json();
    if (response.status !== 202) throw new Error(created.error || 'Job creation failed.');
    let job;
    let last = '';
    while (Date.now() - started < 11 * 60 * 1000) {
      const status = await request('/api/jobs/' + created.id);
      job = await status.json();
      if (!status.ok) throw new Error(job.error || 'Job status unavailable.');
      const progress = `${job.stage}: ${job.current}/${job.total}`;
      if (progress !== last) {
        console.log(progress);
        last = progress;
      }
      if (['done', 'error', 'cancelled'].includes(job.stage)) break;
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    if (job.stage !== 'done' || !job.pdfReady)
      throw new Error(job.message || 'Cloud job did not finish.');
    if (job.total !== expected || !(job.textChars > 0))
      throw new Error('Page count or OCR text is incorrect.');
    const result = await request(`/api/jobs/${job.id}/pdf`);
    if (!result.ok) throw new Error('PDF download failed.');
    const bytes = Buffer.from(await result.arrayBuffer());
    const pdf = await PDFDocument.load(bytes);
    if (pdf.getPageCount() !== expected) throw new Error('PDF page count is incorrect.');
    for (const page of pdf.getPages()) {
      const resources = page.node.Resources();
      if (!resources?.get(PDFName.of('XObject')) || !resources.get(PDFName.of('Font')))
        throw new Error('PDF image or text font resource missing.');
    }
    report.success = true;
    report.pages = pdf.getPageCount();
    report.bytes = bytes.length;
    report.textChars = job.textChars;
    report.blankPages = job.blankPages;
  } catch (error) {
    report.error = error.message;
    process.exitCode = 1;
  } finally {
    report.seconds = Number(((Date.now() - started) / 1000).toFixed(1));
    await fs.mkdir(path.resolve(__dirname, '../.data'), { recursive: true });
    await fs.writeFile(
      path.resolve(__dirname, '../.data/cloud-server-report.json'),
      JSON.stringify(report, null, 2) + '\n',
    );
    console.log('CLOUD_SERVER_REPORT=' + JSON.stringify(report));
  }
})();
