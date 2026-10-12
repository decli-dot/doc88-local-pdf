# Contributing

Use Node.js 22 or newer (24 LTS recommended), run `npm ci`, and keep changes focused.

Before opening a pull request:

```sh
npm run check
npm run format:check
npm test
```

Prefer tests that verify user-visible behavior. Do not commit `.data/`, browser profiles, downloaded documents, OCR models, release archives or local logs.

Keep `vendor/downloadPages.js` unchanged unless intentionally updating the upstream snapshot. Retain its license when updating it.

When reporting a downloader issue, include the application version, OS, browser, stage at which it failed, and a public document URL if one can be shared. Remove personal information from logs and screenshots.
