'use strict';
const { createHash } = require('node:crypto');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function printedPage(text) {
  const lines = String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-8);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const rights = /all\s*rights?\s*reserved/i.exec(line);
    if (!rights) continue;
    const suffix = line.slice(rights.index + rights[0].length).replace(/^[\s.~,–—-]+/, '');
    const direct = suffix.match(/^(\d{1,4})[\s.]*$/) || line.match(/^(\d{1,4})\s+[©(]/);
    if (direct && Number(direct[1]) > 0) return Number(direct[1]);
    for (const nearby of lines.slice(Math.max(0, i - 1), i + 3)) {
      if (/^\d{1,4}$/.test(nearby) && Number(nearby) > 0) return Number(nearby);
    }
  }
  return null;
}
function inspectPages(texts, hashes = [], expectedPages = null) {
  const duplicates = [];
  const seen = new Map();
  const anchors = [];
  for (let i = 0; i < texts.length; i++) {
    const number = printedPage(texts[i]);
    if (number && (!expectedPages || number <= expectedPages))
      anchors.push({ page: i + 1, number, offset: i + 1 - number });
    // Identical blank sheets are legitimate. Only flag byte-identical images
    // with substantial recognized content, never repeated headers alone.
    if (hashes[i] && (texts[i].match(/\p{L}/gu)?.length || 0) >= 200) {
      if (seen.has(hashes[i])) duplicates.push([seen.get(hashes[i]), i + 1]);
      else seen.set(hashes[i], i + 1);
    }
  }
  const runs = [];
  for (const anchor of anchors) {
    const last = runs.at(-1);
    if (last?.offset === anchor.offset) last.anchors.push(anchor);
    else runs.push({ offset: anchor.offset, anchors: [anchor] });
  }
  const stable = runs.filter((run) => run.anchors.length >= 2);
  const breaks = [];
  for (let i = 1; i + 2 < anchors.length; i++) {
    const [a, b, c, d] = anchors.slice(i - 1, i + 3);
    if (
      b.page === a.page + 1 &&
      c.page === b.page + 1 &&
      d.page === c.page + 1 &&
      b.number === a.number + 2 &&
      c.number === a.number + 1 &&
      d.number === a.number + 3
    )
      breaks.push({ before: b, after: c });
  }
  for (let i = 0; i + 2 < anchors.length; i++) {
    const [a, b, c] = anchors.slice(i, i + 3);
    if (
      b.page === a.page + 1 &&
      c.page === b.page + 1 &&
      b.number === a.number - 1 &&
      c.number === b.number - 1
    )
      breaks.push({ before: a, after: c });
  }
  for (let i = 1; i < stable.length; i++) {
    if (stable[i].offset !== stable[i - 1].offset)
      breaks.push({ before: stable[i - 1].anchors.at(-1), after: stable[i].anchors[0] });
  }
  const consistent = anchors.length >= 3 && runs.length === 1;
  const coversRange =
    consistent &&
    (!expectedPages || (anchors[0].number === 1 && anchors.at(-1).number === expectedPages));
  const status = duplicates.length || breaks.length ? 'failed' : coversRange ? 'passed' : 'unknown';
  const messages = [];
  if (duplicates.length)
    messages.push(
      'Совпадающие изображения непустых страниц: ' +
        duplicates.map((pair) => pair.join(' и ')).join('; ') +
        '.',
    );
  if (breaks.length)
    messages.push(
      'Нарушение нумерации: ' +
        breaks
          .map(
            (pair) =>
              `между листами PDF ${pair.before.page} и ${pair.after.page} (печатные номера ${pair.before.number} → ${pair.after.number})`,
          )
          .join('; ') +
        '. Возможны пропуски, вставки или перестановка страниц.',
    );
  if (status === 'passed')
    messages.push(
      `Печатная нумерация согласована с порядком листов; проверено номеров: ${anchors.length}. Совпадающих непустых изображений не найдено.`,
    );
  if (status === 'unknown')
    messages.push(
      'Уверенно подтвердить нумерацию по OCR не удалось. Проверь порядок и полноту страниц вручную; совпадающих непустых изображений не найдено.',
    );
  return { status, anchors, duplicates, breaks, message: messages.join(' ') };
}
module.exports = { digest, printedPage, inspectPages };
