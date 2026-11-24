'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { createCanvas } = require('@napi-rs/canvas');
const { digest } = require('../page-check.cjs');
const root = path.resolve(__dirname, '../.data/structure-review');
const flatten = (nodes) => nodes.flatMap((n) => [n, ...flatten(n.children)]);
(async () => {
  if (process.argv.includes('--din')) {
    const directory = path.join(root, 'din-276');
    await fs.mkdir(directory, { recursive: true });
    const structure = await require('../pdf-structure.cjs').structureFromPDF(
      await fs.readFile(
        path.resolve(__dirname, '../.data/engine-validation/din-276/auto/result.pdf'),
      ),
      [],
      {
        language: 'deu',
        cacheDirectory: path.join(directory, 'cache'),
        onProgress: (n, t) => console.log('Headings ' + n + '/' + t),
      },
    );
    await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(structure, null, 2));
    for (const label of ['1', '2', '3', '4', '5', '6'])
      assert.ok(
        structure.nodes.some((n) => n.label === label),
        'DIN root ' + label,
      );
    assert.ok(structure.nodes.some((n) => n.kind === 'bibliography'));
    assert.equal(structure.nodes.find((n) => n.label === '2').title, 'Normative Verweisungen');
    assert.equal(structure.nodes.find((n) => n.label === '3').title, 'Begriffe');
    assert.deepEqual(
      structure.nodes.filter((n) => n.kind === 'section').map((n) => n.label),
      ['1', '2', '3', '4', '5', '6'],
    );
    console.log(
      JSON.stringify({
        standard: 'DIN 276',
        headings: structure.count,
        roots: structure.nodes.map((n) => n.label + ' ' + n.title),
        recovery: structure.headingRecovery,
      }),
    );
    return;
  }
  const id = '9e1ca637-f980-4490-bcc9-cc54c43de4ec',
    directory = path.join(root, id),
    report = JSON.parse(await fs.readFile(path.join(directory, 'report.json'), 'utf8'));
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs'),
    source = pdfjs.getDocument({
      data: new Uint8Array(
        await fs
          .readFile(
            path.resolve(
              __dirname,
              '../.data/structure-backups',
              id,
              report.sourceHash,
              'result.pdf',
            ),
          )
          .catch((error) => {
            if (error.code !== 'ENOENT') throw error;
            return fs.readFile(path.resolve(__dirname, '../.data/jobs', id, 'result.pdf'));
          }),
      ),
    }),
    result = pdfjs.getDocument({
      data: new Uint8Array(await fs.readFile(path.join(directory, 'result.pdf'))),
    });
  try {
    const [before, after] = await Promise.all([source.promise, result.promise]);
    assert.equal(before.numPages, after.numPages);
    const snapshots = [];
    for (const number of [1, 9, 10, 17, 24]) {
      const hashes = [];
      for (const [index, pdf] of [before, after].entries()) {
        const page = await pdf.getPage(number),
          view = page.getViewport({ scale: 1.2 }),
          canvas = createCanvas(Math.ceil(view.width), Math.ceil(view.height)),
          context = canvas.getContext('2d');
        await page.render({ canvasContext: context, viewport: view }).promise;
        hashes.push(
          digest(Buffer.from(context.getImageData(0, 0, canvas.width, canvas.height).data)),
        );
        if (index === 1)
          await fs.writeFile(
            path.join(directory, 'verified-page' + number + '.png'),
            canvas.toBuffer('image/png'),
          );
        page.cleanup();
      }
      assert.equal(hashes[0], hashes[1], 'Page pixels changed: ' + number);
      snapshots.push({ page: number, pixelsUnchanged: true });
    }
    const entries = await after.getOutline(),
      nodes = flatten(report.structure.nodes);
    let targets = 0;
    async function verify(items) {
      for (const item of items) {
        const node = nodes.find((n) => item.title === n.label + (n.title ? ' ' + n.title : ''));
        assert.ok(node, 'Unknown PDF outline ' + item.title);
        assert.equal((await after.getPageIndex(item.dest[0])) + 1, node.page);
        targets++;
        await verify(item.items || []);
      }
    }
    await verify(entries || []);
    assert.equal(targets, report.after);
    assert.doesNotMatch(JSON.stringify(entries), /Copyright|Resale|Except for a|through 17|\.190/i);
    const proof = {
      standard: 'ASME Y14.6',
      before: report.before,
      after: report.after,
      pages: after.numPages,
      validTargets: targets,
      snapshots,
    };
    await fs.writeFile(path.join(directory, 'validation.json'), JSON.stringify(proof, null, 2));
    console.log(JSON.stringify(proof));
  } finally {
    await source.destroy();
    await result.destroy();
  }
})().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
