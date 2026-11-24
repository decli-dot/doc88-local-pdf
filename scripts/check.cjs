const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const files = [
  'cache-list.cjs',
  'document-review.cjs',
  'iteh-catalog.cjs',
  'captcha-service.cjs',
  'doc88-network.cjs',
  'browser-navigation.cjs',
  'captcha-browser.cjs',
  'doc88-captcha.cjs',
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
  'server.cjs',
  'source-policy.cjs',
  'source-search.cjs',
  'cloud-server.cjs',
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
  'iso-catalog.cjs',
  'challenge-view.cjs',
  'launcher.cjs',
  'dist/app.js',
  'dist/query.js',
  'dist/standard-reference.js',
  'dist/product.js',
  'dist/ocr-language.js',
  'dist/job-feedback.js',
  'dist/i18n.js',
  'dist/challenge.js',
];
for (const directory of ['scripts', 'tests', 'extension', 'web', 'cloud', 'experimental']) {
  files.push(
    ...fs
      .readdirSync(path.join(root, directory))
      .filter((name) => /\.(?:cjs|js)$/.test(name))
      .map((name) => directory + '/' + name),
  );
}
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, file)], {
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`Syntax checked: ${files.length} files.`);
