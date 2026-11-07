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
  // Rebuild only this verified generated directory; user data and model caches stay outside it.
  if (path.dirname(output) !== root || path.basename(output) !== '.web-build')
    throw Error('Invalid build output directory.');
  await fs.rm(output, { recursive: true, force: true });
  await fs.mkdir(output, { recursive: true });
  await copy('web/ocr.js', 'ocr.js');
  for (const name of ['app.js', 'query.js', 'challenge.js', 'style.css'])
    await copy('dist/' + name, name);
  const esbuild = require('esbuild');
  const aliases = {
    'node:fs/promises': 'web/store.js',
    'node:fs': 'web/browser-fs.js',
    'node:path': 'web/browser-path.js',
    'node:crypto': 'web/browser-crypto.js',
  };
  const browserBundle = await esbuild.build({
    entryPoints: [path.join(root, 'web/workspace.js')],
    outfile: path.join(output, 'workspace.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: ['chrome120'],
    minify: true,
    inject: [path.join(root, 'web/browser-buffer.js')],
    metafile: true,
    plugins: [
      {
        name: 'browser-adapters',
        setup(build) {
          build.onResolve({ filter: /^node:/ }, (args) => ({
            path: path.join(
              root,
              aliases[args.path] ||
                (() => {
                  throw Error('No browser adapter for ' + args.path);
                })(),
            ),
          }));
          build.onResolve({ filter: /(?:^|\/)runtime\.cjs$/ }, () => ({
            path: path.join(root, 'web/browser-runtime.js'),
          }));
          build.onResolve({ filter: /(?:^|\/)pipeline\.cjs$/ }, () => ({
            path: path.join(root, 'web/pipeline.js'),
          }));
        },
      },
    ],
  });
  let html = await fs.readFile(path.join(root, 'dist/index.html'), 'utf8');
  html = html
    .replace(/(src|href)="\//g, '$1="')
    .replace(
      '<title>Doc88 PDF · локальное приложение</title>',
      '<title>Doc88 PDF · поиск ISO и OCR в браузере</title>',
    )
    .replace(
      '<script defer src="challenge.js"></script>',
      '<script defer src="assets/jszip.min.js"></script><script defer src="assets/pdf-lib.min.js"></script><script defer src="assets/tesseract.min.js"></script><script defer src="ocr.js"></script><script defer src="workspace.js"></script><script defer src="challenge.js"></script>',
    )
    .replace(
      '</head>',
      "<link rel=\"stylesheet\" href=\"workspace.css\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; img-src 'self' blob: data:; connect-src 'self'; style-src 'self'; object-src 'none'; base-uri 'self'\">\n</head>",
    )
    .replace(
      '<div class="workspace">',
      (await fs.readFile(path.join(root, 'web/setup.html'), 'utf8')) + '<div class="workspace">',
    )
    .replace('На твоём компьютере', 'В твоём браузере')
    .replace('Закрыть приложение', 'Остановить работу')
    .replace('локальное приложение', 'браузерная программа')
    .replace('Распознавание на компьютере', 'Распознавание в браузере')
    .replace(
      'Локальная мастерская документов',
      'Поиск ISO и OCR в браузере · История хранится в этом браузере. Очистка данных сайта удалит её.',
    );
  const version = require('../package.json').version;
  html = html.replace(/(src|href)="([^"?]+\.(?:js|css))"/g, `$1="$2?v=${version}"`);
  await fs.writeFile(path.join(output, 'index.html'), html);
  await copy('web/workspace.css', 'workspace.css');
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
  const bundledPackages = Object.keys(browserBundle.metafile.inputs)
    .map((file) => file.split('node_modules/').at(-1))
    .filter(
      (file) =>
        file && !file.startsWith('web/') && !file.startsWith('dist/') && !file.endsWith('.cjs'),
    )
    .map((file) =>
      file.startsWith('@') ? file.split('/').slice(0, 2).join('/') : file.split('/')[0],
    );
  for (const dependency of new Set([
    'jszip',
    'pdf-lib',
    'tesseract.js',
    'tesseract.js-core',
    ...bundledPackages,
  ])) {
    const directory = path.join(root, 'node_modules', dependency);
    const license = (await fs.readdir(directory)).find((name) => /^license(?:\.|$)/i.test(name));
    if (
      !license &&
      dependency === 'franc-min' &&
      require('../node_modules/franc-min/package.json').version === '6.2.0'
    ) {
      await copy('web/licenses/franc-min.txt', 'assets/licenses/franc-min.txt');
      continue;
    }
    if (!license) throw new Error('Dependency license missing: ' + dependency);
    await copy(
      `node_modules/${dependency}/${license}`,
      `assets/licenses/${dependency.replaceAll('/', '-')}.txt`,
    );
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
