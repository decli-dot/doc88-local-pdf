'use strict';
const { dependency } = require('./runtime.cjs');
const clean = (text) =>
  String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
const { isContentsPage, headingFor, buildStructure } = require('./structure.cjs');
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
  const { PDFName, PDFHexString, PDFNumber, PDFNull } = dependency('pdf-lib');
  pdf.catalog.delete(PDFName.of('Outlines'));
  if (pdf.catalog.get(PDFName.of('PageMode'))?.toString() === '/UseOutlines')
    pdf.catalog.delete(PDFName.of('PageMode'));
  if (!structure.nodes.length) return;
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
            PDFNumber.of(
              Number.isFinite(node.top)
                ? page.getHeight() * (1 - Math.max(0, Math.min(1, node.top)))
                : page.getHeight(),
            ),
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
