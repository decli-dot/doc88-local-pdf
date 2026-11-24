(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DecliStandards = factory();
})(globalThis, function () {
  'use strict';
  const national =
    '(DIN|BS|NF|EN)\\s*((?:EN\\s+)?(?:ISO(?:\\s*\\/\\s*IEC)?\\s+|IEC\\s+)?|SPEC\\s+|EN\\s+)';
  const number = '([A-Z]{0,2}\\d{1,6}(?:[-.]\\d{1,3}(?!\\d))*)';
  const date =
    '(?:\\s*[: -]\\s*((?:19|20)\\d{2}(?!\\d))(?:-(0[1-9]|1[0-2]))?(?:-(0[1-9]|[12]\\d|3[01]))?)?';
  const amendment = '(?:\\s*\\+\\s*(A\\d+|AC)\\s*:\\s*((?:19|20)\\d{2}(?!\\d)))?';
  function parse(value) {
    const text = String(value || '')
      .normalize('NFKC')
      .toUpperCase()
      .replace(/[‐‑–—−]/g, '-')
      .replace(/\s+/g, ' ')
      .trim();
    let match = text.match(new RegExp('^' + national + number + date + amendment + '$'));
    if (match)
      return {
        publisher: match[1],
        prefix: (match[1] + ' ' + match[2]).replace(/\s*\/\s*/g, '/').trim(),
        number: match[3],
        year: match[4] || null,
        month: match[5] || null,
        day: match[6] || null,
        ...(match[7] ? { amendment: { number: match[7], year: match[8] } } : {}),
      };
    match = text.match(
      /^ASME[\s_-]*([A-Z]{1,6}\d+(?:[.-]\d{1,3}(?!\d)[A-Z]?)*[A-Z]?|BPVC[. ]+[IVX]+(?:[. ]+\d+)?)(?:\s*[: -]\s*((?:19|20)\d{2}(?!\d)))?(?:\s*\(R\s*((?:19|20)\d{2}(?!\d))\))?$/,
    );
    return match
      ? {
          publisher: 'ASME',
          prefix: 'ASME',
          number: match[1].replace(/ /g, '.'),
          year: match[2] || null,
          reaffirmed: match[3] || null,
        }
      : null;
  }
  function format(v) {
    return `${v.prefix} ${v.number}${v.year ? (v.publisher === 'ASME' ? '-' : ':') + v.year : ''}${v.month ? '-' + v.month : ''}${v.day ? '-' + v.day : ''}${v.amendment ? '+' + v.amendment.number + ':' + v.amendment.year : ''}${v.reaffirmed ? ' (R' + v.reaffirmed + ')' : ''}`;
  }
  function same(w, f) {
    return Boolean(
      w &&
      f &&
      w.publisher === f.publisher &&
      w.prefix === f.prefix &&
      w.number === f.number &&
      (!w.year || w.year === f.year) &&
      (!w.month || w.month === f.month) &&
      (!w.day || w.day === f.day) &&
      (!w.reaffirmed || w.reaffirmed === f.reaffirmed) &&
      (!w.amendment ||
        (f.amendment &&
          w.amendment.number === f.amendment.number &&
          w.amendment.year === f.amendment.year)),
    );
  }
  function family(w, f) {
    if (!w || !f || w.publisher !== f.publisher || w.number !== f.number) return false;
    if (w.prefix === w.publisher)
      return [
        w.publisher,
        w.publisher + ' EN',
        w.publisher + ' ISO',
        w.publisher + ' EN ISO',
        w.publisher + ' EN ISO/IEC',
        w.publisher + ' IEC',
      ].includes(f.prefix);
    if (w.prefix === w.publisher + ' EN')
      return f.prefix === w.prefix || f.prefix === w.prefix + ' ISO';
    return w.prefix === f.prefix;
  }
  function references(text, publisher) {
    const wanted = { publisher };
    const source = String(text)
      .normalize('NFKC')
      .replace(/[‐‑–—−]/g, '-');
    const pattern =
      wanted.publisher === 'ASME'
        ? /\bASME[\s_-]*(?:[A-Z]{1,6}\d+(?:[.-]\d{1,3}(?!\d)[A-Z]?)*[A-Z]?|BPVC[. ]+[IVX]+(?:[. ]+\d+)?)(?:\s*[: -]\s*(?:19|20)\d{2}(?!\d))?(?:\s*\(R\s*(?:19|20)\d{2}(?!\d)\))?/gi
        : new RegExp('\\b' + national + number + date + amendment, 'gi');
    return (source.match(pattern) || []).map(parse).filter(Boolean);
  }
  function catalogueFamily(wanted, found) {
    return (
      family(wanted, found) ||
      Boolean(
        wanted &&
        found &&
        ['DIN', 'BS', 'NF'].includes(wanted.publisher) &&
        !wanted.year &&
        !wanted.number.includes('-') &&
        found.number.startsWith(wanted.number + '-') &&
        family({ ...wanted, number: found.number }, found),
      )
    );
  }
  function inText(text, wanted) {
    return references(text, wanted.publisher).some((found) => same(wanted, found));
  }
  return { parse, format, same, family, catalogueFamily, inText, references };
});
