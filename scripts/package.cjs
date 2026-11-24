const fs = require('node:fs/promises');
const path = require('node:path');
const { dependency } = require('../runtime.cjs');
const JSZip = dependency('jszip');
const root = path.resolve(__dirname, '..');
const manifest = require('../package.json');
const files = [
  'cache-list.cjs',
  'document-review.cjs',
  'iteh-catalog.cjs',
  'captcha-service.cjs',
  'doc88-network.cjs',
  'browser-navigation.cjs',
  'captcha-browser.cjs',
  'doc88-captcha.cjs',
  'Start.cmd',
  'Setup.cmd',
  'launcher.cjs',
  'runtime.cjs',
  'ocr-quality.cjs',
  'ocr-pool.cjs',
  'ocr-pages.cjs',
  'pdf-image-compression.cjs',
  'shared-cache.cjs',
  'timing.cjs',
  'preview-pool.cjs',
  'document-engine.cjs',
  'direct-pdf.cjs',
  'direct-repair.cjs',
  'preview-document.cjs',
  'en-catalog.cjs',
  'dev-access.cjs',
  'publisher-catalog.cjs',
  'reseller-catalog.cjs',
  'script-check.cjs',
  'pdf-sources.cjs',
  'public-http.cjs',
  'pdf-input.cjs',
  'copy-text.cjs',
  'pipeline.cjs',
  'checkpoints.cjs',
  'page-check.cjs',
  'image-quality.cjs',
  'document-analysis.cjs',
  'structure.cjs',
  'structure-layout.cjs',
  'pdf-structure.cjs',
  'heading-ocr.cjs',
  'batch.cjs',
  'search.cjs',
  'source-policy.cjs',
  'source-search.cjs',
  'iso-catalog.cjs',
  'challenge-view.cjs',
  'server.cjs',
  'cloud-server.cjs',
  'Dockerfile',
  '.dockerignore',
  'render.yaml',
  'package.json',
  'package-lock.json',
  'README.md',
  'VALIDATION.md',
  'LICENSE',
  'CHANGELOG.md',
  '.prettierrc.json',
  '.prettierignore',
];
async function addDirectory(zip, relative) {
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = relative + '/' + entry.name;
    if (entry.isDirectory()) await addDirectory(zip, name);
    else if (entry.isFile()) zip.file(name, await fs.readFile(path.join(root, name)));
  }
}
(async () => {
  const zip = new JSZip();
  for (const file of files) zip.file(file, await fs.readFile(path.join(root, file)));
  for (const directory of [
    'dist',
    'vendor',
    'scripts',
    'tests',
    'web',
    'extension',
    'cloud',
    'docs',
    'experimental',
  ])
    await addDirectory(zip, directory);
  const output = path.join(root, 'release');
  await fs.mkdir(output, { recursive: true });
  const filename = `doc88-local-pdf-v${manifest.version}.zip`;
  await fs.writeFile(
    path.join(output, filename),
    await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
  );
  console.log(path.join(output, filename));
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
