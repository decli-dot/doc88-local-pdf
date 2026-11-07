'use strict';
const { dependency } = require('./runtime.cjs');
const clean = (text) =>
  String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
function isContentsPage(text) {
  return String(text)
    .split('\n')
    .slice(0, 16)
    .some((line) =>
      /^(?:Table\s+of\s+)?Contents(?:\s*(?:Page|\(continued\)))?\s*[.]?$/i.test(clean(line)),
    );
}
function headingFor(line) {
  line = clean(line)
    .replace(/[.·…]+\s*\d+\s*$/, '')
    .trim();
  if (!line || line.length > 160 || /\b(?:shall|should|https?|rights reserved)\b/i.test(line))
    return null;
  let match = line.match(/^(Annex|Appendix)\s+([A-Z])(?:\s+|$)(.*)$/i);
  if (
    match &&
    !/^(?:is|are|gives?|shows?|provides?|contains?|illustrates?|describes?|specifies?|see)\b|^\(see\b/i.test(
      match[3].trim(),
    )
  )
    return {
      key: 'annex:' + match[2].toUpperCase(),
      label: 'Annex ' + match[2].toUpperCase(),
      title: clean(match[3]),
      kind: 'annex',
    };
  if (/^Bibliography\s*[.]?$/i.test(line))
    return { key: 'bibliography', label: 'Bibliography', title: '', kind: 'bibliography' };
  if (/^(Foreword|Introduction)\s*[.]?$/i.test(line))
    return {
      key: line.replace(/[.]/g, '').toLowerCase(),
      label: line.replace(/[.]/g, ''),
      title: '',
      kind: 'preface',
    };
  match = line.match(/^((?:\d{1,2}|[A-Z])(?:\s*\.\s*\d{1,2}){0,5})\.?\s+([^\d\s].*)$/);
  if (
    !match ||
    /^[A-Z]$/.test(match[1]) ||
    /[.;]$/.test(match[2]) ||
    match[2].split(' ').length > 22
  )
    return null;
  const label = match[1].replace(/\s+/g, '');
  return {
    key: 'clause:' + label,
    label,
    title: match[2],
    kind: label.includes('.') ? 'subsection' : 'section',
  };
}
function buildStructure(texts) {
  const found = new Map();
  const tocText = texts.filter(isContentsPage).join('\n');
  const tocRoots = new Set(
    tocText
      .split('\n')
      .map(headingFor)
      .filter(Boolean)
      .filter((node) => node.kind === 'section')
      .map((node) => node.label),
  );
  for (let p = 0; p < texts.length; p++) {
    const lines = String(texts[p]).split('\n');
    // A contents page supplies names but OCR often loses its page-number column.
    // Use body headings for destinations rather than guessing from that list.
    if (isContentsPage(texts[p])) continue;
    for (let i = 0; i < lines.length; i++) {
      let line = clean(lines[i]);
      if (/^(?:\d+(?:\.\d+)*|[A-Z]\.\d+)\.?$/.test(line) && i + 1 < lines.length)
        line += ' ' + clean(lines[i + 1]);
      let heading = headingFor(line);
      if (!heading) continue;
      const root = heading.label.split('.')[0];
      if (
        tocRoots.size >= 2 &&
        ['section', 'subsection'].includes(heading.kind) &&
        !/^[A-Z]$/.test(root) &&
        !tocRoots.has(root) &&
        !tocText.toLowerCase().includes(heading.title.toLowerCase()) &&
        !/^(Scope|Normative references|Terms and definitions|Symbols|Abbreviations)\b/i.test(
          heading.title,
        )
      )
        continue;
      if (heading.kind === 'annex' && !heading.title) {
        const next = lines
          .slice(i + 1, i + 5)
          .map(clean)
          .filter(Boolean);
        heading.title = next
          .filter((value) => !/^\((?:informative|normative)\)$/i.test(value))
          .slice(0, 1)
          .join(' ');
      }
      if (!found.has(heading.key))
        found.set(heading.key, { ...heading, page: p + 1, line: i, children: [] });
    }
  }
  const flat = [...found.values()].slice(0, 600);
  const byKey = new Map(flat.map((node) => [node.key, node]));
  const roots = [];
  for (const node of flat) {
    let parent = null;
    if (node.kind === 'subsection') {
      const parts = node.label.split('.');
      while (parts.length > 1 && !parent) {
        parts.pop();
        parent = byKey.get(
          /^[A-Z]$/.test(parts.join('.'))
            ? 'annex:' + parts.join('.')
            : 'clause:' + parts.join('.'),
        );
      }
      if (parent && (parent.page > node.page || parent === node)) parent = null;
    }
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const strip = (node) => ({
    label: node.label,
    title: node.title,
    kind: node.kind,
    page: node.page,
    line: node.line,
    children: node.children.map(strip),
  });
  return {
    nodes: roots.map(strip),
    count: flat.length,
    source: 'ocr',
    message: flat.length
      ? 'Структура восстановлена по распознанным заголовкам. Проверь неоднозначные названия и переходы.'
      : 'Заголовки не удалось уверенно выделить из OCR.',
  };
}
function normativeReferences(texts) {
  let collecting = false,
    found = false,
    block = '';
  for (const text of texts) {
    const lines = String(text).split('\n');
    if (isContentsPage(text)) continue;
    for (let i = 0; i < lines.length; i++) {
      const line = clean(lines[i]);
      if (
        /rights?\s*reserved/i.test(line) ||
        /^(?:INTERNATIONAL STANDARD\s+)?ISO.*\([EF]\)\s*$/i.test(line)
      )
        continue;
      if (/^(?:\d+\s+)?Normative references\s*[.]?$/i.test(line)) {
        collecting = true;
        found = true;
        continue;
      }
      if (collecting && /^\d{1,2}$/.test(line)) {
        const next = lines
          .slice(i + 1)
          .map(clean)
          .find(Boolean);
        if (next && !/^(?:ISO|IEC|©|\d)/i.test(next) && headingFor(line + ' ' + next)) {
          collecting = false;
          continue;
        }
      }
      if (collecting && /^\d{1,2}\s+[A-Za-z]/.test(line) && !/^(?:19|20)\d{2}\b/.test(line)) {
        collecting = false;
        continue;
      }
      if (collecting) block += line + '\n';
    }
  }
  const entries = new Map();
  const pattern =
    /\b(ISO(?:\s*\/\s*(?:IEC|TS|TR))?|IEC|ASTM|EN(?:\s+ISO)?)\s*(\d{2,6})(?:\s*[-‐‑–—]\s*(\d{1,3})(?!\d))?(?:(?:\s*[:\-]\s*)((?:19|20)\d{2})(?!\d))?(?:\s*\/\s*(Amd|Cor)\.?\s*(\d+)\s*:\s*((?:19|20)\d{2}))?/gi;
  for (const match of block.matchAll(pattern)) {
    const organization = match[1].toUpperCase().replace(/\s*\/\s*/g, '/');
    const query =
      organization +
      ' ' +
      match[2] +
      (match[3] ? '-' + match[3] : '') +
      (match[4] ? ':' + match[4] : '') +
      (match[5]
        ? '/' + (match[5].toLowerCase() === 'amd' ? 'Amd' : 'Cor') + ' ' + match[6] + ':' + match[7]
        : '');
    const following = block.slice(
      match.index + match[0].length,
      match.index + match[0].length + 40,
    );
    const series = /^\s*\(all parts\)/i.test(following);
    const incomplete = /^\s*[-:]/.test(following);
    if (!entries.has(query))
      entries.set(query, {
        query,
        label: query + (series ? ' (all parts)' : ''),
        searchable: !series && !incomplete,
        series,
        incomplete,
      });
  }
  return {
    status: found ? 'found' : 'unconfirmed',
    items: [...entries.values()].slice(0, 100),
    message: !found
      ? 'Раздел нормативных ссылок не распознан.'
      : entries.size
        ? 'Ссылки извлечены только из раздела Normative references; обозначения могут содержать ошибки OCR.'
        : 'В разделе нормативных ссылок обозначения стандартов не найдены.',
  };
}
function addPDFStructure(pdf, structure) {
  if (!structure.nodes.length) return;
  const { PDFName, PDFHexString, PDFNumber, PDFNull } = dependency('pdf-lib');
  const context = pdf.context;
  const root = context.obj({ Type: 'Outlines' }),
    rootRef = context.register(root);
  const count = (nodes) => nodes.reduce((total, node) => total + 1 + count(node.children), 0);
  const build = (nodes, parent) => {
    const items = nodes
      .filter((node) => node.page >= 1 && node.page <= pdf.getPageCount())
      .map((node) => {
        const page = pdf.getPage(node.page - 1);
        const item = context.obj({
          Title: PDFHexString.fromText(node.label + (node.title ? ' ' + node.title : '')),
          Parent: parent,
          Dest: context.obj([
            page.ref,
            PDFName.of('XYZ'),
            PDFNull,
            PDFNumber.of(page.getHeight()),
            PDFNull,
          ]),
        });
        return { node, item, ref: context.register(item) };
      });
    items.forEach((entry, i) => {
      if (i) entry.item.set(PDFName.of('Prev'), items[i - 1].ref);
      if (i + 1 < items.length) entry.item.set(PDFName.of('Next'), items[i + 1].ref);
      if (entry.node.children.length) {
        const children = build(entry.node.children, entry.ref);
        if (children.length) {
          entry.item.set(PDFName.of('First'), children[0].ref);
          entry.item.set(PDFName.of('Last'), children.at(-1).ref);
          entry.item.set(PDFName.of('Count'), PDFNumber.of(-count(entry.node.children)));
        }
      }
    });
    return items;
  };
  const items = build(structure.nodes, rootRef);
  if (!items.length) return;
  root.set(PDFName.of('First'), items[0].ref);
  root.set(PDFName.of('Last'), items.at(-1).ref);
  root.set(PDFName.of('Count'), PDFNumber.of(items.length));
  pdf.catalog.set(PDFName.of('Outlines'), rootRef);
  pdf.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));
}
module.exports = { headingFor, buildStructure, normativeReferences, addPDFStructure };
