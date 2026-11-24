'use strict';
// The new catalogue/PDF integrations run in the local service. A static Pages
// build keeps its existing extension transport and never imports Node networking.
async function localOnly() {
  throw Error('Эта функция доступна в локальной версии DecliPDF.');
}
module.exports = {
  loadSharedCache: async () => null,
  saveSharedCache: async () => false,
  async processDocument(job, dataDirectory, options = {}) {
    const { downloadArchive, convertArchive } = require('./pipeline.js');
    await (options.download || downloadArchive)(job, dataDirectory, options.downloadOptions || {});
    await (options.convert || convertArchive)(job);
  },
  resolvePublisher: localOnly,
  previewCandidate: localOnly,
  downloadSourcePDF: localOnly,
  importPDF: localOnly,
  searchPDFSources: async () => [],
};
