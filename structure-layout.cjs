'use strict';
const median = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] || 10;
};
// Geometry is used only for navigation. The page contents and verification OCR
// remain untouched, including character codes in the source PDF.
function layoutLines(items, width, height, styles = {}) {
  const rows = [];
  const words = items
    .filter(
      (item) =>
        typeof item.str === 'string' &&
        item.str.trim() &&
        item.transform &&
        Math.abs(item.transform[1]) < 0.1 &&
        Math.abs(item.transform[2]) < 0.1,
    )
    .map((item) => ({
      text: item.str,
      x: item.transform[4],
      y: item.transform[5],
      width: Math.abs(item.width || 0),
      height: Math.abs(item.height || item.transform[3]) || 10,
      font: item.fontName || '',
      bold: /bold|black|demi/i.test(
        (styles[item.fontName]?.fontFamily || '') + ' ' + item.fontName,
      ),
    }));
  for (const word of words.sort((a, b) => b.y - a.y || a.x - b.x)) {
    let row = rows
      .slice(-5)
      .find(
        (row) => Math.abs(row.y - word.y) < Math.max(1, Math.min(row.height, word.height) * 0.23),
      );
    if (!row) {
      row = { y: word.y, height: word.height, words: [] };
      rows.push(row);
    }
    row.words.push(word);
  }
  const lines = [];
  for (const row of rows) {
    const groups = [];
    let group = [];
    for (const word of row.words.sort((a, b) => a.x - b.x)) {
      const previous = group.at(-1),
        gap = previous ? word.x - previous.x - previous.width : 0;
      if (previous && gap > Math.max(word.height * 1.7, width * 0.023)) {
        groups.push(group);
        group = [];
      }
      group.push(word);
    }
    if (group.length) groups.push(group);
    for (const group of groups) {
      let text = '';
      for (const [i, word] of group.entries()) {
        const previous = group[i - 1],
          gap = previous ? word.x - previous.x - previous.width : 0;
        const space =
          previous &&
          !/\s$/.test(text) &&
          !/^\s/.test(word.text) &&
          gap >= Math.min(word.height, previous.height) * 0.18;
        text += (space ? ' ' : '') + word.text;
      }
      const letters = text.match(/\p{L}/gu)?.length || 0;
      lines.push({
        text: text.replace(/\s+/g, ' ').trim(),
        x: group[0].x,
        top: height - row.y - median(group.map((w) => w.height)),
        baseline: height - row.y,
        height: median(group.map((w) => w.height)),
        width: Math.max(...group.map((w) => w.x + w.width)) - group[0].x,
        font: group[0].font,
        bold: group.filter((w) => w.bold).length > group.length / 2,
        parts: groups.length,
        letters,
        row: rows.indexOf(row),
      });
    }
  }
  const middle = width / 2;
  const paired = rows.filter(
    (row, index) =>
      lines.some(
        (line) =>
          line.row === index &&
          line.x < middle &&
          line.x + line.width < middle + 8 &&
          line.letters >= 20,
      ) && lines.some((line) => line.row === index && line.x >= middle && line.letters >= 20),
  ).length;
  const leftLong = lines.filter(
    (line) => line.x < middle && line.x + line.width < middle + 8 && line.letters >= 20,
  ).length;
  const rightLong = lines.filter((line) => line.x >= middle - 8 && line.letters >= 20).length;
  const spanning = lines.filter(
    (line) => line.x < middle - 20 && line.x + line.width > middle + 20 && line.letters >= 20,
  ).length;
  const twoColumns =
    paired >= 4 ||
    (Math.min(leftLong, rightLong) >= 2 && Math.max(leftLong, rightLong) >= 4 && spanning < 3);
  for (const line of lines)
    line.column = twoColumns
      ? line.x + line.width <= middle + 8
        ? 0
        : line.x >= middle - 8
          ? 1
          : -1
      : 0;
  // Keep full-width headings before the columns. Footer filtering happens later.
  const band = (line) => (line.column === -1 ? (line.top < height * 0.3 ? -1 : 2) : line.column);
  lines.sort(
    (a, b) => (twoColumns ? band(a) - band(b) : 0) || a.baseline - b.baseline || a.x - b.x,
  );
  return {
    width,
    height,
    bodyHeight: median(
      lines
        .filter((line) => line.letters > 30 && line.top > height * 0.1 && line.top < height * 0.88)
        .map((line) => line.height),
    ),
    columns: twoColumns ? 2 : 1,
    lines,
  };
}
module.exports = { layoutLines };
