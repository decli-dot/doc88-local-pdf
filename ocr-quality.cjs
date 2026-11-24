'use strict';
function confidenceFromTSV(text) {
  let sum = 0,
    weight = 0;
  for (const line of String(text).split(/\r?\n/).slice(1)) {
    const cells = line.split('\t'),
      confidence = Number(cells[10]),
      word = cells.slice(11).join('\t').trim();
    if (
      cells[0] !== '5' ||
      !cells[10]?.trim() ||
      !word ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 100
    )
      continue;
    sum += confidence * word.length;
    weight += word.length;
  }
  return weight ? sum / weight : null;
}
function summarizeOCR(pages) {
  return {
    version: 1,
    pages,
    uncertainPages: pages
      .filter(
        (item) =>
          Number.isFinite(item.confidence) &&
          item.confidence < 65 &&
          item.words >= 8 &&
          item.letters >= 40,
      )
      .map((item) => item.page),
  };
}
function qualityPage(page, text, confidence) {
  return {
    page,
    confidence: Number.isFinite(confidence) ? confidence : null,
    words: (String(text).match(/\p{L}{2,}/gu) || []).length,
    letters: (String(text).match(/\p{L}/gu) || []).length,
  };
}
function mergeOCRQuality(existing, pages) {
  const byPage = new Map((existing?.pages || []).map((item) => [item.page, item]));
  for (const item of pages) byPage.set(item.page, item);
  return summarizeOCR([...byPage.values()].sort((a, b) => a.page - b.page));
}
module.exports = { confidenceFromTSV, summarizeOCR, qualityPage, mergeOCRQuality };
