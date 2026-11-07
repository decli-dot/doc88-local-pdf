const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const files = [
  'runtime.cjs',
  'server.cjs',
  'cloud-server.cjs',
  'pipeline.cjs',
  'checkpoints.cjs',
  'page-check.cjs',
  'image-quality.cjs',
  'document-analysis.cjs',
  'batch.cjs',
  'search.cjs',
  'iso-catalog.cjs',
  'challenge-view.cjs',
  'launcher.cjs',
  'dist/app.js',
  'dist/query.js',
  'dist/challenge.js',
];
for (const directory of ['scripts', 'tests', 'extension', 'web', 'cloud']) {
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
