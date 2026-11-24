'use strict';
const { providersFor, validatePolicy } = require('./source-policy.cjs');
const { searchDocumentPages } = require('./search.cjs');
const { failureKind } = require('./dist/job-feedback.js');

function createSourceSearch(
  job,
  dataDirectory,
  {
    downloadOptions = {},
    resume = false,
    chooseEdition = false,
    candidates,
    doc88Pages = searchDocumentPages,
    annaPages = require('./experimental/anna-search.cjs').searchAnnaPages,
    createBrowser = require('./experimental/anna-browser.cjs').createAnnaBrowser,
    downloadAnna = require('./experimental/anna-source.cjs').downloadAnnaPDF,
    checkScripts = require('./experimental/anna-source.cjs').verifyScripts,
    importPDF = require('./pdf-input.cjs').importPDF,
  } = {},
) {
  const policy = validatePolicy(
    job.sourcePolicy ||
      (job.kind === 'anna' || job.searchProvider === 'anna' ? 'anna-only' : undefined),
  );
  const providers = providersFor(policy),
    attempts = [],
    failures = [];
  let browser, iterator;
  const fetcher = require('./doc88-network.cjs').createDoc88Fetcher({
    onRetry: (info) =>
      job.log(`Doc88: повтор соединения ${info.attempt}; ${info.code}; пауза ${info.delayMs} мс`),
  });
  const publish = (activeSource) =>
    job.update({ sourcePolicy: policy, activeSource, sourceAttempts: attempts });
  const sourceOptions = {
    ...downloadOptions,
    launchContext: () => {
      browser ||= createBrowser(dataDirectory, job.controller.signal);
      return browser.lease();
    },
  };
  async function* discoverSources(query, signal, log, options) {
    for (const provider of providers) {
      signal.throwIfAborted();
      const attempt = { provider, status: 'searching', candidates: 0 };
      attempts.push(attempt);
      publish(provider);
      const onPhase = (phase) => {
        attempt.phase = phase;
        publish(provider);
        options.onPhase?.(phase);
      };
      try {
        const pages =
          provider === 'doc88'
            ? doc88Pages(query, signal, log, { ...options, fetcher, onPhase })
            : annaPages(job, dataDirectory, query, { ...sourceOptions, ...options, onPhase });
        for await (const batch of pages) {
          signal.throwIfAborted();
          attempt.candidates += batch.length;
          publish(provider);
          if (batch.length) yield batch;
        }
        attempt.status = 'exhausted';
      } catch (error) {
        signal.throwIfAborted();
        attempt.status = 'error';
        attempt.errorCode = error.code || null;
        attempt.message = error.message;
        if (error.networkCode) attempt.networkCode = error.networkCode;
        failures.push(error);
        log(`${provider}: ${error.message}`);
      } finally {
        if (attempt.status === 'searching')
          attempt.status = job.controller.signal.aborted
            ? 'cancelled'
            : job.stage === 'done'
              ? 'passed'
              : 'interrupted';
        publish(provider);
      }
    }
    if (failures.length) {
      const access = failures.some((error) => failureKind(error) === 'access');
      throw Object.assign(
        Error(
          access
            ? 'Часть источников временно недоступна или требует подтверждения доступа. Можно повторить поиск.'
            : 'Не удалось завершить проверку всех источников. Можно повторить поиск.',
        ),
        {
          code: access ? 'SOURCE_ACCESS_PENDING' : 'SEARCH_INCOMPLETE',
        },
      );
    }
  }
  return {
    options: {
      downloadOptions,
      resume,
      chooseEdition,
      freshDiscovery: true,
      sourceProviders: providers,
      experimentalAnna: providers.includes('anna'),
      // Anna-first/Anna-only starts discovery with the selected provider.
      // Explicit access to a verified PDF remains available in the dev cache.
      _cacheAttempted: providers[0] !== 'doc88',
      ...(candidates
        ? { candidates }
        : job.annaCardURL
          ? {
              candidates: [
                {
                  provider: 'anna',
                  url: job.annaCardURL,
                  title: 'PDF из выбранной карточки',
                  format: 'PDF',
                  pageCount: null,
                  status: 'unverified',
                },
              ],
            }
          : {}),
      discover(query, signal, log, options) {
        iterator = discoverSources(query, signal, log, options);
        return iterator;
      },
      downloadPDF: (child) =>
        downloadAnna(child, dataDirectory, { ...sourceOptions, slowURL: job.annaSlowURL }),
      importPDF: async (child) => {
        await checkScripts(child);
        await importPDF(child);
      },
    },
    async close() {
      try {
        await iterator?.return();
      } finally {
        await browser?.close();
        publish(null);
      }
    },
  };
}
module.exports = { createSourceSearch };
