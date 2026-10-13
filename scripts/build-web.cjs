const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const JSZip = require('jszip');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.web-build');
const modelURL =
  'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz';
const modelSHA = '45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91';
function sha(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
async function copy(source, destination) {
  const target = path.join(output, destination);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(path.join(root, source), target);
}
(async () => {
  // This directory contains generated public assets only; never copy .data.
  await fs.mkdir(output, { recursive: true });
  for (const name of ['index.html', 'app.js', 'ocr.js', 'style.css'])
    await copy('web/' + name, name);
  await copy('dist/icon.svg', 'icon.svg');
  await copy('node_modules/jszip/dist/jszip.min.js', 'assets/jszip.min.js');
  await copy('node_modules/pdf-lib/dist/pdf-lib.min.js', 'assets/pdf-lib.min.js');
  for (const name of ['tesseract.min.js', 'worker.min.js'])
    await copy('node_modules/tesseract.js/dist/' + name, 'assets/' + name);
  for (const core of [
    'tesseract-core-lstm',
    'tesseract-core-simd-lstm',
    'tesseract-core-relaxedsimd-lstm',
  ]) {
    for (const extension of ['wasm', 'wasm.js'])
      await copy(
        `node_modules/tesseract.js-core/${core}.${extension}`,
        `assets/core/${core}.${extension}`,
      );
  }
  for (const dependency of ['jszip', 'pdf-lib', 'tesseract.js', 'tesseract.js-core']) {
    const directory = path.join(root, 'node_modules', dependency);
    const license = (await fs.readdir(directory)).find((name) => /^license(?:\.|$)/i.test(name));
    if (!license) throw new Error('Dependency license missing: ' + dependency);
    await copy(`node_modules/${dependency}/${license}`, `assets/licenses/${dependency}.txt`);
  }
  let model;
  const cache =
    process.env.DOC88_WEB_MODEL || path.join(root, '.data', 'web-assets', 'eng.traineddata.gz');
  try {
    model = await fs.readFile(cache);
  } catch {
    /* Download a pinned model on a clean checkout. */
  }
  if (!model || sha(model) !== modelSHA) {
    const response = await fetch(modelURL, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error('English model download failed: HTTP ' + response.status);
    model = Buffer.from(await response.arrayBuffer());
    if (sha(model) !== modelSHA) throw new Error('English OCR model checksum does not match.');
    if (!process.env.DOC88_WEB_MODEL) {
      await fs.mkdir(path.dirname(cache), { recursive: true });
      await fs.writeFile(cache, model);
    }
  }
  await fs.mkdir(path.join(output, 'assets/lang'), { recursive: true });
  await fs.writeFile(path.join(output, 'assets/lang/eng.traineddata.gz'), model);
  const zip = new JSZip();
  const prefix = 'doc88-browser-extension/';
  for (const name of (await fs.readdir(path.join(root, 'extension'))).sort())
    zip.file(prefix + name, await fs.readFile(path.join(root, 'extension', name)));
  zip.file(prefix + 'LICENSE', await fs.readFile(path.join(root, 'LICENSE')));
  zip.file(prefix + 'UPSTREAM-LICENSE', await fs.readFile(path.join(root, 'vendor/LICENSE')));
  await fs.writeFile(
    path.join(output, 'doc88-browser-extension.zip'),
    await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
  );
  console.log('Browser website and extension built: ' + output);
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
