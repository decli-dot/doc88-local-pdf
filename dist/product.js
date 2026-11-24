'use strict';
((scope) => {
  const name = 'DecliPDF';
  // Historical jobs may still contain provider names in their human-readable messages.
  // Keep identifiers and addresses intact for recovery; neutralize only presentation fields.
  function displayText(value) {
    return String(value ?? '')
      .replace(/https?:\/\/(?:www\.)?doc88\.com[^\s<>"'\u00ab\u00bb)]*/gi, 'ссылка на документ')
      .replace(/\b(?:www\.)?doc88\.com\b/gi, 'источник документов')
      .replace(/Doc88(?:\s+(?:Local|Browser))?\s+PDF/gi, name)
      .replace(/doc88-downloader/gi, 'загрузчик страниц')
      .replace(/Страницы Doc88/gi, 'Все страницы')
      .replace(/страниц Doc88/gi, 'страниц документа')
      .replace(/заявленных Doc88/gi, 'указанных в карточке документа')
      .replace(/заявленные Doc88/gi, 'указанные в карточке документа')
      .replace(/на Doc88/gi, 'в источнике')
      .replace(/с Doc88/gi, 'из источника')
      .replace(/Doc88/gi, (match, offset) => (offset === 0 ? 'Источник' : 'источник'));
  }
  const fields = new Set([
    'title',
    'message',
    'error',
    'namingWarning',
    'sourceTitle',
    'pdfFilename',
    'archiveFilename',
  ]);
  function present(value, key = '') {
    if (typeof value === 'string') return fields.has(key) ? displayText(value) : value;
    if (Array.isArray(value)) return value.map((item) => present(item));
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([name, item]) => [name, present(item, name)]),
      );
    return value;
  }
  const product = { name, displayText, present };
  if (typeof module !== 'undefined') module.exports = product;
  else scope.DecliPDF = product;
})(globalThis);
