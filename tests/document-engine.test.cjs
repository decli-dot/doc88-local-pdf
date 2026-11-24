'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateMode, requestedMode, processDocument } = require('../document-engine.cjs');
const { publicJob } = require('../dev-access.cjs');
const { identityCheck } = require('../search.cjs');
function fixture(mode = 'auto') {
  return {
    processingMode: mode,
    fromPage: 1,
    toPage: null,
    controller: new AbortController(),
    update(value) {
      Object.assign(this, value);
    },
    log() {},
  };
}
test('automatic processing keeps successful direct output and does not run OCR', async () => {
  const job = fixture();
  let ocr = 0;
  await processDocument(job, '.', {
    direct: async (child) => child.update({ pdfReady: true, total: 83 }),
    download: async () => {
      ocr++;
    },
    convert: async () => {
      ocr++;
    },
  });
  assert.equal(job.pdfReady, true);
  assert.equal(job.total, 83);
  assert.equal(job.processingEngine, 'direct');
  assert.equal(ocr, 0);
  assert.doesNotMatch(
    JSON.stringify(publicJob(job)),
    /processingEngine|processingMode|processingMs/,
  );
});
test('technical failures fall back once, clear direct verification, and retain the reason privately', async () => {
  const job = fixture();
  const calls = [];
  await processDocument(job, '.', {
    direct: async (child) => {
      child.update({ identityVerification: { status: 'passed' }, pdfReady: true });
      calls.push('direct');
      throw Object.assign(Error('No usable text'), { code: 'DIRECT_TEXT_UNUSABLE' });
    },
    download: async (child) => {
      calls.push('download');
      assert.equal(child.pdfReady, false);
      assert.equal(child.identityVerification, null);
    },
    convert: async (child) => {
      calls.push('ocr');
      child.update({ pdfReady: true });
    },
  });
  assert.deepEqual(calls, ['direct', 'download', 'ocr']);
  assert.equal(job.processingEngine, 'ocr');
  assert.equal(job.engineFallback.code, 'DIRECT_TEXT_UNUSABLE');
});
test('foreign language, wrong edition, incomplete content and cancellation cannot switch engines to bypass rejection', async () => {
  for (const code of [
    'FOREIGN_SCRIPT',
    'FOREIGN_LANGUAGE',
    'DOCUMENT_MISMATCH',
    'INCOMPLETE_DOCUMENT',
  ]) {
    const job = fixture();
    let legacy = 0;
    await assert.rejects(
      processDocument(job, '.', {
        direct: async () => {
          throw Object.assign(Error(code), { code });
        },
        download: async () => legacy++,
      }),
      (e) => e.code === code,
    );
    assert.equal(legacy, 0);
    assert.equal(job.pdfReady, false);
  }
  const job = fixture();
  let legacy = 0;
  await assert.rejects(
    processDocument(job, '.', {
      direct: async () => {
        job.controller.abort();
        throw Error('Stop');
      },
      download: async () => legacy++,
    }),
  );
  assert.equal(legacy, 0);
});
test('forced modes, page ranges and server authorization obey explicit choices', async () => {
  assert.equal(validateMode(), 'auto');
  assert.equal(requestedMode('auto', false), 'auto');
  assert.throws(
    () => requestedMode('direct', false),
    (e) => e.status === 403,
  );
  assert.throws(
    () => requestedMode('ocr', false),
    (e) => e.status === 403,
  );
  assert.equal(requestedMode('direct', true), 'direct');
  assert.throws(
    () => validateMode('anything'),
    (e) => e.status === 400,
  );
  const direct = fixture('direct');
  let ocr = 0;
  await assert.rejects(
    processDocument(direct, '.', {
      direct: async () => {
        throw Error('Unavailable');
      },
      download: async () => ocr++,
    }),
    /Unavailable/,
  );
  assert.equal(ocr, 0);
  const job = fixture('ocr');
  let directCalls = 0;
  await processDocument(job, '.', {
    direct: async () => directCalls++,
    download: async () => {},
    convert: async (j) => j.update({ pdfReady: true }),
  });
  assert.equal(directCalls, 0);
  assert.equal(job.processingEngine, 'ocr');
  const partial = fixture();
  partial.toPage = 2;
  await processDocument(partial, '.', {
    direct: async () => directCalls++,
    download: async () => {},
    convert: async (j) => j.update({ pdfReady: true }),
  });
  assert.equal(directCalls, 0);
  assert.equal(partial.processingEngine, 'ocr');
});
test('edition evidence accepts spaced source glyphs and ignores replacement history without erasing contradictory covers', () => {
  assert.equal(
    identityCheck('DIN EN ISO 129-1:2022-02', [
      'GERMAN STANDARD February 2022\nDIN EN ISO 1 29-1\nReplacement for\nDIN EN ISO 129-1:2020-02',
      'DIN EN ISO 1 29-1:2022-02\nNational Foreword',
    ]).status,
    'passed',
  );
  assert.equal(
    identityCheck('DIN EN ISO 129-1:2022-02', [
      'DIN EN ISO 129-1:2020-02\nReplacement for DIN EN ISO 129-1:2019-01',
      'DIN EN ISO 129-1:2022-02',
    ]).status,
    'failed',
    'a contradictory actual cover cannot be repaired by a later reference',
  );
  assert.equal(
    identityCheck('ASME Y14.3-2012 (R2024)', [
      'ASME Y1 4.3-201 2\nREAFFIRMED 2024\n[Revision of ASME Y14.3-2003 (R2008)]',
    ]).status,
    'passed',
  );
  assert.equal(
    identityCheck('DIN 276:2018-12', [
      'DIN 276\nDezember 2018\nErsatz für DIN 276:2008-12',
      'National foreword',
      'DIN 276:1934-08',
    ]).status,
    'passed',
  );
  assert.equal(
    identityCheck('ASME Y14.3-2012', ['ASME Y1 4.3-200 3\nRevised from ASME Y14.3-2012']).status,
    'failed',
  );
  assert.equal(
    identityCheck('DIN 276:2018-12', [
      'DIN 276\nErsatz für DIN 277-3:2005-04',
      '',
      'DIN 276:1934-08',
    ]).status,
    'unknown',
  );
});
