'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path');
const { createCanvas } = require('@napi-rs/canvas');
(async () => {
  const din = process.argv.includes('--din'),
    id = din ? 'din-276' : process.argv[2] || '9e1ca637-f980-4490-bcc9-cc54c43de4ec';
  if (!din && !/^[a-f\d-]{36}$/.test(id)) throw Error('Invalid job ID');
  const directory = path.resolve(__dirname, '../.data/structure-review', id);
  await fs.mkdir(directory, { recursive: true });
  const bytes = await fs.readFile(
    din
      ? path.resolve(__dirname, '../.data/engine-validation/din-276/auto/result.pdf')
      : path.resolve(__dirname, '../.data/jobs', id, 'result.pdf'),
  );
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs'),
    loading = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false });
  try {
    const pdf = await loading.promise;
    const all = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n),
        viewport = page.getViewport({ scale: 1 }),
        content = await page.getTextContent();
      const items = content.items.filter((item) => typeof item.str === 'string');
      const text = require('../copy-text.cjs').textFromItems(items, viewport.width);
      await fs.writeFile(path.join(directory, `page${n}.txt`), text);
      all.push({
        page: n,
        width: viewport.width,
        height: viewport.height,
        items,
        styles: content.styles,
        text,
      });
      if ((din ? [3, 4, 5, 6, 7] : [5, 9, 10]).includes(n)) {
        const l = require('../structure-layout.cjs').layoutLines(
          items,
          viewport.width,
          viewport.height,
          content.styles,
        );
        console.log(
          JSON.stringify({
            page: n,
            lines: l.lines.slice(0, 24).map((x) => x.text),
            text: require('../experimental/quality.cjs')
              .nativeLayoutText(items, viewport.width)
              .slice(0, 1800),
          }),
        );
      }
      if ([6, 7, 8, 9, 10].includes(n)) {
        const view = page.getViewport({ scale: 1.5 }),
          canvas = createCanvas(Math.ceil(view.width), Math.ceil(view.height));
        await page.render({ canvasContext: canvas.getContext('2d'), viewport: view }).promise;
        await fs.writeFile(path.join(directory, `page${n}.png`), canvas.toBuffer('image/png'));
      }
      page.cleanup();
    }
    await fs.writeFile(path.join(directory, 'layout.json'), JSON.stringify(all));
  } finally {
    await loading.destroy();
  }
})().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
