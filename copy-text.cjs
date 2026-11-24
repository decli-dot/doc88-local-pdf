'use strict';
// Never rewrite the source scan or the OCR used for edition/page verification.
// Joining a hyphenated word requires independent evidence in the document or
// a small terminology list; numbers and actual compound words stay intact.
const terminology = new Set(
  'specification specifications geometrical geometric measurement measurements manufacturing verification requirements requirement tolerancing toleranced dimensioning uncertainty uncertainties characteristic characteristics reference references introduction international normative definition definitions independently equipment inspection information geometrische produktspezifikationen anforderungen messverfahren измерение измерения измерений требования технический технические геометрические спецификация спецификации'.split(
    ' ',
  ),
);
function cleanText(text, vocabulary = new Set()) {
  const lines = String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00ad/g, '')
    .split('\n');
  const isBoundary = (line) =>
    !line.trim() ||
    /^(?:\d+(?:\.\d+)*\s|[A-Z]\.\d+\s|Annex\b|Bibliography\b|[•—–]\s|[-*]\s|[a-z]\)\s)/i.test(
      line,
    ) ||
    /\t|\S {3,}\S/.test(line);
  let result = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/[ \t]+$/, '');
    if (!line.trim()) {
      result = result.trimEnd() + '\n\n';
      continue;
    }
    if (result && !result.endsWith('\n') && !isBoundary(line) && !isBoundary(lines[i - 1] || '')) {
      const left = result.match(/([\p{L}]+)-$/u),
        right = line.match(/^\s*([\p{Ll}]+)/u);
      if (
        left &&
        right &&
        (vocabulary.has((left[1] + right[1]).toLowerCase()) ||
          terminology.has((left[1] + right[1]).toLowerCase()))
      ) {
        result = result.slice(0, -1) + line.trimStart();
      } else result += result.endsWith('-') && right ? line.trimStart() : ' ' + line.trimStart();
    } else result += (result && !result.endsWith('\n') ? '\n' : '') + line;
  }
  return result.trim();
}
function documentText(pages) {
  const vocabulary = new Set(
    pages
      .join('\n')
      .toLowerCase()
      .match(/\p{L}{4,}/gu) || [],
  );
  return pages.map((text) => cleanText(text, vocabulary)).join('\n\n\f\n\n');
}
function textFromItems(items, pageWidth = 600) {
  // PDF content streams normally preserve block order. Detect clear two-column
  // prose, but keep short cells in tables on one row with tab-separated columns.
  const words = items
    .filter((item) => typeof item.str === 'string' && item.str.trim())
    .map((item, index) => ({
      text: item.str,
      x: item.transform[4],
      y: item.transform[5],
      width: item.width || 0,
      height: Math.abs(item.height || item.transform[3]) || 10,
      index,
    }));
  const rows = [];
  for (const item of [...words].sort((a, b) => b.y - a.y || a.x - b.x)) {
    let row = rows.find((row) => Math.abs(row.y - item.y) <= Math.max(2, item.height * 0.3));
    if (!row) {
      row = { y: item.y, words: [] };
      rows.push(row);
    }
    row.words.push(item);
  }
  const split = pageWidth * 0.5;
  const proseRows = rows.filter(
    (row) =>
      row.words.some((word) => word.x < split && word.text.length >= 30) &&
      row.words.some((word) => word.x >= split && word.text.length >= 30) &&
      !row.words.some((word) => word.x < split - 15 && word.x + word.width > split + 15),
  );
  const columns =
    proseRows.length >= 5
      ? [words.filter((word) => word.x < split), words.filter((word) => word.x >= split)]
      : [words];
  return columns
    .map((column) => {
      const selected = new Set(column);
      return rows
        .map((row) => row.words.filter((word) => selected.has(word)).sort((a, b) => a.x - b.x))
        .filter((row) => row.length)
        .map((row) =>
          row
            .map(
              (word, index) =>
                (index && word.x - (row[index - 1].x + row[index - 1].width) > word.height * 2
                  ? '\t'
                  : index
                    ? ' '
                    : '') + word.text,
            )
            .join(''),
        )
        .join('\n');
    })
    .join('\n\n');
}
module.exports = { cleanText, documentText, textFromItems };
