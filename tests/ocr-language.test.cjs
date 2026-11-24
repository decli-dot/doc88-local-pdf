const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const sharp = require('sharp');
const JSZip = require('jszip');
const { PDFDocument } = require('pdf-lib');
const { resolve } = require('../dist/ocr-language.js');
const { analyseTextPages } = require('../search.cjs');
const { convertArchive } = require('../pipeline.cjs');
const samples = {
  fra: 'Ce document présente les exigences relatives à la mesure des pièces et à leur fabrication. Les caractéristiques sont définies dans le système de référence choisi. Chaque mesure doit être effectuée avec un instrument approprié et les résultats doivent être enregistrés dans un rapport. La méthode utilisée pour déterminer une caractéristique doit être indiquée dans les instructions. Les exemples suivants décrivent les principes de cette procédure et les conditions nécessaires pour obtenir des résultats fiables. Il convient de vérifier les équipements avant de commencer les opérations.',
  deu: 'Dieses Dokument beschreibt die Anforderungen an die Messung der Teile. Die Ergebnisse werden in einem Bericht aufgezeichnet. Das Verfahren ist für die Prüfung von Werkstücken bestimmt. Der Bediener muss die Geräte vor der Messung prüfen. Die folgenden Beispiele zeigen die Anwendung der Regeln und die Bewertung der Ergebnisse. Für jedes Teil sind die Anforderungen und die verwendeten Verfahren anzugeben. Diese Angaben sind mit den Ergebnissen zu vergleichen und in dem Bericht zu dokumentieren.',
  rus: 'Этот документ устанавливает требования к измерению деталей. Результаты измерений должны быть указаны в протоколе. Для каждого изделия необходимо выбрать метод проверки и оборудование. Перед выполнением измерений следует проверить состояние оборудования. Приведённые примеры показывают применение правил и оценку результатов. Все требования к деталям должны быть определены на чертеже. При выполнении проверки необходимо учитывать условия измерения и требования к точности. Результаты следует сравнить с установленными значениями.',
};
test('ISO always selects English; German and Russian prose are checked against the selected language', async () => {
  for (const query of ['iso 5458', 'ISO5458', 'ISO/IEC 27001', 'ASME Y14.6', 'BS EN ISO 129-1'])
    assert.equal(resolve(query, 'rus'), 'eng');
  assert.equal(resolve('DIN 1234', 'deu'), 'eng+deu');
  assert.equal(resolve('ГОСТ 2.307', 'rus'), 'rus');
  assert.equal(resolve('DIN EN ISO 129-1', 'eng'), 'eng+deu');
  assert.equal(resolve('NF EN ISO 129-1', 'eng'), 'eng+fra');
  assert.throws(() => resolve('', '../../model'));
  for (const [language, text] of Object.entries(samples)) {
    const result = await analyseTextPages([text], language);
    assert.equal(result.status, 'passed');
    assert.equal(result.ocrLanguage, language);
    assert.equal(result.matchedPages, 1);
    const foreign = await analyseTextPages(
      [text, text + ' Дополнение.'],
      language === 'deu' ? 'rus' : 'deu',
    );
    assert.notEqual(foreign.status, 'passed');
  }
});

test('real French, German and Russian OCR produce searchable PDFs, national policies use combined models, and caches stay isolated', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'declipdf-language-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('declipdf-language-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  for (const [language, text] of Object.entries(samples)) {
    const jobDir = path.join(directory, language);
    await fs.mkdir(jobDir);
    const words = text.split(' '),
      lines = [];
    let line = '';
    for (const word of words) {
      if ((line + word).length > 62) {
        lines.push(line);
        line = '';
      }
      line += word + ' ';
    }
    if (line) lines.push(line);
    const svg = `<svg width="1600" height="1400" xmlns="http://www.w3.org/2000/svg"><rect width="1600" height="1400" fill="white"/><g fill="black" font-family="Arial" font-size="38">${lines.map((line, index) => `<text x="70" y="${100 + index * 65}">${line}</text>`).join('')}</g></svg>`;
    const image = await sharp(Buffer.from(svg)).png().toBuffer();
    const zip = new JSZip();
    zip.file('page001.png', image);
    await fs.writeFile(
      path.join(jobDir, 'archive.zip'),
      await zip.generateAsync({ type: 'nodebuffer' }),
    );
    const job = {
      directory: jobDir,
      cacheDirectory: process.env.DOC88_OCR_CACHE,
      ocrLanguage: language,
      ...(language === 'fra' ? { query: 'NF EN ISO 99999', enforceScript: true } : {}),
      title: 'Language test',
      enhanceImages: false,
      controller: new AbortController(),
      update(value) {
        Object.assign(this, value);
      },
      log() {},
    };
    await convertArchive(job);
    assert.equal(job.stage, 'done');
    const recognized = await fs.readFile(path.join(jobDir, 'ocr/page00001.txt'), 'utf8');
    assert.match(
      recognized,
      language === 'deu'
        ? /Anforderungen.*Messung/s
        : language === 'fra'
          ? /exigences.*mesure/s
          : /требования.*измерению/s,
    );
    assert.equal(
      (await PDFDocument.load(await fs.readFile(path.join(jobDir, 'result.pdf')))).getPageCount(),
      1,
    );
    assert.equal((await analyseTextPages([recognized], language)).status, 'passed');
    const recordPath = path.join(jobDir, 'ocr/page00001.json');
    const before = JSON.parse(await fs.readFile(recordPath, 'utf8'));
    assert.ok(before.engine.includes('-' + resolve(job.query, language) + '-'));
    await convertArchive(job);
    assert.equal(job.reusedOCRPages, 1);
    if (language === 'deu') {
      job.ocrLanguage = 'eng';
      await convertArchive(job);
      assert.equal(job.reusedOCRPages, 0);
      assert.ok(JSON.parse(await fs.readFile(recordPath, 'utf8')).engine.includes('-eng-'));
    }
  }
});
