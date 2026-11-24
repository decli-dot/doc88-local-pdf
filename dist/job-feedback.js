(function (root, factory) {
  if (typeof module === 'object' && module.exports)
    module.exports = factory(require('./ocr-language.js'));
  else root.DecliFeedback = factory(root.DecliOCR);
})(globalThis, function (ocr) {
  'use strict';
  const labels = { eng: 'английский', deu: 'немецкий', fra: 'французский', rus: 'русский' };
  function phase(job) {
    const stage = job.stage;
    if (stage === 'done') return { step: 2, label: 'Готово', message: 'Документ готов.' };
    if (stage === 'error')
      return {
        step: job.workflowPhase === 'pdf' ? 2 : 1,
        label: 'Обработка завершена',
        message: '',
      };
    if (job.captchaSolving && stage === 'waiting')
      return {
        step: 1,
        label: 'Проверяем доступ',
        message: 'Проверяем доступ. Обработка продолжится автоматически.',
      };
    const special = {
      queued: 'В очереди.',
      choosing: 'Выберите издание документа.',
      selecting: 'Выберите документы серии.',
      language: 'Выберите язык документа.',
      waiting: 'Подтвердите доступ, чтобы продолжить.',
      cancelled: 'Обработка остановлена.',
      interrupted: 'Обработка прервана. Можно продолжить.',
    };
    if (stage === 'language' && job.languageScope === 'series')
      special.language = 'Выберите язык для выбранных документов.';
    else if (stage === 'language' && job.languageException === 'batch-unavailable')
      special.language = 'Выбранный для серии язык недоступен. Подтвердите язык этого документа.';
    if (special[stage])
      return {
        step: ['waiting', 'cancelled', 'interrupted'].includes(stage)
          ? job.workflowPhase === 'pdf'
            ? 2
            : job.workflowPhase === 'checking'
              ? 1
              : 0
          : 0,
        label: {
          queued: 'В очереди',
          choosing: 'Выбор издания',
          selecting: 'Выбор документов',
          language: 'Выбор языка',
          waiting: 'Нужно действие',
          cancelled: 'Остановлено',
          interrupted: 'Прервано',
        }[stage],
        message: special[stage],
      };
    if (stage === 'resolving')
      return { step: 0, label: 'Уточняем издание', message: 'Уточняем обозначение и год издания.' };
    if (stage === 'searching' || (stage === 'checking' && job.workflowPhase !== 'pdf'))
      return {
        step: 1,
        label: 'Проверяем документ',
        message: 'Ищем и проверяем документ нужного издания и языка.',
      };
    return { step: 2, label: 'Готовим PDF', message: 'Готовим PDF с поиском по тексту.' };
  }
  function failureKind(error) {
    const code = error?.code || '';
    if (code === 'SOURCE_ACCESS_PENDING') return 'access';
    if (['FOREIGN_LANGUAGE', 'FOREIGN_SCRIPT'].includes(code)) return 'language';
    if (code === 'DOCUMENT_MISMATCH') return 'edition';
    if (code === 'INCOMPLETE_DOCUMENT') return 'incomplete';
    if (
      error?.name === 'TimeoutError' ||
      /HTTP\s*(?:403|408|429|5\d\d)|ETIMEDOUT|ECONNRESET|ENOTFOUND|fetch failed|timed?\s*out|network|подтверждени[ея]\s+доступ|Не удалось получить результаты поиска|Поиск временно недоступен/i.test(
        String(error?.message || ''),
      )
    )
      return 'access';
    return 'processing';
  }
  function rejectionKind(item) {
    const checks = item.checks || {};
    if (item.failureKind) return item.failureKind;
    if (checks.extent?.status === 'failed' || checks.completeness?.status === 'failed')
      return 'incomplete';
    if (checks.identity?.status === 'failed') return 'edition';
    if (checks.language?.status === 'failed') return 'language';
    return null;
  }
  function problem(job) {
    if (job.stage !== 'error') return null;
    const rows = job.searchResults || [],
      kinds = rows.map(rejectionKind);
    let type;
    if (job.namingWarning && rows.some((row) => row.checks?.extent?.officialPages === null))
      type = 'catalogue';
    else if (
      job.errorCode === 'SEARCH_EXHAUSTED' ||
      (!job.errorCode &&
        job.kind === 'search' &&
        rows.length &&
        rows.every((row) => row.status === 'rejected'))
    )
      type =
        kinds.length &&
        kinds.every((kind) => kind === kinds[0]) &&
        ['language', 'incomplete', 'edition'].includes(kinds[0])
          ? kinds[0]
          : 'not_found';
    else if (job.errorCode === 'SEARCH_INCOMPLETE')
      type =
        rows.some((row) => row.status === 'error' && rejectionKind(row) === 'access') ||
        job.failureKind === 'access'
          ? 'access'
          : 'processing';
    else if (job.failureKind) type = job.failureKind;
    else if (
      ['FOREIGN_LANGUAGE', 'FOREIGN_SCRIPT', 'DOCUMENT_MISMATCH', 'INCOMPLETE_DOCUMENT'].includes(
        job.errorCode,
      )
    )
      type = failureKind({ code: job.errorCode });
    else type = 'processing';
    const titles = {
      not_found: 'Документ не найден',
      access: 'Нет доступа',
      language: 'Нужный язык не найден',
      incomplete: 'Документ сокращён',
      edition: 'Издание не совпадает',
      catalogue: 'Издание не удалось проверить',
      processing: 'Обработка не завершена',
    };
    const messages = {
      not_found:
        'Документ с указанным обозначением и годом не найден. Проверьте обозначение или повторите поиск.',
      access: 'Не удалось получить доступ к документу или каталогу. Повторите попытку позже.',
      language: 'Среди проверенных вариантов не найден полный документ на выбранном языке.',
      incomplete:
        'Проверенные варианты содержат не все необходимые страницы. Полный PDF не подготовлен.',
      edition:
        'Проверенные документы не соответствуют указанному обозначению или году. Другое издание не подставлено.',
      catalogue:
        'Не удалось подтвердить издание и его объём по каталогу. Повторите проверку позже.',
      processing: 'Не удалось завершить обработку документа. Можно повторить попытку.',
    };
    const query = job.resolvedQuery || job.query || '';
    const languageOptions = ocr.choices(query, job.catalogueEdition || job.isoEdition);
    const actions = [
      {
        type: 'retry',
        label: ['access', 'catalogue'].includes(type)
          ? 'Повторить попытку'
          : type === 'processing'
            ? 'Повторить обработку'
            : 'Повторить поиск',
      },
    ];
    if (type === 'language' && languageOptions.length > 1)
      actions.push({ type: 'language', label: 'Выбрать язык' });
    if (['not_found', 'edition', 'incomplete', 'catalogue'].includes(type))
      actions.push({ type: 'edit', label: 'Проверить обозначение' });
    return { type, label: titles[type], message: messages[type], actions };
  }
  function validPages(values, total) {
    return [
      ...new Set(
        (values || []).filter(
          (number) => Number.isSafeInteger(number) && number > 0 && number <= total,
        ),
      ),
    ].sort((a, b) => a - b);
  }
  function qualityNotes(job) {
    if (job.stage !== 'done' || !job.pdfReady) return [];
    const total = job.total || 0,
      notes = [];
    const integrity = job.pageIntegrity || job.verification?.pageIntegrity;
    if (integrity && integrity.status !== 'passed') {
      const pages = validPages(
        [
          ...(integrity.breaks || []).flatMap((pair) => [pair.before?.page, pair.after?.page]),
          ...(integrity.duplicates || []).flat(),
          ...(integrity.uncertainPages || []),
        ],
        total,
      );
      notes.push({
        type: 'numbering',
        message:
          integrity.status === 'failed'
            ? 'Порядок или повторение страниц требует проверки.'
            : 'Нумерация определена неуверенно. Проверьте порядок страниц.',
        pages,
      });
    }
    const language = job.verification?.language;
    if (language?.status === 'unknown')
      notes.push({
        type: 'language',
        message: 'Язык текста определён неуверенно. Проверьте распознавание.',
        pages: validPages(
          (language.evidence || []).filter((item) => !item.matched).map((item) => item.page),
          total,
        ),
      });
    const low = validPages(job.ocrQuality?.uncertainPages, total);
    if (low.length)
      notes.push({
        type: 'ocr',
        message:
          'На некоторых страницах текст распознан неуверенно. Проверьте выделенные страницы.',
        pages: low,
      });
    const empty = validPages(job.textlessPages, total);
    if (empty.length || job.blankPages)
      notes.push({
        type: 'textless',
        message: 'На некоторых страницах текст не распознан. Изображения страниц сохранены в PDF.',
        pages: empty,
      });
    if (job.catalogueExtentUnknown)
      notes.push({
        type: 'extent',
        message: 'Объём издания в каталоге не указан. Проверена загрузка всех страниц документа.',
        pages: [],
      });
    return notes;
  }
  function feedback(job) {
    return { progress: phase(job), problem: problem(job), qualityNotes: qualityNotes(job) };
  }
  function languageLabel(value) {
    return labels[value] || null;
  }
  return { phase, problem, qualityNotes, feedback, failureKind, languageLabel };
});
