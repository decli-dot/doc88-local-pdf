// Synthetic pages only: verify native OCR in the deployment image under resource limits.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const JSZip = require('/app/node_modules/jszip');
const { PDFDocument } = require('/app/node_modules/pdf-lib');
const { convertArchive } = require('/app/pipeline.cjs');
(async () => {
  const directory = path.join('/app/.data', 'container-ocr-' + randomUUID());
  const started = Date.now();
  await fs.mkdir(directory, { recursive: true });
  const zip = new JSZip();
  for (let index = 1; index <= 14; index++)
    zip.file(
      `page${String(index).padStart(3, '0')}.png`,
      await fs.readFile(`/fixture/fixture-${(index % 3) + 1}.png`),
    );
  await fs.writeFile(
    path.join(directory, 'archive.zip'),
    await zip.generateAsync({ type: 'nodebuffer' }),
  );
  const job = {
    directory,
    title: 'Synthetic container test',
    controller: new AbortController(),
    update(value) {
      Object.assign(this, value);
    },
  };
  await convertArchive(job);
  const bytes = await fs.readFile(path.join(directory, 'result.pdf'));
  const pdf = await PDFDocument.load(bytes);
  if (
    job.stage !== 'done' ||
    pdf.getPageCount() !== 14 ||
    job.textChars < 100 ||
    job.blankPages !== 5
  )
    throw new Error('Container OCR did not preserve all pages or recognize text.');
  console.log(
    JSON.stringify({
      success: true,
      synthetic: true,
      pages: 14,
      textChars: job.textChars,
      blankPages: job.blankPages,
      seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
    }),
  );
  const absolute = path.resolve(directory);
  if (
    path.dirname(absolute) !== '/app/.data' ||
    !path.basename(absolute).startsWith('container-ocr-')
  )
    throw new Error('Invalid test cleanup path.');
  await fs.rm(absolute, { recursive: true, force: true });
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
