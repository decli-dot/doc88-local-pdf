'use strict';
const { normalizeQuery } = require('./dist/query.js');
const standards = require('./dist/standard-reference.js');
const iso = require('./iso-catalog.cjs');
const { reviewKey, publicReview } = require('./document-review.cjs');
function cacheList(jobs, reviews, verified = require('./shared-cache.cjs').verified) {
  const unique = new Map();
  for (const job of [...jobs].reverse()) {
    if (job.stage !== 'done' || !job.pdfReady) continue;
    const raw =
      job.resolvedQuery ||
      job.catalogueEdition?.reference ||
      job.isoEdition?.reference ||
      job.query;
    if (!raw) continue;
    const normalized = normalizeQuery(raw);
    const national = standards.parse(normalized),
      international = iso.reference(normalized);
    const reference = national
      ? standards.format(national)
      : international && iso.internationalISOName(normalized)
        ? iso.formatReference(international)
        : normalized;
    const language = (
      job.documentLanguage ||
      job.ocrLanguage ||
      ((international && iso.internationalISOName(normalized)) ||
      ['ASME', 'BS'].includes(national?.publisher)
        ? 'eng'
        : '')
    )
      .split('+')
      .sort()
      .join('+');
    const review = reviews[reviewKey(job)];
    const reusable = verified(job) && review?.rating !== 'bad';
    const item = {
      id: job.id,
      reference,
      title: job.title,
      language,
      pages: job.total,
      bytes: job.bytes,
      reusable,
      review: publicReview(review),
      createdAt: job.createdAt,
    };
    const key = reference.toUpperCase() + '\0' + language;
    const score =
      (reusable ? 10 : 0) + (review?.rating === 'good' ? 2 : review?.rating === 'bad' ? 1 : 0);
    const previous = unique.get(key);
    if (
      !previous ||
      score > previous.score ||
      (score === previous.score && Date.parse(item.createdAt) > Date.parse(previous.item.createdAt))
    )
      unique.set(key, { item, score });
  }
  return [...unique.values()]
    .map((value) => value.item)
    .sort(
      (a, b) =>
        a.reference.localeCompare(b.reference, 'en', { numeric: true }) ||
        a.language.localeCompare(b.language),
    );
}
module.exports = { cacheList };
