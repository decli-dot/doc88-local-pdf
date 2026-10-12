# Changelog

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
