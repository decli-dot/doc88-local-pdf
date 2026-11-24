'use strict';
const clean = (text) =>
  String(text || '')
    .replace(/\u00ad/g, '')
    .replace(/\s+/g, ' ')
    .trim();
const contentsTitle =
  /^(?:(?:Table\s+of\s+)?Contents|Inhalt(?:sverzeichnis)?|Sommaire|Table des matières)(?:\s*(?:Page|\(continued\)|\(suite\)))?\s*[.]?$/i;
const boilerplate =
  /copyright|rights? reserved|provided by|not for resale|no reproduction|license[ds]?|licence|©|reproduction interdite|alle rechte vorbehalten|nachdruck/i;
const specialTitles =
  /^(?:Scope|General|Normative references|Terms and definitions|Symbols|Abbreviations|Requirements|Definitions|Application|Anwendungsbereich|Allgemeines|Normative Verweisungen|Begriffe|Domaine d.application|Généralités|Références normatives|Termes et définitions)$/i;
const signature = (text) => clean(text).toLowerCase().replace(/\d+/g, '#');
const titleKey = (text) =>
  clean(text)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
function isContentsPage(text) {
  const lines = String(text).split('\n');
  return (
    lines.slice(0, 20).some((line) => contentsTitle.test(clean(line))) ||
    lines.filter((line) => /(?:\.\s*){4,}\s*(?:\d[\d ]*|[ivxlcdm]+)?\s*$/i.test(line)).length >= 5
  );
}
function headingFor(input) {
  let line = clean(input).split(/\t/)[0];
  line = line.replace(/(?:\s*[.·…]){3,}.*$/, '').trim();
  if (!line || line.length > 190 || boilerplate.test(line) || /[`|]{2}|https?:/i.test(line))
    return null;
  let match = line.match(/^(Annex|Appendix|Anhang|Annexe)\s+([A-Z])(?:\s+|$)(.*)$/i);
  if (match) {
    if (
      /^(?:is|are|gives?|shows?|provides?|contains?|illustrates?|describes?|specifies?|see)\b|^\(see\b/i.test(
        match[3],
      )
    )
      return null;
    const title = clean(match[3]).replace(
      /^\((?:infor?mative|normative|informativ|normativ|informatif|normatif)\)\s*/i,
      '',
    );
    return {
      key: 'annex:' + match[2].toUpperCase(),
      label:
        match[1][0].toUpperCase() + match[1].slice(1).toLowerCase() + ' ' + match[2].toUpperCase(),
      title,
      kind: 'annex',
    };
  }
  if (/^(Bibliography|Bibliographie|Literaturhinweise|Literaturverzeichnis)\s*[.]?$/i.test(line))
    return { key: 'bibliography', label: line.replace(/\.$/, ''), title: '', kind: 'bibliography' };
  if (/^(Foreword|Introduction|Vorwort|Einleitung|Avant-propos)\s*[.]?$/i.test(line))
    return {
      key: 'preface:' + titleKey(line),
      label: line.replace(/\.$/, ''),
      title: '',
      kind: 'preface',
    };
  line = line.replace(/^(\d+(?:\s*\.\s*\d+)*)\s*\.\s*[Il](?=\s|\.)/, '$1.1');
  match = line.match(
    /^((?:[1-9]\d?|[A-Z])(?:\s*\.\s*\d{1,2}){0,5})\.?\s+((?:\d{1,3}\s+)?[\p{L}].*)$/u,
  );
  if (!match || /^[A-Z]$/.test(match[1])) return null;
  const label = match[1].replace(/\s/g, '');
  let title = match[2].trim(),
    runIn = false;
  const sentence = title.match(/^(.{3,100}?)\.\s*(?=[A-ZÀ-Ý][a-zà-ÿ]{1,}|the\b|this\b)/);
  if (sentence) {
    title = sentence[1];
    runIn = true;
  }
  title = title.replace(/\.$/, '').trim();
  if (title.length > 135 || title.split(' ').length > 16 || boilerplate.test(title)) return null;
  if (
    /\b(?:shall|should|must|where|there|is|are|was|were|will|may|can|would|could|illustrates?|through|shown|copyright)\b/i.test(
      title,
    )
  )
    return null;
  if (
    (title.match(/\p{L}/gu)?.length || 0) < 3 ||
    (title.match(/\p{L}/gu)?.length || 0) / title.replace(/\s/g, '').length < 0.65
  )
    return null;
  return {
    key: 'clause:' + label,
    label,
    title,
    kind: label.includes('.') ? 'subsection' : 'section',
    runIn,
  };
}
function titleMatches(a, b) {
  const left = titleKey(a),
    right = titleKey(b);
  if (!left || !right) return false;
  if (
    left === right ||
    (Math.min(left.length, right.length) >= 4 && (left.startsWith(right) || right.startsWith(left)))
  )
    return true;
  const words = (text) =>
      new Set(
        clean(text)
          .toLowerCase()
          .match(/\p{L}{3,}/gu) || [],
      ),
    one = words(a),
    two = words(b);
  const overlap = [...one].filter((word) => two.has(word)).length;
  return overlap >= 2 && overlap / Math.max(one.size, two.size) >= 0.6;
}
function readContents(pages) {
  const entries = new Map();
  let category = 'clauses';
  for (const page of pages) {
    if (!page.contents) continue;
    for (const line of page.lines) {
      const text = clean(line.text);
      if (/^(?:List of )?(?:Tables|Figures|Tableaux|Abbildungen|Bilder|Tabellen)\b/i.test(text)) {
        category = 'illustrations';
        continue;
      }
      if (contentsTitle.test(text)) {
        category = 'clauses';
        continue;
      }
      const heading = headingFor(text);
      if (
        !heading ||
        (category === 'illustrations' && ['section', 'subsection'].includes(heading.kind))
      )
        continue;
      if (!entries.has(heading.key)) entries.set(heading.key, heading);
    }
  }
  return entries;
}
function buildStructure(texts, { layouts = [] } = {}) {
  const pages = Array.from({ length: Math.max(texts.length, layouts.length) }, (_, i) => {
    const layout = layouts[i];
    const lines = layout?.lines?.length
      ? layout.lines
      : String(texts[i] || '')
          .split('\n')
          .map((text) => ({ text }));
    return { layout, lines, contents: isContentsPage(lines.map((line) => line.text).join('\n')) };
  });
  const toc = readContents(pages),
    tocRoots = new Set(
      [...toc.values()].filter((node) => node.kind === 'section').map((node) => node.label),
    );
  const repeated = new Map();
  for (const page of pages)
    for (const text of new Set(
      page.lines
        .filter((line, i) =>
          page.layout
            ? line.top < page.layout.height * 0.09 || line.top > page.layout.height * 0.9
            : i < 3 || i > page.lines.length - 5,
        )
        .map((line) => signature(line.text))
        .filter((text) => text.length > 8),
    ))
      repeated.set(text, (repeated.get(text) || 0) + 1);
  const found = new Map(),
    alternatives = new Map();
  let order = 0;
  for (const [p, page] of pages.entries()) {
    if (page.contents) continue;
    const { layout, lines } = page;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let text = clean(line.text);
      if (!text || boilerplate.test(text)) continue;
      const edge = layout
        ? line.top < layout.height * 0.045 || line.top > layout.height * 0.91
        : i < 3 || i > lines.length - 4;
      if (
        edge &&
        (repeated.get(signature(text)) || 0) >= Math.max(3, Math.ceil(pages.length * 0.3))
      )
        continue;
      if (layout && (line.top > layout.height * 0.92 || line.top < 0)) continue;
      const next = lines[i + 1];
      if (
        /^(?:[1-9]\d?(?:\s*\.\s*\d+)*|[A-Z]\.\d+)\.?$/.test(text) &&
        next &&
        !boilerplate.test(next.text) &&
        !headingFor(next.text) &&
        (!layout ||
          (line.column === next.column && Math.abs(next.top - line.top) < line.height * 2.6))
      )
        text += ' ' + clean(next.text);
      let node = headingFor(text);
      if (!node) continue;
      if (
        layout &&
        node.kind === 'subsection' &&
        !node.runIn &&
        next &&
        next.column === line.column &&
        next.top - line.top > 0 &&
        next.top - line.top < line.height * 1.8 &&
        Math.abs(next.x - line.x) < line.height * 2 &&
        next.height >= line.height * 0.88 &&
        !headingFor(next.text) &&
        !/^(?:The|This|These|On|In|For|If|When|Where|All|Each|A|An|Both)\b/i.test(clean(next.text))
      ) {
        const continued =
          text.replace(/-$/, '') + (text.endsWith('-') ? '' : ' ') + clean(next.text);
        const joined = headingFor(continued);
        if (joined && (text.endsWith('-') || joined.runIn)) node = joined;
      }
      if (['annex'].includes(node.kind) && !node.title) {
        for (const value of lines.slice(i + 1, i + 5)) {
          const candidate = clean(value.text);
          if (
            /^\((?:informative|normative|informativ|normativ|informatif|normatif)\)$/i.test(
              candidate,
            )
          )
            continue;
          if (candidate && !boilerplate.test(candidate) && !headingFor(candidate)) {
            node.title = candidate;
            break;
          }
        }
      }
      const expected = toc.get(node.key),
        matched = expected && (!expected.title || titleMatches(node.title, expected.title));
      if (expected && !matched) continue;
      const root = node.label.split('.')[0],
        named = ['annex', 'bibliography', 'preface'].includes(node.kind);
      if (!named && tocRoots.size >= 2 && !/^[A-Z]$/.test(root) && !tocRoots.has(root)) continue;
      if (!named && !matched) {
        if (
          /^(?:The|This|These|On|In|For|If|When|Where|All|Each|A|An|Both|See|Refer|Except|Generally)\b/i.test(
            node.title,
          )
        )
          continue;
        if (node.kind === 'section' && !/^[\p{Lu}]/u.test(node.title)) continue;
        if (layout) {
          const caps = node.title === node.title.toUpperCase(),
            larger = line.height >= layout.bodyHeight * 1.03;
          const previous = lines[i - 1],
            space =
              !previous ||
              previous.column !== line.column ||
              line.top - previous.top > line.height * 1.7;
          if (
            (line.parts >= 3 && !larger && !line.bold && !line.recovered) ||
            (!larger &&
              !line.bold &&
              !line.recovered &&
              !caps &&
              !space &&
              !specialTitles.test(node.title))
          )
            continue;
          if (node.runIn && !larger && !line.bold) continue;
          if (!larger && !line.bold && node.title.split(' ').length > 7) continue;
        }
      }
      if (matched && expected.title) node = { ...node, title: expected.title };
      const score =
        (matched ? 10 : 0) +
        (line.bold ? 2 : 0) +
        (layout && line.height > layout.bodyHeight * 1.05 ? 1 : 0);
      const candidate = {
        ...node,
        page: p + 1,
        line: i,
        order: order++,
        score,
        children: [],
        ...(layout ? { top: Math.max(0, (line.top - 8) / layout.height) } : {}),
      };
      const old = found.get(node.key);
      if (!alternatives.has(node.key)) alternatives.set(node.key, []);
      alternatives.get(node.key).push(candidate);
      if (!old || score > old.score) found.set(node.key, candidate);
    }
  }
  // A table reference or continued contents entry cannot precede its body
  // section. Keep later genuine occurrences rather than the first false hit.
  for (const [key, variants] of [...alternatives].sort(
    (a, b) => a[0].split('.').length - b[0].split('.').length,
  )) {
    if (variants[0].kind !== 'subsection') continue;
    const valid = variants.filter((node) => {
      const parts = node.label.split('.');
      while (parts.length > 1) {
        parts.pop();
        const label = parts.join('.');
        const parent = found.get(/^[A-Z]$/.test(label) ? 'annex:' + label : 'clause:' + label);
        if (
          parent &&
          (parent.page > node.page || (parent.page === node.page && parent.order > node.order))
        )
          return false;
      }
      return true;
    });
    if (valid.length)
      found.set(key, valid.sort((a, b) => b.score - a.score || a.order - b.order)[0]);
    else found.delete(key);
  }
  const flat = [...found.values()]
    .sort((a, b) => a.page - b.page || a.order - b.order)
    .slice(0, 600);
  const byKey = new Map(flat.map((node) => [node.key, node])),
    roots = [];
  for (const node of flat) {
    let parent = null;
    if (node.kind === 'subsection') {
      const parts = node.label.split('.');
      while (parts.length > 1 && !parent) {
        parts.pop();
        const label = parts.join('.');
        parent = byKey.get(/^[A-Z]$/.test(label) ? 'annex:' + label : 'clause:' + label);
      }
      if (parent && parent.page > node.page) parent = null;
    }
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const compare = (a, b) => a.label.localeCompare(b.label, 'en', { numeric: true });
  const strip = (node) => ({
    label: node.label,
    title: node.title,
    kind: node.kind,
    page: node.page,
    line: node.line,
    ...(node.top !== undefined ? { top: node.top } : {}),
    children: node.children.sort(compare).map(strip),
  });
  const unconfirmed = [...toc.keys()].filter((key) => !found.has(key)).length;
  return {
    version: 2,
    nodes: roots.map(strip),
    count: flat.length,
    source: toc.size
      ? layouts.length
        ? 'contents+layout'
        : 'contents+text'
      : layouts.length
        ? 'layout'
        : 'text',
    unconfirmedContents: unconfirmed,
    message: flat.length
      ? (toc.size
          ? 'Структура восстановлена по оглавлению и заголовкам на страницах.'
          : 'Структура восстановлена по заголовкам на страницах.') +
        (unconfirmed ? ' Часть пунктов оглавления не удалось уверенно привязать к страницам.' : '')
      : 'Заголовки не удалось уверенно выделить.',
  };
}
module.exports = { buildStructure, headingFor, isContentsPage };
