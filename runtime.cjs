'use strict';
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

function dependency(name) {
  try {
    return require(name);
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    throw new Error(`Не найдена библиотека ${name}. Выполни npm ci или запусти Setup.cmd.`);
  }
}

function nativeOCR() {
  const engine = process.env.DOC88_OCR_ENGINE || 'auto';
  if (!['auto', 'native', 'wasm'].includes(engine))
    throw new Error('DOC88_OCR_ENGINE должен быть auto, native или wasm.');
  if (engine === 'wasm') return null;
  const candidates = [
    process.env.DOC88_TESSERACT,
    'C:/Program Files/Tesseract-OCR/tesseract.exe',
    'tesseract',
  ].filter(Boolean);
  for (const executable of candidates) {
    const probe = spawnSync(executable, ['--list-langs'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000,
    });
    if (probe.status === 0 && /^eng\s*$/m.test(probe.stdout || '')) return executable;
  }
  if (engine === 'native')
    throw new Error(
      'Не найден Tesseract с английской моделью. Установи Tesseract или выбери DOC88_OCR_ENGINE=wasm.',
    );
  return null;
}

function browserChannel() {
  if (process.env.DOC88_BROWSER_CHANNEL) {
    if (!['chrome', 'msedge', 'chromium'].includes(process.env.DOC88_BROWSER_CHANNEL))
      throw new Error('DOC88_BROWSER_CHANNEL должен быть chrome, msedge или chromium.');
    return process.env.DOC88_BROWSER_CHANNEL === 'chromium'
      ? undefined
      : process.env.DOC88_BROWSER_CHANNEL;
  }
  if (process.platform !== 'win32') return undefined;
  if (
    fs.existsSync('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe') ||
    fs.existsSync('C:/Program Files/Microsoft/Edge/Application/msedge.exe')
  )
    return 'msedge';
  if (
    fs.existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe') ||
    fs.existsSync('C:/Program Files (x86)/Google/Chrome/Application/chrome.exe')
  )
    return 'chrome';
  return undefined;
}

module.exports = { dependency, nativeOCR, browserChannel };
