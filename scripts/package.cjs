const fs = require('node:fs/promises');
const path = require('node:path');
const { dependency } = require('../runtime.cjs');
const JSZip = dependency('jszip');
const root = path.resolve(__dirname, '..');
const manifest = require('../package.json');
const files = [
  'Start.cmd',
  'Setup.cmd',
  'launcher.cjs',
  'runtime.cjs',
  'pipeline.cjs',
  'server.cjs',
  'package.json',
  'package-lock.json',
  'README.md',
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
  for (const directory of ['dist', 'vendor', 'scripts', 'tests'])
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
