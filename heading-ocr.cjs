'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path');
const { spawn } = require('node:child_process');
const { createCanvas } = require('@napi-rs/canvas');
const { nativeOCR } = require('./runtime.cjs');
const { atomicWrite, readJSON } = require('./checkpoints.cjs');
const { digest } = require('./page-check.cjs');
const { layoutLines } = require('./structure-layout.cjs');
function abortable(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason || Error('Обработка остановлена.'));
    signal.addEventListener('abort', stop, { once: true });
    Promise.resolve(promise)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', stop));
    if (signal.aborted) stop();
  });
}
function tsvItems(tsv, scale, pageHeight) {
  const rows = String(tsv).trim().split(/\r?\n/).slice(1),
    items = [],
    baselines = new Map();
  for (const row of rows) {
    const fields = row.split('\t');
    if (fields[0] !== '5') continue;
    const key = fields.slice(1, 5).join('/'),
      bottom = Number(fields[7]) + Number(fields[9]);
    if (Number.isFinite(bottom)) baselines.set(key, Math.max(bottom, baselines.get(key) || 0));
  }
  for (const row of rows) {
    const fields = row.split('\t');
    if (fields[0] !== '5' || Number(fields[10]) < 35) continue;
    const str = fields.slice(11).join('\t').trim();
    if (!str) continue;
    const [x, y, width, height] = fields.slice(6, 10).map(Number);
    if (![x, y, width, height].every(Number.isFinite) || height <= 0) continue;
    items.push({
      str,
      width: width / scale,
      height: height / scale,
      fontName: 'heading-ocr',
      transform: [
        height / scale,
        0,
        0,
        height / scale,
        x / scale,
        pageHeight - (baselines.get(fields.slice(1, 5).join('/')) || y + height) / scale,
      ],
    });
  }
  return items;
}
function recognize(executable, filename, language, signal) {
  return new Promise((resolve, reject) => {
    const process = spawn(
      executable,
      [filename, 'stdout', '-l', language, '--dpi', '150', '--psm', '3', 'tsv'],
      {
        windowsHide: true,
        signal,
        timeout: 30000,
        env: { ...global.process.env, OMP_THREAD_LIMIT: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let text = '',
      error = '';
    process.stdout.on('data', (bytes) => {
      text += bytes;
      if (text.length > 8 * 1024 * 1024) process.kill();
    });
    process.stderr.on('data', (bytes) => (error = (error + bytes).slice(-2000)));
    process.once('error', reject);
    process.once('close', (code) =>
      code === 0 ? resolve(text) : reject(Error('Не удалось распознать заголовки: ' + error)),
    );
  });
}
async function recoverHeadings(
  pdf,
  layouts,
  {
    signal,
    language = 'eng',
    cacheDirectory = path.join(__dirname, '.data/structure-ocr'),
    modelsDirectory = path.join(__dirname, '.data/models'),
    onProgress = () => {},
  } = {},
) {
  const executable = nativeOCR(language);
  await fs.mkdir(cacheDirectory, { recursive: true });
  let recognized = 0,
    worker = null;
  const stopWorker = () => {
    if (worker) void worker.terminate().catch(() => {});
  };
  signal?.addEventListener('abort', stopWorker, { once: true });
  try {
    for (let index = 0; index < layouts.length; index++) {
      signal?.throwIfAborted();
      const layout = layouts[index],
        page = await pdf.getPage(index + 1);
      // Read only visible material absent from the native text. Existing OCR on
      // scanned pages is already a text layer and is not recognized a second time.
      const operators = await page.getOperatorList();
      const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const vector = operators.fnArray.filter((code) => code === OPS.constructPath).length;
      if (vector < 15) {
        page.cleanup();
        continue;
      }
      onProgress(index + 1, layouts.length);
      const scale = 2,
        view = page.getViewport({ scale }),
        canvas = createCanvas(Math.ceil(view.width), Math.ceil(view.height)),
        context = canvas.getContext('2d');
      const render = page.render({ canvasContext: context, viewport: view }),
        stop = () => render.cancel();
      signal?.addEventListener('abort', stop, { once: true });
      try {
        await render.promise;
      } finally {
        signal?.removeEventListener('abort', stop);
      }
      const contents = layout.lines.some((line) =>
        /^(?:Inhalt|Sommaire|Contents)\b/i.test(line.text),
      );
      if (!contents) {
        context.fillStyle = '#fff';
        for (const line of layout.lines)
          context.fillRect(
            (line.x - 0.8) * scale,
            (line.top - 0.8) * scale,
            (line.width + 1.6) * scale,
            (line.height + 2.8) * scale,
          );
      }
      const png = canvas.toBuffer('image/png'),
        key = digest(
          Buffer.concat([
            Buffer.from(language + '-headings-v3-' + (executable ? 'native' : 'wasm')),
            png,
          ]),
        ),
        filename = path.join(cacheDirectory, key + '.png'),
        saved = await readJSON(path.join(cacheDirectory, key + '.json'));
      let items = saved?.items;
      if (!items) {
        await atomicWrite(filename, png);
        try {
          let tsv;
          if (executable) tsv = await recognize(executable, filename, language, signal);
          else {
            if (!worker) {
              await fs.mkdir(modelsDirectory, { recursive: true });
              const creating = require('tesseract.js')
                .createWorker(language, 1, { cachePath: modelsDirectory, errorHandler: () => {} })
                .then(async (ready) => {
                  if (signal?.aborted) {
                    await ready.terminate();
                    throw Error('Обработка остановлена.');
                  }
                  return ready;
                });
              worker = await abortable(creating, signal);
              await abortable(
                worker.setParameters({ tessedit_pageseg_mode: '3', user_defined_dpi: '150' }),
                signal,
              );
            }
            tsv = (await abortable(worker.recognize(png, {}, { text: false, tsv: true }), signal))
              .data.tsv;
          }
          items = tsvItems(tsv, scale, view.height / scale);
          await atomicWrite(path.join(cacheDirectory, key + '.json'), JSON.stringify({ items }));
        } finally {
          await fs.rm(filename, { force: true });
        }
      }
      const extra = layoutLines(items, layout.width, layout.height);
      if (extra.lines.length) {
        layout.lines.push(...extra.lines.map((line) => ({ ...line, recovered: true })));
        layout.lines.sort(
          (a, b) =>
            (a.baseline ?? a.top + a.height) - (b.baseline ?? b.top + b.height) || a.x - b.x,
        );
        recognized++;
      }
      page.cleanup();
    }
    return { available: true, pages: recognized };
  } finally {
    signal?.removeEventListener('abort', stopWorker);
    if (worker) await worker.terminate().catch(() => {});
  }
}
module.exports = { recoverHeadings, tsvItems };
