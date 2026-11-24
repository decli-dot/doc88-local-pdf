'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path');
const { spawn } = require('node:child_process');
const { PDFDocument } = require('pdf-lib');
const { dependency } = require('./runtime.cjs');
const { digest } = require('./page-check.cjs');
const { readJSON, atomicWrite } = require('./checkpoints.cjs');
const { prepareOCRImage } = require('./image-quality.cjs');
const { confidenceFromTSV } = require('./ocr-quality.cjs');
const { compressPDFImages } = require('./pdf-image-compression.cjs');
const { concurrencyFor, runPagePool } = require('./ocr-pool.cjs');
function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const cancel = () => reject(signal.reason || Error('Обработка остановлена.'));
    signal.addEventListener('abort', cancel, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener('abort', cancel);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', cancel);
        reject(error);
      },
    );
    if (signal.aborted) cancel();
  });
}
async function runNative(image, base, executable, language, signal) {
  signal.throwIfAborted();
  await new Promise((resolve, reject) => {
    const child = spawn(
      executable,
      [image, base, '-l', language, '--dpi', '150', '--psm', '3', 'pdf', 'txt', 'tsv'],
      {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        signal,
        env: { ...process.env, OMP_THREAD_LIMIT: '1' },
      },
    );
    let errorText = '',
      failure;
    child.stderr.on('data', (bytes) => {
      errorText = (errorText + bytes.toString('utf8')).slice(-4000);
    });
    child.once('error', (error) => {
      failure = error;
    });
    child.once('close', (code) => {
      if (failure) reject(failure);
      else if (code === 0) resolve();
      else reject(Error(`OCR страницы не завершился: ${errorText.trim() || 'код ' + code}`));
    });
  });
  signal.throwIfAborted();
}
async function recognizePages(job, images, language, native) {
  const pagesDirectory = path.join(job.directory, 'ocr');
  await fs.mkdir(pagesDirectory, { recursive: true });
  const concurrency = concurrencyFor(images.length, Boolean(native), job.ocrConcurrency);
  const engine =
    (native ? 'native' : 'wasm') +
    '-' +
    language +
    '-psm3-150-v2-' +
    (job.enhanceImages !== false ? 'enhance1' : 'original');
  const started = performance.now();
  let reused = 0,
    diagnostics = {},
    initializing = Promise.resolve(),
    successful = false;
  job.update({
    stage: 'ocr',
    current: 0,
    reusedOCRPages: 0,
    message: `Распознано страниц: 0 из ${images.length}`,
  });
  try {
    const results = await runPagePool(images, {
      signal: job.controller.signal,
      concurrency,
      createWorker: async (_slot, signal) => {
        let worker, pending, ending;
        const terminate = () => {
          if (worker && !ending) ending = worker.terminate().catch(() => {});
        };
        signal.addEventListener('abort', terminate, { once: true });
        async function ensureWorker() {
          if (worker) return worker;
          if (!pending) {
            // Initialization writes model caches; serialize it before allowing
            // independent recognition workers to use the same model directory.
            pending = initializing.then(async () => {
              signal.throwIfAborted();
              const cachePath =
                process.env.DOC88_OCR_CACHE ||
                job.cacheDirectory ||
                path.join(job.directory, 'models');
              await fs.mkdir(cachePath, { recursive: true });
              worker = await dependency('tesseract.js').createWorker(language, 1, {
                cachePath,
                errorHandler: (error) => job.log?.('OCR: ' + String(error).slice(0, 200)),
              });
              if (signal.aborted) {
                terminate();
                await ending;
                signal.throwIfAborted();
              }
              await worker.setParameters({ tessedit_pageseg_mode: '3', user_defined_dpi: '150' });
              return worker;
            });
            initializing = pending.then(
              () => {},
              () => {},
            );
          }
          return pending;
        }
        return {
          async recognize(image, base) {
            if (native) {
              await runNative(image, base + '.work', native, language, signal);
              const [pdf, text, tsv] = await Promise.all([
                fs.readFile(base + '.work.pdf'),
                fs.readFile(base + '.work.txt', 'utf8'),
                fs.readFile(base + '.work.tsv', 'utf8'),
              ]);
              return { pdf, text, confidence: confidenceFromTSV(tsv) };
            }
            const active = await ensureWorker();
            signal.throwIfAborted();
            const { data } = await abortable(
              active.recognize(image, { pdfTextOnly: false }, { text: true, pdf: true }),
              signal,
            );
            signal.throwIfAborted();
            return {
              pdf: Buffer.from(data.pdf),
              text: data.text || '',
              confidence: Number.isFinite(data.confidence) ? data.confidence : null,
            };
          },
          async close() {
            signal.removeEventListener('abort', terminate);
            await pending?.catch(() => {});
            terminate();
            await ending;
          },
        };
      },
      work: async (image, index, worker, signal) => {
        const base = path.join(pagesDirectory, `page${String(index + 1).padStart(5, '0')}`);
        const imageHash = digest(await fs.readFile(image)),
          record = await readJSON(base + '.json');
        let bytes,
          text,
          confidence = null,
          reused = false,
          enhancement = { scaleX: 1, scaleY: 1, enhanced: false },
          optimization;
        if (record?.imageHash === imageHash && record.engine === engine) {
          try {
            const [pdf, txt] = await Promise.all([
              fs.readFile(base + '.pdf'),
              fs.readFile(base + '.txt', 'utf8'),
            ]);
            if (
              digest(pdf) === record.pdfHash &&
              digest(txt) === record.textHash &&
              (
                await PDFDocument.load(pdf, { parseSpeed: 1500, updateMetadata: false })
              ).getPageCount() === 1
            ) {
              bytes = pdf;
              text = txt;
              confidence = record.confidence ?? null;
              enhancement = record.enhancement || enhancement;
              optimization = record.optimization;
              reused = true;
            }
          } catch {
            /* Re-recognize missing or damaged page checkpoints. */
          }
        }
        if (!bytes) {
          const prepared = await prepareOCRImage(
            image,
            base + '.enhanced.png',
            job.enhanceImages !== false,
          );
          const { path: ocrImage, ...info } = prepared;
          enhancement = info;
          signal.throwIfAborted();
          const result = await worker.recognize(ocrImage, base);
          bytes = result.pdf;
          text = result.text;
          confidence = result.confidence;
        }
        signal.throwIfAborted();
        const pdf = await PDFDocument.load(bytes, { parseSpeed: 1500, updateMetadata: false });
        if (pdf.getPageCount() !== 1)
          throw Error(`Неожиданное число страниц в результате OCR страницы ${index + 1}.`);
        let changed = !reused;
        if (optimization?.version !== 1) {
          try {
            optimization = await compressPDFImages(pdf, { signal });
            if (optimization.compressedImages)
              bytes = Buffer.from(await pdf.save({ objectsPerTick: 1500 }));
          } catch (error) {
            signal.throwIfAborted();
            job.log?.('PDF compression skipped: ' + error.message);
            optimization = {
              version: 1,
              lossless: true,
              images: 0,
              compressedImages: 0,
              imageBytesBefore: 0,
              imageBytesAfter: 0,
            };
          }
          changed = true;
        }
        signal.throwIfAborted();
        if (changed) {
          await atomicWrite(base + '.pdf', bytes);
          signal.throwIfAborted();
          await atomicWrite(base + '.txt', text);
          signal.throwIfAborted();
          // Commit the hash manifest last. Interrupted writes never become a
          // reusable page until all corresponding data is complete.
          await atomicWrite(
            base + '.json',
            JSON.stringify({
              imageHash,
              engine,
              pdfHash: digest(bytes),
              textHash: digest(text),
              enhancement,
              confidence,
              optimization,
            }),
          );
        }
        const temporary = native ? ['.work.pdf', '.work.txt', '.work.tsv'] : [];
        if (enhancement.enhanced) temporary.push('.enhanced.png');
        if (temporary.length)
          await Promise.all(temporary.map((ext) => fs.rm(base + ext, { force: true })));
        return { base, imageHash, text, confidence, enhancement, reused, optimization };
      },
      onComplete(result, _index, completed) {
        if (result.reused) reused++;
        job.update({
          stage: 'ocr',
          current: completed,
          reusedOCRPages: reused,
          message: `Распознано страниц: ${completed} из ${images.length}`,
        });
      },
      onState(state) {
        diagnostics = {
          version: 1,
          ...state,
          engine: native ? 'native' : 'wasm',
          threadsPerWorker: native ? 1 : null,
          elapsedMs: Math.round(performance.now() - started),
          status: 'running',
        };
        job.update({ ocrDiagnostics: diagnostics });
      },
    });
    successful = true;
    return results;
  } finally {
    job.update({
      ocrDiagnostics: {
        ...diagnostics,
        status: successful ? 'done' : job.controller.signal.aborted ? 'cancelled' : 'error',
        elapsedMs: Math.round(performance.now() - started),
      },
    });
  }
}
module.exports = { recognizePages, runNative };
