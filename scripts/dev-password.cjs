'use strict';
// Read from stdin so a password never becomes part of a command line or URL.
const fs = require('node:fs/promises');
const path = require('node:path');
const { passwordRecord } = require('../dev-access.cjs');
(async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const password = Buffer.concat(chunks).toString('utf8').trim();
  if (!password || password.length > 256) throw Error('Password must contain 1–256 characters.');
  const directory = path.resolve(process.env.DOC88_DATA_DIR || path.join(__dirname, '../.data'));
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, 'dev-access.json'),
    JSON.stringify(passwordRecord(password)),
    { mode: 0o600 },
  );
  console.log('Developer password configured. Restart DecliPDF to apply.');
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
