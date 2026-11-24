'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { atomicWrite } = require('./checkpoints.cjs');
const queues = new Map();
function reviewKey(job) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        job.resolvedQuery || job.query || job.title,
        job.documentLanguage || job.ocrLanguage,
        job.url,
      ]),
    )
    .digest('hex');
}
async function readReviews(data) {
  try {
    return JSON.parse(await fs.readFile(path.join(data, 'document-reviews.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { version: 1, records: {}, events: [] };
  }
}
async function reviewFor(job, data) {
  return (await readReviews(data)).records[reviewKey(job)] || null;
}
async function rejectedSources(job, data) {
  const reference = job.resolvedQuery || job.query;
  return new Set(
    Object.values((await readReviews(data)).records)
      .filter(
        (r) =>
          r.rating === 'bad' && r.reference === reference && r.language === job.documentLanguage,
      )
      .map((r) => r.url),
  );
}
async function saveReview(job, input, data) {
  if (
    !['good', 'bad', null].includes(input.rating) ||
    typeof input.comment !== 'string' ||
    input.comment.length > 4000
  )
    throw Error('Выберите оценку и напишите комментарий не длиннее 4000 символов.');
  const record = {
    key: reviewKey(job),
    jobId: job.id,
    reference: job.resolvedQuery || job.query || job.title,
    language: job.documentLanguage || job.ocrLanguage,
    url: job.url,
    rating: input.rating,
    comment: input.comment.trim(),
    at: new Date().toISOString(),
  };
  const operation = (queues.get(data) || Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const log = await readReviews(data);
      log.records[record.key] = record;
      log.events.push(record);
      await fs.mkdir(data, { recursive: true });
      await atomicWrite(path.join(data, 'document-reviews.json'), JSON.stringify(log, null, 2));
      return record;
    });
  queues.set(data, operation);
  return operation;
}
function publicReview(record) {
  return record ? { rating: record.rating, comment: record.comment, at: record.at } : null;
}
module.exports = { reviewKey, readReviews, reviewFor, rejectedSources, saveReview, publicReview };
