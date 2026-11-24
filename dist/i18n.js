(function () {
  'use strict';
  const dictionary = {
    Страницы: 'Pages',
    Язык: 'Language',
    Оценка: 'Review',
    Комментарий: 'Comment',
    Действия: 'Actions',
    Оценить: 'Review',
    'Кеш стандартов': 'Standards cache',
    'В кеше пока нет стандартов': 'No cached standards yet',
    'Ничего не найдено': 'No matching standards',

    'Кеш стандартов и dev-лог': 'Standards cache and developer log',
    'Найти в кеше': 'Search cache',
    'Обозначение или название': 'Designation or title',
    'Обновить кеш': 'Refresh cache',
    'Журнал оценок': 'Review log',
    'Документ подходит?': 'Is this the right document?',
    '✓ Да': '✓ Yes',
    '✕ Есть проблема': '✕ There is a problem',
    'Комментарий к документу': 'Document feedback',
    'Что нужно исправить? Можно указать страницу.':
      'What needs fixing? You can include a page number.',
    'Сохранить оценку': 'Save review',
    'Оценка сохранена': 'Review saved',
    '✓ Подходит': '✓ Correct',
    'Не оценён': 'Not reviewed',
    'Издание требует проверки': 'Edition needs verification',
    'Оценить документ': 'Review document',
    'Получить из кеша': 'Use cached document',
    'Режим «100% распознавание» настраивается в кабинете RuCaptcha. Лимиты здесь ограничивают отправки, а не число работников сервиса. Ноль — без ограничений.':
      'Configure “100% recognition” in your RuCaptcha account. Zero means unlimited submissions.',

    'RuCaptcha · подтверждение доступа': 'RuCaptcha · access verification',
    'Автоматическое решение капч': 'Automatic CAPTCHA solving',
    'Ключ API RuCaptcha': 'RuCaptcha API key',
    'Новый ключ (необязательно)': 'New key (optional)',
    'Ключ не указан': 'Key not configured',
    'Ключ сохранён': 'Key saved',
    'Попыток на документ': 'Attempts per document',
    'Попыток в день (UTC)': 'Attempts per day (UTC)',
    'Баланс:': 'Balance:',
    'Попыток сегодня (UTC):': 'Attempts today (UTC):',
    'Сохранить настройки': 'Save settings',
    'Проверить баланс': 'Check balance',
    'Удалить ключ': 'Remove key',
    'Текстовая капча DDoS-Guard и пазл Doc88. При неудаче доступно ручное подтверждение. Ключ хранится только в локальных настройках.':
      'DDoS-Guard text CAPTCHA and Doc88 slider puzzle. Manual verification remains available if solving fails. The key is stored in local settings only.',
    'Режим «100% распознавание» настраивается в кабинете RuCaptcha. Лимиты здесь ограничивают отправки, а не число работников сервиса.':
      'Configure “100% recognition” in your RuCaptcha account. These limits count submissions, not the number of service workers.',
    'Проверяем доступ': 'Verifying access',
    'Проверяем доступ. Обработка продолжится автоматически.':
      'Verifying access. Processing will continue automatically.',
    'Источники документов': 'Document sources',
    'Все — сначала Doc88': 'All — Doc88 first',
    'Все — сначала Anna’s Archive': 'All — Anna’s Archive first',
    'Только Doc88': 'Doc88 only',
    'Только Anna’s Archive': 'Anna’s Archive only',
    'Увеличить проверку': 'Enlarge verification',
    'Свернуть проверку': 'Collapse verification',
    'Эксперимент: готовый PDF': 'Experiment: existing PDF',
    'Эксперимент: поиск готового PDF': 'Experiment: PDF search',
    'Указать карточку вручную': 'Enter a record manually',
    'Карточка Anna’s Archive (необязательно)': 'Anna’s Archive record (optional)',
    'Найти готовый PDF': 'Find existing PDF',
    'Карточка Anna’s Archive': 'Anna’s Archive record',
    'Страница скачивания (необязательно)': 'Download page (optional)',
    'Проверить готовый PDF': 'Check existing PDF',
    'Ответ на проверку, если нужен ввод текста': 'Verification answer, if text input is required',
    'Ввести ответ': 'Enter answer',
    'Нажать Enter': 'Press Enter',
    'Выполните проверку. После подтверждения обработка продолжится автоматически.':
      'Complete the verification. Processing will then continue automatically.',
    'Не удалось передать ответ. Обновите проверку.':
      'Could not send the answer. Refresh verification.',
    'Язык серии': 'Series language',
    'Выберите язык для выбранных документов.': 'Choose one language for the selected documents.',
    'Выберите один или несколько языков для выбранных документов.':
      'Choose one or more languages for the selected documents.',
    'Выберите один или несколько языков документа.': 'Choose one or more document languages.',
    'Выбранный для серии язык недоступен. Подтвердите язык этого документа.':
      'The selected series language is unavailable. Confirm the language for this document.',
    'Проверка сохранённых файлов': 'Checking saved files',
    'Сохранение для повторного поиска': 'Saving for repeated searches',
    'Готово с замечаниями': 'Ready with notes',
    'Проверяем документ': 'Checking the document',
    'Готовим PDF': 'Preparing PDF',
    'Уточняем обозначение и год издания.': 'Checking the designation and edition year.',
    'Ищем и проверяем документ нужного издания и языка.':
      'Finding and checking the requested edition and language.',
    'Готовим PDF с поиском по тексту.': 'Preparing a searchable PDF.',
    'Обработка завершена': 'Processing finished',
    'Документ не найден': 'Document not found',
    'Нет доступа': 'Access unavailable',
    'Нужный язык не найден': 'Requested language not found',
    'Документ сокращён': 'Incomplete document',
    'Издание не совпадает': 'Edition does not match',
    'Издание не удалось проверить': 'Edition could not be verified',
    'Обработка не завершена': 'Processing incomplete',
    'Документ с указанным обозначением и годом не найден. Проверьте обозначение или повторите поиск.':
      'No document matching the designation and year was found. Check the designation or search again.',
    'Не удалось получить доступ к документу или каталогу. Повторите попытку позже.':
      'The document or catalogue could not be accessed. Try again later.',
    'Среди проверенных вариантов не найден полный документ на выбранном языке.':
      'No complete document in the selected language was found among the checked candidates.',
    'Проверенные варианты содержат не все необходимые страницы. Полный PDF не подготовлен.':
      'The checked candidates do not contain all required pages. A complete PDF could not be prepared.',
    'Проверенные документы не соответствуют указанному обозначению или году. Другое издание не подставлено.':
      'The checked documents do not match the requested designation or year. No other edition was substituted.',
    'Не удалось подтвердить издание и его объём по каталогу. Повторите проверку позже.':
      'The edition and its length could not be confirmed in the catalogue. Try again later.',
    'Не удалось завершить обработку документа. Можно повторить попытку.':
      'Document processing could not be completed. You can try again.',
    'Повторить попытку': 'Try again',
    'Повторить обработку': 'Retry processing',
    'Повторить поиск': 'Search again',
    'Проверить обозначение': 'Check designation',
    'Порядок или повторение страниц требует проверки.':
      'Check the page order or possible repeated pages.',
    'Нумерация определена неуверенно. Проверьте порядок страниц.':
      'Page numbering is uncertain. Check the page order.',
    'Язык текста определён неуверенно. Проверьте распознавание.':
      'The text language is uncertain. Check the recognized text.',
    'На некоторых страницах текст распознан неуверенно. Проверьте выделенные страницы.':
      'Text recognition is uncertain on some pages. Check the listed pages.',
    'На некоторых страницах текст не распознан. Изображения страниц сохранены в PDF.':
      'No text was recognized on some pages. Their images remain in the PDF.',
    'Объём издания в каталоге не указан. Проверена загрузка всех страниц документа.':
      'The catalogue does not specify the edition length. All declared pages were downloaded.',
    'Замечания к PDF': 'PDF notes',
    'Язык документа: автоматически': 'Document language: automatic',
    'Язык документа: английский': 'Document language: English',
    'Язык документа: немецкий': 'Document language: German',
    'Язык документа: французский': 'Document language: French',
    'Язык документа: русский': 'Document language: Russian',
    'Язык документа: выбор при поиске': 'Document language: select when searching',
    'Язык документа: для каждого документа': 'Document language: selected for each document',
    'Время обработки': 'Processing time',
    Этап: 'Stage',
    Время: 'Time',
    Вызовы: 'Calls',
    Поиск: 'Search',
    'Предварительная проверка': 'Preliminary checks',
    Загрузка: 'Download',
    'Подготовка изображений': 'Image preparation',
    'Сборка PDF': 'PDF assembly',
    'Проверка документа': 'Document verification',
    'Параллельные этапы могут пересекаться, поэтому их время не складывается в общее.':
      'Parallel stages can overlap, so their times do not add up to the total.',
    'Структура восстановлена по оглавлению и заголовкам на страницах.':
      'Structure reconstructed from the contents and headings on the pages.',
    'Структура восстановлена по оглавлению и заголовкам на страницах. Часть пунктов оглавления не удалось уверенно привязать к страницам.':
      'Structure reconstructed from the contents and headings on the pages. Some contents entries could not be confidently matched to pages.',
    'Структура восстановлена по заголовкам на страницах.':
      'Structure reconstructed from headings on the pages.',
    'Часть пунктов оглавления не удалось уверенно привязать к страницам.':
      'Some contents entries could not be confidently matched to pages.',
    'Заголовки не удалось уверенно выделить.': 'Headings could not be identified confidently.',
    Очистить: 'Clear',
    'Очистить рабочую область': 'Clear workspace',
    'Завершите или остановите текущую обработку.': 'Finish or stop the current processing first.',
    Поддержка: 'Supported standards',
    'Выбор языка': 'Language selection',
    'Выбрать язык': 'Select language',
    'Язык документа': 'Document language',
    'На каком языке искать документ?': 'Which document language would you like?',
    'Выберите язык документа.': 'Select the document language.',
    'Английский / Немецкий / Французский': 'English / German / French',
    'Объём издания в каталоге EN не указан. Проверена загрузка всех страниц источника.':
      'The EN catalogue does not specify the edition length. All pages declared by the source have been downloaded.',
    'Способ обработки': 'Processing method',
    'Прямое извлечение': 'Direct extraction',
    'Изображения + OCR': 'Images + OCR',
    'Изображения + OCR · автоматическое переключение': 'Images + OCR · automatic fallback',
    'Автоматический режим использует OCR, если прямое извлечение недоступно.':
      'Automatic mode uses OCR when direct extraction is unavailable.',
    Французский: 'French',
    Автоматически: 'Automatic',
    'Английский / Немецкий': 'English / German',
    'Английский / Французский': 'English / French',
    'Каталог издателя': 'Publisher catalogue',
    'Открыть каталог ↗': 'Open catalogue ↗',
    'Опубликованное издание': 'Published edition',
    'DecliPDF · Поиск стандартов': 'DecliPDF · Standards search',
    'DecliPDF — главная': 'DecliPDF — home',
    'Поиск стандартов': 'Standards search',
    'Обозначения стандартов': 'Standard designations',
    'Язык интерфейса': 'Interface language',
    Локально: 'Local',
    'Закрыть приложение': 'Close application',
    Документ: 'Document',
    'Источник документа': 'Document input',
    'По номеру': 'Designation',
    Списком: 'Batch',
    'По ссылке': 'Link',
    'Из архива': 'ZIP archive',
    'Обозначение документа': 'Document designation',
    'Например, ISO 14405-1:2025': 'e.g. ISO 14405-1:2025',
    'Найти документ': 'Find document',
    'Документы — каждый с новой строки': 'Documents — one per line',
    'До 30 документов.': 'Up to 30 documents.',
    'Добавить в очередь': 'Add to queue',
    'Готовые PDF можно скачать одним архивом.': 'Download completed PDFs in one ZIP file.',
    'Ссылка на документ': 'Document link',
    'Вставь ссылку на документ': 'Paste a document link',
    'С первой страницы': 'From page',
    'До страницы': 'To page',
    'До конца документа': 'Last page',
    'Для первой пробы укажи «до страницы 2».': 'For a trial, set the last page to 2.',
    'Создать OCR PDF': 'Create searchable PDF',
    'Выбери архив с изображениями': 'Select an image archive',
    'или перетащи ZIP сюда · до 250 МБ': 'or drop a ZIP file here · up to 250 MB',
    'Подойдёт ZIP со страницами в JPG или PNG. Расположим их по номерам файлов.':
      'ZIP with JPG or PNG pages. Pages are sorted by file number.',
    'Распознать и создать PDF': 'Create searchable PDF',
    'Улучшение изображений': 'Image enhancement',
    'Язык OCR': 'OCR language',
    Английский: 'English',
    Немецкий: 'German',
    Русский: 'Russian',
    'Проверяем готовность…': 'Checking availability…',
    'Готов к работе': 'Ready',
    'Модель загрузится при первом запуске': 'The model will download on first use',
    Результат: 'Result',
    Ожидание: 'Idle',
    'Документ не выбран': 'No document selected',
    'Укажите обозначение для поиска.': 'Enter a designation to search.',
    Обработка: 'Processing',
    'В очереди': 'Queued',
    'В очереди.': 'Queued.',
    Прервано: 'Interrupted',
    'Уточняем издание': 'Resolving edition',
    'Серия стандартов': 'Standards series',
    'Выбор документов': 'Choose documents',
    'Выберите документы': 'Choose documents',
    'Выберите документы серии.': 'Choose documents in the series.',
    'Выбрать документы': 'Choose documents',
    'Выбрать все': 'Select all',
    'Снять выбор': 'Clear selection',
    'Найти выбранные документы': 'Find selected documents',
    'Архивное издание': 'Historical edition',
    'Каталог издателя ↗': 'Publisher catalogue ↗',
    'Объём издания': 'Edition page count',
    'Текст документа': 'Document text',
    'Текст для копирования': 'Text for copying',
    'Скопировать текст': 'Copy text',
    Закрыть: 'Close',
    'Текст скопирован.': 'Text copied.',
    'Нажмите Ctrl+C, чтобы скопировать выделенный текст.':
      'Press Ctrl+C to copy the selected text.',
    'Выбор издания': 'Choose an edition',
    'Издание документа': 'Document edition',
    'Выбери издание': 'Choose an edition',
    'Выберите издание': 'Choose an edition',
    'Выберите издание документа.': 'Choose a document edition.',
    'Ищем документ': 'Searching',
    'Поиск завершён. Документ нужного издания и языка со всеми страницами не найден.':
      'Search complete. No complete document matching the requested edition and language was found.',
    'Поиск не завершён из-за ошибки доступа или обработки. Нажмите «Продолжить».':
      'Search was interrupted by an access or processing error. Click Resume to continue.',
    Проверяем: 'Checking',
    Открываем: 'Opening',
    'Нужно действие': 'Action required',
    Скачиваем: 'Downloading',
    'Проверяем ZIP': 'Checking ZIP',
    Распознаём: 'Recognizing',
    'Собираем PDF': 'Creating PDF',
    Готово: 'Ready',
    Ошибка: 'Error',
    Остановлено: 'Stopped',
    'Нужна проверка': 'Review required',
    'Документ готов.': 'Your document is ready.',
    'Подготовка документа…': 'Preparing your document…',
    'Не удалось подготовить документ. Попробуйте другое издание или повторите поиск.':
      'The document could not be prepared. Try another edition or search again.',
    'Обработка остановлена.': 'Processing stopped.',
    'Обработка прервана. Можно продолжить.': 'Processing interrupted. You can resume.',
    'Подтвердите доступ, чтобы продолжить.': 'Complete the access check to continue.',
    'Действующее издание по ISO': 'Current ISO edition',
    'Опубликованное издание по ISO': 'Published ISO edition',
    'Указанное издание по каталогу ISO': 'Edition in the ISO catalogue',
    'Уточнение издания в каталоге ISO': 'ISO catalogue lookup',
    'Открыть поиск ISO ↗': 'Open ISO search ↗',
    'Поправки к этому изданию': 'Amendments and corrigenda',
    'В карточке ISO поправки не найдены.': 'No amendments listed in the ISO record.',
    'Искать отдельно': 'Search separately',
    Отозвано: 'Withdrawn',
    'Архив страниц': 'Page archive',
    Распознавание: 'OCR',
    'Готовый PDF': 'Completed PDF',
    'Этапы обработки': 'Processing stages',
    'Обработка документа': 'Document processing',
    'Подтверждение доступа': 'Access verification',
    'Пройдите проверку в панели ниже.': 'Complete the verification in the panel below.',
    'Выполните проверку на изображении ниже.': 'Complete the verification in the image below.',
    'Подтверждение доступа: передвинь ползунок мышью или пальцем':
      'Access verification: move the slider with your mouse or finger',
    'Загружаем проверку…': 'Loading verification…',
    'После подтверждения обработка продолжится автоматически.':
      'Processing will resume automatically after verification.',
    'Обновить изображение': 'Refresh image',
    'Скачать OCR PDF': 'Download PDF',
    'Открыть PDF ↗': 'Open PDF ↗',
    'Скачать исходный ZIP': 'Download source ZIP',
    'Остановить обработку': 'Cancel processing',
    Продолжить: 'Resume',
    'Структура и нормативные ссылки': 'Document structure and normative references',
    'Структура документа': 'Document structure',
    'Нормативные ссылки': 'Normative references',
    'Структура ещё не извлечена.': 'Document structure is not available yet.',
    'Нормативные ссылки ещё не извлечены.': 'Normative references are not available yet.',
    'Искать выбранные ссылки': 'Find selected references',
    'До 30 ссылок за раз. Для серии «all parts» сначала уточни часть стандарта.':
      'Up to 30 references at once. Specify a part for “all parts” references.',
    'Очередь документов': 'Document queue',
    'Обрабатываем по одному': 'Processed sequentially',
    'Продолжить незавершённые': 'Resume unfinished',
    'Остановить очередь': 'Cancel queue',
    'Выбрать издание': 'Choose edition',
    'Показать проверку': 'Show verification',
    'Готово · проверь страницы': 'Ready · review pages',
    'Подходящий вариант проверен': 'Matching document verified',
    'Проверяем найденные варианты…': 'Checking candidates…',
    'Подтверждённого варианта пока нет': 'No verified candidate yet',
    'Все страницы': 'All pages',
    'Объём ISO': 'ISO page count',
    Издание: 'Edition',
    'Нумерация и дубли': 'Numbering and duplicates',
    'Пока не проверено': 'Not checked yet',
    'Основания проверки': 'Verification details',
    'Скачать проверенный PDF ↓': 'Download verified PDF ↓',
    'Проверить этот вариант': 'Check this candidate',
    'Результаты поиска': 'Search diagnostics',
    'Последние документы': 'Recent documents',
    'Результаты сохраняются между запусками': 'Results are saved locally',
    'Издания стандарта': 'Standard editions',
    'Издания и прежние обозначения': 'Editions and former designations',
    'Выберите нужное издание, чтобы продолжить.': 'Select an edition to continue.',
    'Отменить поиск': 'Cancel search',
    'Искать выбранное издание': 'Find selected edition',
    'Карточка на ISO ↗': 'ISO record ↗',
    'Режим разработчика': 'Developer mode',
    Пароль: 'Password',
    Отмена: 'Cancel',
    Войти: 'Sign in',
    'Dev · Выйти': 'Dev · Sign out',
    'Неверный пароль.': 'Incorrect password.',
    'Слишком много попыток. Повторите через минуту.': 'Too many attempts. Try again in a minute.',
    'Требуется вход в dev-режим.': 'Developer sign-in required.',
    'Не удалось выполнить действие.': 'The action could not be completed.',
    'Передвинь ползунок. После подтверждения обработка продолжится сама.':
      'Move the slider. Processing will resume automatically after verification.',
    'Проверяем подтверждение…': 'Checking verification…',
    'Не удалось обновить изображение. Нажми «Обновить изображение».':
      'Could not load the image. Select “Refresh image”.',
    'Движение не передалось. Отпусти ползунок и обнови изображение.':
      'The movement could not be sent. Release the slider and refresh the image.',
    'Структура восстановлена по распознанным заголовкам. Проверь неоднозначные названия и переходы.':
      'Structure extracted from recognized headings. Review any ambiguous headings and destinations.',
    'Заголовки не удалось уверенно выделить из OCR.': 'Headings could not be reliably identified.',
    'Раздел нормативных ссылок не распознан.':
      'The normative references section was not identified.',
    'Ссылки извлечены только из раздела Normative references; обозначения могут содержать ошибки OCR.':
      'References extracted from the Normative references section. Designations may contain OCR errors.',
    'В разделе нормативных ссылок обозначения стандартов не найдены.':
      'No standard designations found in the normative references section.',
    'Приложение не отвечает': 'Application unavailable',
    'Приложение закрыто': 'Application closed',
    'Приложение закрыто. Для нового запуска открой Start.cmd.':
      'Application closed. Open Start.cmd to start again.',
    'Работа остановлена. Обнови страницу, чтобы продолжить.':
      'Stopped. Reload this page to continue.',
    'Сначала выбери архив.': 'Select an archive first.',
    'Выбери ZIP-архив с изображениями страниц.': 'Select a ZIP archive containing page images.',
    'Архив больше 250 МБ. Обработай документ частями.':
      'The archive exceeds 250 MB. Process the document in smaller parts.',
    'Загружаем архив…': 'Uploading archive…',
    'Сначала дождись текущей обработки или останови её.':
      'Wait for the current document or cancel processing.',
    'Добавь от 1 до 30 документов, каждый с новой строки.': 'Enter 1–30 documents, one per line.',
    'Не удалось подключиться к программе.': 'Could not connect to the application.',
  };
  const templates = [
    [/^Распознано страниц: (\d+) из (\d+)$/, 'Pages recognized: $1 of $2'],
    [/^Страница (\d+)$/, 'Page $1'],
    [/^Ещё страниц: (\d+)$/, 'More pages: $1'],
    [/^Общее время: ([\d,.]+) с$/, 'Total time: $1 s'],
    [
      /^Предварительная проверка: завершено (\d+) из (\d+); максимум одновременно — (\d+)\.$/,
      'Preliminary checks: $1 of $2 finished; peak concurrency: $3.',
    ],
    [/^Издание (ISO(?:\/IEC)?|DIN|ASME|BS|NF|EN)$/, '$1 edition'],
    [/^Выбрано: (\d+)$/, 'Selected: $1'],
    [/^([✓×·]\s+)(.+)$/, (_, prefix, label) => prefix + (dictionary[label] || label)],
    [/^Документ ·/g, 'Document ·'],
    [/ · Подходит$/g, ' · Passed'],
    [/ · Ещё не проверен$/g, ' · Unverified'],
    [/ · Идёт проверка$/g, ' · Checking'],
    [/ · Проверка не пройдена$/g, ' · Failed'],
    [
      /^Готово (\d+) из (\d+)(?: · ждут выбора(?: издания)?: (\d+))?$/,
      (_, a, b, c) => `${a} of ${b} ready${c ? ` · ${c} awaiting selection` : ''}`,
    ],
    [/^Скачать готовые PDF \((\d+)\) ↓$/, (_, a) => `Download completed PDFs (${a}) ↓`],
    [/^Действующее издание(.*)$/, (_, rest) => 'Current edition' + rest],
    [/^Опубликованное издание(.*)$/, (_, rest) => 'Published edition' + rest],
    [/^Архивное издание(.*)$/, (_, rest) => 'Historical edition' + rest],
    [/^Отозвано(.*)$/, (_, rest) => 'Withdrawn' + rest],
    [/ · другое обозначение в истории/g, ' · former designation'],
    [/ · (\d+) стр\. по ISO/g, ' · $1 pages in ISO catalogue'],
    [/^Лист PDF (\d+)$/, 'PDF page $1'],
    [/^Проверено (.+)$/, 'Checked $1'],
    [
      /^Каталог (ISO(?:\/IEC)?|DIN|ASME|BS|NF|EN): (\d+) стр\.(?: · PDF: (\d+) стр\.)?$/,
      (_, publisher, a, b) => `${publisher} catalogue: ${a} pages${b ? ` · PDF: ${b} pages` : ''}`,
    ],
    [/ — уточни часть/g, ' — specify a part'],
    [/ — проверь обозначение по PDF/g, ' — check the designation in the PDF'],
    [/^Найдено разделов: (\d+)(.*)$/, 'Sections found: $1$2'],
    [/(\d+) стр\./g, '$1 pp.'],
    [/(\d+) мин/g, '$1 min'],
    [/(\d+) с(?=\s|$)/gu, '$1 s'],
    [/ · Готово/g, ' · Ready'],
    [/ · Ошибка/g, ' · Error'],
    [/ · Обработка/g, ' · Processing'],
    [/ · Остановлено/g, ' · Stopped'],
    [/ · В очереди/g, ' · Queued'],
    [/ · Прервано/g, ' · Interrupted'],
    [/ · Выбери издание/g, ' · Choose an edition'],
    [/ · Выбор издания/g, ' · Choose an edition'],
    [/ · Нужно действие/g, ' · Action required'],
    [/ МБ/g, ' MB'],
    [/ КБ/g, ' KB'],
  ];
  let locale = localStorage.getItem('declipdf-locale') === 'en' ? 'en' : 'ru';
  const textRecords = new WeakMap(),
    attributeRecords = new WeakMap();
  const protectedText =
    '#job-title,.history-title,.edition-title,.edition-reference,.reference-option,#structure-tree a,.search-result h3,.supplement-row a,#file-label[data-file]';
  function translate(source) {
    const trimmed = source.trim().replace(/\s+/g, ' ');
    if (dictionary[trimmed]) return source.replace(source.trim(), dictionary[trimmed]);
    let value = source;
    for (const [pattern, replacement] of templates) value = value.replace(pattern, replacement);
    return value;
  }
  function update() {
    observer.disconnect();
    const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.parentElement?.closest('script,style,' + protectedText) || !node.nodeValue.trim())
        continue;
      let record = textRecords.get(node);
      if (!record || record.rendered !== node.nodeValue) record = { source: node.nodeValue };
      record.rendered = locale === 'en' ? translate(record.source) : record.source;
      if (node.nodeValue !== record.rendered) node.nodeValue = record.rendered;
      textRecords.set(node, record);
    }
    for (const element of document.querySelectorAll('[placeholder],[title],[aria-label]')) {
      const records = attributeRecords.get(element) || {};
      for (const name of ['placeholder', 'title', 'aria-label']) {
        const value = element.getAttribute(name);
        if (!value) continue;
        let record = records[name];
        if (!record || record.rendered !== value) record = { source: value };
        record.rendered = locale === 'en' ? translate(record.source) : record.source;
        if (value !== record.rendered) element.setAttribute(name, record.rendered);
        records[name] = record;
      }
      attributeRecords.set(element, records);
    }
    document.documentElement.lang = locale;
    for (const button of document.querySelectorAll('[data-locale]'))
      button.setAttribute('aria-pressed', String(button.dataset.locale === locale));
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['placeholder', 'title', 'aria-label'],
    });
  }
  const observer = new MutationObserver(update);
  for (const button of document.querySelectorAll('[data-locale]'))
    button.onclick = () => {
      locale = button.dataset.locale;
      localStorage.setItem('declipdf-locale', locale);
      update();
    };
  update();
  window.DecliI18n = {
    translate,
    update,
    get locale() {
      return locale;
    },
  };
})();
