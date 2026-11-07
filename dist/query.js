'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Doc88Query = api;
})(globalThis, function () {
  function normalizeQuery(value) {
    const text = String(value).trim().replace(/\s+/g, ' ');
    const normalized = text.normalize('NFKC').replace(/[‐‑‒–—−]/g, '-');
    // Match the whole designation so free-text titles, national prefixes and
    // amendment numbers cannot silently lose meaningful parts of the query.
    const match = normalized.match(
      /^ISO\s*(?:\/\s*(IEC)\s*)?(\d{3,6})(?:\s*-\s*(\d{1,3})(?!\d))?(?:(?:\s*[:\-]\s*|\s+)((?:19|20)\d{2}))?$/i,
    );
    if (!match) return text;
    return `ISO${match[1] ? '/IEC' : ''} ${match[2]}${match[3] ? '-' + match[3] : ''}${match[4] ? ':' + match[4] : ''}`;
  }
  return { normalizeQuery };
});
