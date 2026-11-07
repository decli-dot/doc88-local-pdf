'use strict';
const { Buffer } = require('buffer');
let database;
function db() {
  if (!database)
    database = new Promise((resolve, reject) => {
      const request = indexedDB.open('doc88-workspace-v1', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('files');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  return database;
}
async function operation(mode, run) {
  const connection = await db();
  return new Promise((resolve, reject) => {
    const transaction = connection.transaction('files', mode);
    const request = run(transaction.objectStore('files'));
    transaction.oncomplete = () => resolve(request?.result);
    transaction.onabort = transaction.onerror = () =>
      reject(transaction.error || request?.error || Error('Не удалось сохранить данные браузера.'));
  });
}
async function readFile(name, encoding) {
  const value = await operation('readonly', (store) => store.get(name));
  if (value === undefined)
    throw Object.assign(Error('Файл не сохранён: ' + name), { code: 'ENOENT' });
  const bytes = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value);
  return encoding ? bytes.toString(encoding) : bytes;
}
async function writeFile(name, bytes) {
  const value = typeof bytes === 'string' ? bytes : new Uint8Array(bytes);
  await operation('readwrite', (store) => store.put(value, name));
}
async function copyFile(from, to) {
  await writeFile(to, await readFile(from));
}
async function rename(from, to) {
  const value = await readFile(from);
  await operation('readwrite', (store) => {
    store.put(new Uint8Array(value), to);
    return store.delete(from);
  });
}
async function keys() {
  return operation('readonly', (store) => store.getAllKeys());
}
module.exports = {
  readFile,
  writeFile,
  copyFile,
  rename,
  keys,
  mkdir: async () => {},
  access: async (name) => {
    await readFile(name);
  },
};
