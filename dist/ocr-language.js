(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DecliOCR = factory();
})(globalThis, function () {
  'use strict';
  const languages = ['eng', 'deu', 'fra', 'rus', 'eng+deu', 'eng+fra', 'eng+deu+fra', 'auto'];
  function choices(query, edition) {
    const allowed = policy(query)?.allowed || ['eng'];
    const published = (edition?.languages || []).filter((code) => allowed.includes(code));
    return (published.length ? allowed.filter((code) => published.includes(code)) : allowed).map(
      (code) => ({
        code,
        label: { eng: 'Английский', deu: 'Немецкий', fra: 'Французский', rus: 'Русский' }[code],
      }),
    );
  }
  function policy(query) {
    const text = String(query || '')
      .normalize('NFKC')
      .trim()
      .toUpperCase();
    if (/^DIN(?=\s|\d)/.test(text))
      return { publisher: 'DIN', models: 'eng+deu', allowed: ['eng', 'deu'] };
    if (/^NF(?=\s|\d)/.test(text))
      return { publisher: 'NF', models: 'eng+fra', allowed: ['eng', 'fra'] };
    if (/^EN(?=\s|\d)/.test(text))
      return { publisher: 'EN', models: 'eng+deu+fra', allowed: ['eng', 'deu', 'fra'] };
    if (/^(?:BS|ASME)(?=\s|\d)/.test(text))
      return { publisher: text.startsWith('BS') ? 'BS' : 'ASME', models: 'eng', allowed: ['eng'] };
    if (/^ISO(?=\s|\/|\d)/.test(text)) return { publisher: 'ISO', models: 'eng', allowed: ['eng'] };
    return null;
  }
  function seriesChoices(editions) {
    const available = new Map();
    for (const edition of editions)
      for (const choice of choices(edition.reference, edition)) available.set(choice.code, choice);
    return ['eng', 'deu', 'fra', 'rus']
      .filter((code) => available.has(code))
      .map((code) => available.get(code));
  }
  function resolve(query, requested = 'eng', documentLanguage) {
    if (documentLanguage) {
      const p = policy(query);
      if (!(p?.allowed || ['eng', 'deu', 'fra', 'rus']).includes(documentLanguage))
        throw Error('Недопустимый язык документа.');
      return documentLanguage;
    }
    if (!languages.includes(requested) && requested !== 'eng+deu+fra')
      throw Error('Unsupported OCR language.');
    return policy(query)?.models || (requested === 'auto' ? 'eng' : requested);
  }
  function explicitForeign(title, query) {
    const p = policy(query);
    if (!p) return false;
    return (
      /中文版|中文译本|中文翻译|中文版本|Chinese\s+(?:translation|version|edition)|[简簡][体體]中文/i.test(
        title,
      ) ||
      (!p.allowed.includes('deu') &&
        /\b(?:German\s+(?:version|edition)|Deutsche\s+(?:Fassung|Ausgabe))\b/i.test(title)) ||
      (!p.allowed.includes('fra') &&
        /\b(?:French\s+(?:version|edition)|version\s+fran[çc]aise)\b/i.test(title))
    );
  }
  return { languages, resolve, policy, explicitForeign, choices, seriesChoices };
});
