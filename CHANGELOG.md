# Changelog

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
