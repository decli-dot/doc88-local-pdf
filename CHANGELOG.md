# Changelog

## Локальное обновление — 24 ноября 2026

- Распознавание нового варианта капчи Doc88 с контурами фигур: RuCaptcha получает инструкцию найти контур, совпадающий с подвижной фигурой. Уже открытая картинка не вызывает лишнее нажатие на ползунок. Прежний пазл поддерживается отдельно; сменившийся во время ожидания вариант виджета не получает устаревший ответ.

## Локальное обновление — 10 ноября 2026

- Восстановление поиска Doc88 после временных ошибок соединения и чтения ответа: повторные запросы с паузой и свежим разрешением DNS. Навигация Anna’s Archive повторяет временные сетевые сбои в том же браузерном сеансе.
- Ожидание RuCaptcha восстанавливается после временного сбоя `getTaskResult` без новой платной отправки; обновившаяся картинка запускает новую проверку, а смены заголовка страницы недостаточно для подтверждения доступа. Добавлены точные коды тайм-аутов и этап проверки.
- Реальное определение национальных серий DIN/BS/NF по карточкам каталога с сохранением языков каждой части; выбор серии внутри списка расширяет существующую очередь. Запрос точного издания сначала читает нужную карточку, без ожидания всей истории стандарта.
- В выборе языка доступны несколько вариантов и «Выбрать все». Для каждого языка создаётся отдельный PDF с пометкой EN/DE/FR; готовые файлы можно скачать одним архивом. Для серии учитываются доступные языки каждой части.
- Выбор действующего или архивного издания при запросе без года; поиск документа начинается после подтверждения пользователя.
- Точный поиск обозначения в каталоге DIN с чтением всех страниц выдачи; отменённые стандарты больше не теряются среди похожих номеров. История изданий не ограничивается первыми десятью карточками, проекты и посторонние национальные обозначения исключаются.
- Пять параллельных предварительных проверок по трём страницам, OCR не более двух страниц на кандидата.
- Поиск полного ASME с Reaffirmed перед расширением запроса; подтверждение пометки внутри документа обязательно.
- Пагинация Doc88 без программного предела по умолчанию; резервный каталог iTeh.
- Dev-кеш готовых стандартов с повторной выдачей без поиска, оценками и историей комментариев.
- Отрицательная оценка исключает этот источник для того же издания и языка из повторного использования.
- Лимиты отправок RuCaptcha сняты; счётчик и стоимость сохранены.

- Add automatic handling of the observed Doc88 slider puzzle through RuCaptcha CoordinatesTask. Validate provider points against the cropped puzzle, discard changed images, release the pointer on cancellation and drain the background verifier when the downloader closes. Extend provider waiting to five minutes for account-level recognition settings; keep per-job/daily submission limits and manual fallback.

- Add a local-only RuCaptcha experiment for the observed DDoS-Guard text challenge, with dev-only key/settings management, a free balance check, persisted per-job/daily attempt limits, stale-image checks, cancellation and manual fallback. Keep source and document verification rules unchanged. Live acceptance is reported separately from fixture tests.

## Unreleased

- Integrate Anna’s Archive as the local search fallback after Doc88. Add a dev-only four-way source order/single-source selector, persist it with jobs, lists and series, and force ordinary new requests to use Doc88 first. Keep providers lazy, retain Doc88 preliminary checks, preserve cancellation/catalogue choices, and prevent a cached Doc88 PDF from bypassing an Anna-first/Anna-only choice. Extend Anna card discovery to catalogue-resolved national/ASME designations and the selected document language.

- Discover Anna’s Archive cards automatically from a catalogue-resolved ISO designation in the local experiment. Exhaust precise matches before alternate spellings, follow result pagination lazily, reject national adoptions and unrelated references, and continue checking candidates after a rejected PDF. Retain a single browser session per job, follow the record’s free-download page before external metadata links, and reuse only checksum-valid local source PDFs from the same card.

- Add a dev-only Anna’s Archive PDF experiment with canonical card/slow-page links, an inline human verification relay, fresh download-link acquisition, MD5/PDF validation, resumable source checkpoints and the existing strict ISO content checks. Keep ordinary search and its shared cache unchanged. Verify the complete live flow on ISO 129-1:2018 after manual confirmation.
- Preserve shared PDF resources when assembling native and recognized pages in batches, avoiding repeated fonts and images. The verified 76-page native ISO result remains searchable at approximately 0.8 MB.

- Recognize independent pages with a bounded native/WASM worker pool, ordered PDF assembly, CPU/free-memory limits, one OpenMP thread per native process, serialized model initialization, and drained cancellation/error cleanup. Retain validated page checkpoints across interruption and upgrade older compatible caches without repeating OCR.
- Compress eligible OCR image streams losslessly with PNG prediction and exact pixel verification, retaining colours, text, page geometry and unsupported original streams. On the same 154-page ISO archive, processing fell from 390.6 to 146.6 seconds and PDF size from 400.0 to 321.1 MB, with identical recognized text and quality evidence.
- Correct OCR progress when a downloaded native PDF requires full or partial recognition. Recognize English replacement-history labels without weakening contradictory-cover rejection, and reject explicit machine-translation watermarks as unconfirmed language editions.
- Cache large generated PDFs up to 1 GiB and retain nested full-OCR checkpoints for validated recovery. Verify the path with a real 154-page, 400 MB ISO result.
- Exclude subsection candidates that precede their body ancestors, selecting valid later headings when early duplicates came from continued contents or symbol tables. Add live catalogue, queue, cancellation/restart and independent-PDF validation scripts and a local workflow report.
- Reuse verified PDFs, source pages and OCR between separate local searches, after resolving the requested catalogue edition and language. Separate full publisher/part/edition/language identities, check file hashes and actual PDF page counts, preserve quality notes and navigation, and restore only intact assets when rebuilding a damaged result. Seed compatible earlier jobs only when all required verification evidence is present.
- Ask for the document language once for selected series parts. Preserve the choice and selected parts across restart/cancellation, request individual confirmation only where the series language is unavailable, and show pending exceptions automatically after queue processing. Keep ISO/ASME/BS English-only and validate concurrent selections atomically.
- Show edition lookup, document checking and PDF preparation in the ordinary interface, without exposing providers or technical messages.
- Distinguish missing documents, temporary access failures, wrong languages, shortened uploads and edition mismatches; offer recovery actions that preserve the requested designation and year.
- Display concise PDF quality notes with validated page links. Record OCR confidence and textless page numbers; retain unknown confidence for older caches and map selective OCR evidence to original PDF pages.
- Replace the inactive OCR selector with a document-language summary, enable image enhancement automatically in ordinary mode, and keep manual controls behind developer access.
- Add private stage timings with separate wall time and summed work, and a RU/EN processing-time panel visible only in authenticated developer mode.
- Run at most two preliminary candidate checks ahead in discovery order; retain serial full processing, abort and drain speculative checks on success/cancellation, and keep all edition, language and completeness checks.
- Prioritize the complete designation and edition year before optimized discovery. Preserve the exact query punctuation, check precise-title candidates across pages first, and broaden only when no verified PDF was obtained; retain content verification and candidate deduplication in both phases.
- Follow explicit source pagination even when a page contains fewer than 20 results, duplicates or no matching candidates. Continue after rejected uploads, stop on a verified PDF, and distinguish exhausted results from interrupted searches.
- Automatically choose OCR models by publisher: English for ISO/ASME/BS, English+German for DIN, English+French for NF. National prefixes take precedence over embedded ISO labels.
- Resolve short DIN/BS/NF designations against EN/ISO adaptations, preserve full edition dates and consolidated amendments, and add EN Standards as a metadata fallback.
- Search exact and undated designations without reaffirmation suffixes, deduplicate paginated results, and verify the edition year from page text instead of filenames.
- Check source-image scripts before OCR, reject clearly foreign-language titles, tighten prose-language evidence, and withdraw previously accepted results explicitly labelled as Chinese versions.
- Generate catalogue headings/page-count labels from the actual publisher. Disable Libgen and Anna's Archive in the active workflow.

- Offer official ISO series as a persistent multi-select dialogue with Select all / Clear selection and one serialized batch for the selected parts.
- Add DIN Media and ASME catalogue adapters with exact publisher identities, DIN publication months, ASME edition/reaffirmation distinctions, official titles and page extents.
- Retain isolated PDF import and source-adapter utilities for later work; Libgen and Anna's Archive are currently disabled in active searches.
- Import native/mixed PDFs, retain existing vector/text pages, OCR scanned pages, preserve physical page geometry, and apply the same identity/language/extent checks before publishing a result.
- Add a ready-document text view with copy action, conservative line-wrap cleanup, prose-column ordering and tab-separated table cells; source page images and verification text stay unchanged.

- Replace the promotional introduction with a compact standards-search workspace and restrained ISO/ASME/DIN/GOST/JIS/IEC colour accents.
- Add persistent Russian/English interface selection and English, German and Russian OCR; ISO designations always select English, including server-side validation and mixed batches.
- Hide intermediate candidates and diagnostics from the ordinary interface and API. Keep edition selection, manual access checks, document navigation and completed PDF downloads available.
- Add password-protected developer sessions with a salted password hash, login attempt limits and explicit sign-out. Developer mode is opened with Ctrl+Shift+D; URL parameters do not grant access.

- Rebrand the local interface as DecliPDF with a new wordmark and icon, source-neutral messages and a document-number-first workflow.
- Remove provider links from ordinary result screens, neutralize legacy display messages without changing recovery identifiers, and keep the URL input in the authenticated developer view.
- Set DecliPDF as the creator of new PDFs and the name of batch download reports.

## 1.9.0

- Bring the full document workflow to GitHub Pages using the shared local interface and ISO/search verification logic.
- Add bounded extension services for official ISO catalogue data and Doc88 search, edition history, exact official filenames, supplements and page extent checks.
- Run image preparation, searchable PDF generation, hierarchical outlines and normative-reference extraction in the browser.
- Persist downloaded images, page OCR caches, jobs and batches in IndexedDB; acknowledge images only after storage and verify hashes when resuming.
- Add browser queues, page ranges, ZIP exports with reports and safe recovery after reloading a capture tab.
- Relay manual Doc88 challenge images and user pointer events through the extension; validate ownership, addresses, tokens and coordinates, and coalesce queued moves.
- Require extension 1.9 with explicit ISO, scripting and debugger permissions; keep ZIP conversion available without the extension.
- Verify the full browser workflow in an isolated Chromium profile, including synthetic manual challenge control and resumable OCR.

## 1.8.0

- Upscale small or soft scans locally before OCR with bounded dimensions and mild sharpening; preserve original ZIP images and physical PDF page geometry.
- Add a persistent preparation toggle and include its setting in OCR cache identities.
- Build a nested document structure from body headings, appendices and bibliography, store it as hierarchical PDF outlines, and show clickable navigation in the app.
- Extract normative references only from their section, preserve dated references, flag series/incomplete OCR, and queue selected references.
- Read amendments/corrigenda from the exact ISO edition, show official links, and search supplements as separate documents with their own title and page count.
- Treat uncertain language as a review note rather than a rejection; continue rejecting clearly foreign body text.
- Include the new processing modules in the cloud deployment build context and its verification triggers.

## 1.7.0

- Detect repeated nonblank images and strong gaps or swaps in OCR page numbering; keep ambiguous numbering visible for manual review.
- Save each downloaded image immediately, validate checkpoint hashes on recovery, and assemble the image ZIP locally using the upstream capture functions.
- Cache validated per-page OCR PDFs and text; recognize only missing or damaged pages after a restart or cancellation.
- Add individual resume controls and restore interrupted work without automatically restarting downloads.
- Add normalized, deduplicated lists of up to 30 standards, a serialized queue, independent edition choices, queue cancellation/resumption and a ZIP of ready PDFs with a status report.

## 1.6.1

- Normalize bare ISO references on field blur and before submission, including `iso 5458 2013` and `iso 5458-2013` to `ISO 5458:2013`.
- Share the formatter between browser and server; preserve explicitly entered years, part numbers, free-text queries and amendment suffixes.
- Continue catalogue validation and edition selection after formatting, and retain candidate rechecks from older histories with unformatted queries.

## 1.6.0

- Offer an edition picker when an explicitly requested ISO year is absent from the verified lifecycle history.
- Traverse previous editions and related historical designations, show published/withdrawn status and official catalogue links, and exclude amendments and projects.
- Wait for an explicit choice before searching Doc88; resume using the chosen reference, title and page count.
- Preserve pending choices across restarts and support cancellation; partial catalogue failures do not claim that a version never existed.
- Validate selections against saved catalogue choices and serialize competing resume requests.

## 1.5.1

- Read the exact edition's page count from the English ISO catalogue and reject shorter uploads before downloading or OCR.
- Keep shortened uploads out of the three-candidate processing budget; continue with eligible results.
- Check the actual downloaded count again and allow covers/front matter above the catalogue minimum.
- Leave ISO extent unconfirmed when the official count is unavailable; show catalogue/PDF counts and rejection reasons in the UI.
- Mark historical ISO results without this check as needing a new search.

## 1.5.0

- Restrict ISO search results to international ISO documents and reject national designations on the cover.
- Read full English catalogue titles for current and explicitly requested editions without changing the user's year.
- Name searchable PDFs with the full official title, portable filename punctuation, and no OCR suffix; retain the full title in PDF metadata.
- Encode UTF-8 download filenames correctly, including parentheses and apostrophes.

## 1.4.0

- Resolve yearless ISO references through the official ISO catalogue before searching Doc88.
- Select the exact published standard and part; ignore drafts, withdrawn entries, amendments and review dates.
- Show the resolved edition, official source link and verification date, and preserve explicit user years.
- Rechecking a candidate retains the resolved edition; an unavailable catalogue cannot silently select an arbitrary year.

## 1.3.1

- Show Doc88's manual challenge in a live panel beside the local conversion result.
- Relay mouse and touch drags to the background browser; resume and hide the panel after confirmation.
- Restrict controls to the active document challenge, validate coordinates and session tokens, and release the pointer when a challenge closes.
- No separate browser window, challenge solver, HTML proxy, or persisted challenge screenshots.

## 1.3.0

- Local document search with exact ISO part/year matching and PDF-first results.
- Verify English body text after OCR, excluding repeated headers and footers; uncertain language stays unconfirmed.
- Verify that all Doc88-declared pages were downloaded and included in the searchable PDF.
- Show source links, individual verification evidence, and a ready PDF without downloading the document again.
- Recognize a CAPTCHA before the first page and wait for manual confirmation in the local browser.

## 1.2.0

- Free browser converter on GitHub Pages, with same-origin OCR assets and an English model pinned by SHA-256.
- Chrome/Edge extension adds an OCR PDF button directly to Doc88; page images transfer automatically without downloading and uploading a ZIP.
- Browser OCR creates a searchable PDF and starts its download; the original page images can also be saved in ZIP.
- Cancellation, progress, manual CAPTCHA handling, ordered page checks, and bounded browser memory use.
- Existing local application remains available for page ranges, history, and larger documents.

## 1.1.0

- Standalone Node.js installation with a lockfile, Windows setup and launch shortcuts.
- Local English OCR using either installed Tesseract or a cached WebAssembly model.
- Cancellation works during WebAssembly worker initialization and recognition.
- Simultaneous requests cannot start competing jobs.
- Job history is written atomically.
- Windows and Linux checks in GitHub Actions.
- Release ZIP packaging and project documentation.

## 1.0.0

- Download a Doc88 document through the original downloader in a separate browser window.
- Convert its image ZIP into a searchable PDF while preserving page images.
- Upload an existing ZIP, select a page range, view progress and retain local history.
