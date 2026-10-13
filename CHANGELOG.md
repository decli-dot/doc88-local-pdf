# Changelog

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
