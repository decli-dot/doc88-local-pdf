'use strict';
function dependency(name) {
  const value = { jszip: globalThis.JSZip, 'pdf-lib': globalThis.PDFLib }[name];
  if (!value) throw Error('Недоступна браузерная библиотека: ' + name);
  return value;
}
module.exports = { dependency, browserChannel: () => undefined };
