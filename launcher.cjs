'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { dependency } = require('./runtime.cjs');
const port = Number(process.env.DOC88_PORT || 8968);
const url = `http://127.0.0.1:${port}`;
async function status() {
  try {
    const response = await fetch(url + '/api/status', { signal: AbortSignal.timeout(1000) });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}
async function main() {
  if (Number(process.versions.node.split('.')[0]) < 22)
    throw new Error('Install Node.js 24 LTS from https://nodejs.org');
  for (const name of ['playwright', 'jszip', 'pdf-lib', 'tesseract.js']) dependency(name);
  let app = await status();
  if (app && app.app !== 'doc88-local-pdf')
    throw new Error('Another app is using this port. Set DOC88_PORT to another port.');
  if (!app) {
    const logs = path.join(__dirname, '.data');
    fs.mkdirSync(logs, { recursive: true });
    const fd = fs.openSync(path.join(logs, 'server.log'), 'a');
    const child = spawn(process.execPath, [path.join(__dirname, 'server.cjs')], {
      cwd: __dirname,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
    });
    child.unref();
    fs.closeSync(fd);
    for (let attempt = 0; attempt < 40; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      app = await status();
      if (app?.app === 'doc88-local-pdf') break;
    }
    if (app?.app !== 'doc88-local-pdf')
      throw new Error('Could not start the app. Check .data/server.log.');
  }
  if (process.env.DOC88_OPEN_BROWSER === '0') {
    console.log(url);
  } else if (process.platform === 'win32') {
    const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    });
    child.unref();
    child.on('error', () => console.log(url));
  } else console.log(url);
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
