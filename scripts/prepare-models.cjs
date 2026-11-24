'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { createHash } = require('node:crypto');
const models = new Set(['eng', 'deu', 'fra', 'rus', 'osd']);
(async () => {
  const root = path.resolve(__dirname, '..');
  const requested = process.argv.slice(2);
  for (const language of requested.length ? requested : ['eng', 'deu', 'fra', 'rus', 'osd']) {
    if (!models.has(language)) throw Error('Unsupported language.');
    const folder = language === 'osd' ? '4.0.0' : '4.0.0_best_int';
    const url = `https://cdn.jsdelivr.net/npm/@tesseract.js-data/${language}/${folder}/${language}.traineddata.gz`;
    const cache = path.join(root, '.data/web-assets', language + '.traineddata.gz');
    let bytes;
    try {
      bytes = await fs.readFile(cache);
    } catch {
      const response = await fetch(url, { signal: AbortSignal.timeout(45000) });
      if (!response.ok) throw Error('Model download: HTTP ' + response.status);
      bytes = Buffer.from(await response.arrayBuffer());
      await fs.mkdir(path.dirname(cache), { recursive: true });
      await fs.writeFile(cache, bytes);
    }
    const output = path.join(root, '.data/models');
    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(path.join(output, language + '.traineddata'), zlib.gunzipSync(bytes));
    console.log(language, bytes.length, createHash('sha256').update(bytes).digest('hex'));
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
