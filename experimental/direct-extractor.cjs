'use strict';
// Independent experimental transport. Reads only the page list supplied to the
// public viewer; never scans for hidden pages or solves access challenges.
const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const { PDFDocument, PDFRawStream, PDFDict, PDFArray, PDFRef } = require('pdf-lib');
const { browserChannel } = require('../runtime.cjs');
const { webURL } = require('../public-http.cjs');
const { atomicWrite } = require('../checkpoints.cjs');

const standardAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const alphabets = {
  metadata: 'PJLKMNOI3xyz021wvrpqstouHCFBDEGAnhikjlmgfZbacedYRXTSUVQW!56789+4',
  resource: 'PJKLMNOI3xyz012wvprqstuoHBCDEFGAnhijklmgfZabcdeYXRSTUVWQ!56789+4',
};
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
function decode(value, alphabet = alphabets.metadata) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9!+=/]*$/.test(value))
    throw Error('Invalid viewer metadata encoding.');
  return Buffer.from(
    [...value]
      .map((c) => (alphabet.includes(c) ? standardAlphabet[alphabet.indexOf(c)] : c))
      .join(''),
    'base64',
  ).toString('utf8');
}
function encode(value) {
  return [...Buffer.from(value).toString('base64')]
    .map((c) =>
      standardAlphabet.includes(c) ? alphabets.resource[standardAlphabet.indexOf(c)] : c,
    )
    .join('');
}
function configuration(html, sourceURL) {
  const match = html.match(/m_main\s*\.\s*init\(\s*"([^"]+)"/);
  if (!match)
    throw Object.assign(
      Error('Данные просмотра недоступны. Возможно, требуется ручное подтверждение доступа.'),
      {
        code: 'ACCESS_REQUIRED',
      },
    );
  const raw = JSON.parse(decode(match[1]));
  const code = new URL(sourceURL).pathname.match(/^\/p-(\d+)\.html$/)?.[1];
  if (!code || String(raw.p_code) !== code) throw Error('Document identity mismatch.');
  const host = webURL(raw.ebt_host, ['doc88.com']).origin;
  const headers = String(raw.headerInfo).replace(/"/g, '').split(',');
  if (!headers.length || headers.some((v) => !/^\d+$/.test(v)))
    throw Error('Invalid resource groups.');
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(raw.p_swf))
    throw Error('Invalid document resource identifier.');
  const pages = decode(raw.pageInfo)
    .split(',')
    .map((value, i) => {
      if (!/^\d+(?:-\d+){4}$/.test(value)) throw Error('Invalid page metadata.');
      const [group, width, height, offset, size] = value.split('-').map(Number);
      if (
        group < 1 ||
        group > headers.length ||
        width < 1 ||
        height < 1 ||
        width > 20000 ||
        height > 20000 ||
        size < 1
      )
        throw Error('Page dimensions or resource group are out of range.');
      return { number: i + 1, group, width, height, offset, size };
    });
  const total = Number(raw.p_pagecount);
  if (!Number.isSafeInteger(total) || total < 1 || total > 2000)
    throw Error('Invalid document extent.');
  if (pages.length !== total || Number(raw.pageCount) !== total || raw.part_read === '1')
    throw Error(`В просмотре доступны не все страницы: ${pages.length} из ${total}.`);
  return {
    version: 1,
    sourceURL,
    code,
    title: String(raw.p_name),
    host,
    total,
    pages,
    headerURLs: headers.map(
      (offset, i) => `${host}/getebt-${encode(`${i + 1}-0-${offset}-${raw.p_swf}`)}.ebt`,
    ),
    pageURLs: pages.map(
      (p) =>
        `${host}/getebt-${encode(`${p.group}-${p.offset}-${p.size}-${raw.p_swf}-${p.number}-${code}`)}.ebt`,
    ),
  };
}
async function mapLimit(items, concurrency, action, signal) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16)
    throw Error('Invalid concurrency.');
  let next = 0,
    failure;
  const values = new Array(items.length);
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async (_, worker) => {
      while (!failure) {
        const index = next++;
        if (index >= items.length) return;
        try {
          signal?.throwIfAborted();
          values[index] = await action(items[index], index, worker);
        } catch (error) {
          failure ||= error;
        }
      }
    }),
  );
  if (failure) throw failure;
  return values;
}
function rectBytes(width, height) {
  const values = [0, Math.round(width * 20), 0, Math.round(height * 20)];
  const count = Math.max(...values.map((v) => Math.floor(Math.log2(Math.max(v, 1))) + 2));
  const bytes = Buffer.alloc(Math.ceil((5 + count * 4) / 8));
  let position = 0;
  function put(value, bits) {
    for (let i = bits - 1; i >= 0; i--, position++)
      bytes[position >> 3] |= ((value >>> i) & 1) << (7 - (position & 7));
  }
  put(count, 5);
  for (const value of values) put(value, count);
  return bytes;
}
function assemblePage(header, resource, page) {
  // EBT's compressed streams contain a standard SWF dictionary and page tags.
  if (header.length < 42 || resource.length < 34) throw Error('Truncated EBT resource.');
  const dictionary = zlib.inflateSync(header.subarray(40), { maxOutputLength: 32 * 1024 * 1024 });
  const drawing = zlib.inflateSync(resource.subarray(32), { maxOutputLength: 32 * 1024 * 1024 });
  if (dictionary.toString('ascii', 0, 3) !== 'FWS') throw Error('Unsupported EBT dictionary.');
  const oldRectLength = Math.ceil((5 + (dictionary[8] >> 3) * 4) / 8);
  if (dictionary.length < 8 + oldRectLength + 4) throw Error('Truncated SWF header.');
  const rateAndCount = Buffer.from(dictionary.subarray(8 + oldRectLength, 12 + oldRectLength));
  rateAndCount.writeUInt16LE(1, 2);
  const result = Buffer.concat([
    dictionary.subarray(0, 8),
    rectBytes(page.width, page.height),
    rateAndCount,
    dictionary.subarray(12 + oldRectLength),
    drawing,
    Buffer.from([0x40, 0, 0, 0]),
  ]);
  result.writeUInt32LE(result.length, 4);
  validateSWF(result);
  normalizeBlankGlyphs(result);
  return result;
}
function normalizeBlankGlyphs(bytes) {
  // Some viewer dictionaries encode a blank glyph as U+0009. FFDec exports
  // that control character as a visible box. Rename it only when its exact
  // outline matches a real U+0020 glyph in this same dictionary. Glyph indexes,
  // advances and drawing positions remain unchanged; no visible shape is lost.
  const fonts = [];
  let offset = 12 + Math.ceil((5 + (bytes[8] >> 3) * 4) / 8);
  while (offset + 2 <= bytes.length) {
    const tag = bytes.readUInt16LE(offset);
    offset += 2;
    let length = tag & 63;
    if (length === 63) {
      length = bytes.readUInt32LE(offset);
      offset += 4;
    }
    if (tag >> 6 === 48 || tag >> 6 === 75) {
      const data = bytes.subarray(offset, offset + length);
      if (data.length < 7 + data[4]) throw Error('Truncated font metadata.');
      const flags = data[2],
        count = data.readUInt16LE(5 + data[4]);
      const start = 7 + data[4],
        size = flags & 8 ? 4 : 2,
        codeSize = flags & 4 ? 2 : 1;
      if (start + (count + 1) * size > data.length) throw Error('Truncated font offsets.');
      const read = (position) =>
        size === 4 ? data.readUInt32LE(position) : data.readUInt16LE(position);
      const codes = start + read(start + count * size);
      if (codes < start + (count + 1) * size || codes + count * codeSize > data.length)
        throw Error('Invalid font code table.');
      const glyphs = [];
      for (let i = 0; i < count; i++) {
        const a = start + read(start + i * size),
          b = i + 1 < count ? start + read(start + (i + 1) * size) : codes;
        if (a < start + (count + 1) * size || b < a || b > codes)
          throw Error('Invalid font glyph offsets.');
        const position = codes + i * codeSize;
        glyphs.push({
          code: codeSize === 2 ? data.readUInt16LE(position) : data[position],
          shape: data.subarray(a, b).toString('hex'),
          position,
        });
      }
      fonts.push({ data, codeSize, glyphs });
    }
    offset += length;
    if (tag >> 6 === 0) break;
  }
  const blanks = new Set(
    fonts.flatMap((font) => font.glyphs.filter((g) => g.code === 32).map((g) => g.shape)),
  );
  let changed = 0;
  for (const font of fonts) {
    if (font.glyphs.some((g) => g.code === 32)) continue;
    for (let i = 0; i < font.glyphs.length; i++) {
      const glyph = font.glyphs[i];
      if (glyph.code !== 9 || !blanks.has(glyph.shape)) continue;
      if (font.codeSize === 2) font.data.writeUInt16LE(32, glyph.position);
      else font.data[glyph.position] = 32;
      changed++;
    }
  }
  return changed;
}
function validateSWF(bytes) {
  if (
    bytes.length < 16 ||
    bytes.toString('ascii', 0, 3) !== 'FWS' ||
    bytes.readUInt32LE(4) !== bytes.length
  )
    throw Error('Invalid SWF output.');
  const rect = Math.ceil((5 + (bytes[8] >> 3) * 4) / 8);
  let offset = 8 + rect + 4,
    frames = 0,
    ended = false;
  while (offset + 2 <= bytes.length) {
    const tag = bytes.readUInt16LE(offset);
    offset += 2;
    const type = tag >> 6;
    let size = tag & 63;
    if (size === 63) {
      if (offset + 4 > bytes.length) throw Error('Truncated SWF tag.');
      size = bytes.readUInt32LE(offset);
      offset += 4;
    }
    if (offset + size > bytes.length) throw Error('Truncated SWF drawing.');
    offset += size;
    if (type === 1) frames++;
    if (type === 0) {
      ended = true;
      break;
    }
  }
  if (!ended || !frames || offset !== bytes.length) throw Error('Incomplete SWF page.');
  return { frames };
}
async function openViewer(sourceURL, directory, signal) {
  const url = webURL(sourceURL, ['doc88.com']);
  if (!/^\/p-\d+\.html$/.test(url.pathname)) throw Error('Invalid document URL.');
  const context = await chromium.launchPersistentContext(path.join(directory, 'browser'), {
    headless: true,
    channel: browserChannel(),
    viewport: { width: 1280, height: 1000 },
  });
  const stop = () => {
    void context.close().catch(() => {});
  };
  signal.addEventListener('abort', stop, { once: true });
  try {
    signal.throwIfAborted();
    // The configuration is in the HTML. Do not start the old viewer renderer.
    await context.route('**/*', (route) =>
      ['script', 'image', 'font', 'media'].includes(route.request().resourceType())
        ? route.abort()
        : route.continue(),
    );
    const page = context.pages()[0] || (await context.newPage());
    const response = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (!response?.ok()) throw Error(`Document page returned HTTP ${response?.status()}.`);
    const config = configuration(await page.content(), url.href);
    const cdp = await context.newCDPSession(page);
    return {
      config,
      async once(resourceURL) {
        webURL(resourceURL, ['doc88.com']);
        signal.throwIfAborted();
        const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
          expression: `(async()=>{const r=await fetch(${JSON.stringify(resourceURL)}, {signal:AbortSignal.timeout(30000),cache:'no-store'});if(!r.ok)throw Error('Resource HTTP '+r.status);const b=new Uint8Array(await r.arrayBuffer());if(b.length>16*1024*1024)throw Error('Resource too large');let s='';for(let i=0;i<b.length;i+=16384)s+=String.fromCharCode(...b.subarray(i,i+16384));return btoa(s)})()`,
          awaitPromise: true,
          returnByValue: true,
        });
        if (exceptionDetails || typeof result.value !== 'string')
          throw Error(
            exceptionDetails?.exception?.description?.split('\n')[0] || 'Resource read failed.',
          );
        return Buffer.from(result.value, 'base64');
      },
      async close() {
        signal.removeEventListener('abort', stop);
        await context.close();
      },
    };
  } catch (error) {
    signal.removeEventListener('abort', stop);
    await context.close();
    throw error;
  }
}
async function downloadDirect(
  sourceURL,
  directory,
  { concurrency = 6, signal, onProgress = () => {}, previewPages, resourceDirectory } = {},
) {
  signal ||= new AbortController().signal;
  await fs.mkdir(path.join(directory, 'swf'), { recursive: true });
  const started = performance.now();
  const viewer = await openViewer(sourceURL, directory, signal);
  try {
    const config = viewer.config;
    const selectedPages = previewPages
      ? config.pages.slice(0, Math.min(previewPages, config.total))
      : config.pages;
    if (
      previewPages &&
      (!Number.isSafeInteger(previewPages) || previewPages < 1 || previewPages > 12)
    )
      throw Error('Invalid preview page limit.');
    if (resourceDirectory) await fs.mkdir(resourceDirectory, { recursive: true });
    const bootstrapMs = performance.now() - started;
    await atomicWrite(path.join(directory, 'configuration.json'), JSON.stringify(config, null, 2));
    // One dictionary per group; pages are downloaded in a bounded pool.
    let retries = 0;
    const bytesFor = async (url) => {
      const cachedFile =
        resourceDirectory && path.join(resourceDirectory, hash(Buffer.from(url)) + '.ebt');
      if (cachedFile) {
        try {
          const bytes = await fs.readFile(cachedFile);
          const checksum = await fs.readFile(cachedFile + '.sha256', 'utf8');
          if (bytes.length <= 16 * 1024 * 1024 && hash(bytes) === checksum) return bytes;
        } catch {
          /* Re-fetch incomplete resources. */
        }
      }
      for (let attempt = 0; ; attempt++) {
        try {
          const bytes = await viewer.once(url);
          if (cachedFile) {
            await atomicWrite(cachedFile, bytes);
            await atomicWrite(cachedFile + '.sha256', hash(bytes));
          }
          return bytes;
        } catch (error) {
          signal.throwIfAborted();
          // Do not retry denied access or other HTTP errors as if they were
          // transient network failures. No alternative host or proxy is used.
          if (attempt >= 2 || !/Failed to fetch|TimeoutError|NetworkError/.test(error.message))
            throw error;
          retries++;
        }
      }
    };
    const headers = await mapLimit(config.headerURLs, concurrency, bytesFor, signal);
    let completed = 0,
      downloadedBytes = headers.reduce((n, b) => n + b.length, 0);
    const manifest = await mapLimit(
      selectedPages,
      concurrency,
      async (page, index) => {
        const bytes = await bytesFor(config.pageURLs[index]);
        downloadedBytes += bytes.length;
        if (downloadedBytes > 250 * 1024 * 1024) throw Error('Document resources exceed 250 MB.');
        const swf = assemblePage(headers[page.group - 1], bytes, page);
        const filename = `page${String(page.number).padStart(5, '0')}.swf`;
        await atomicWrite(path.join(directory, 'swf', filename), swf);
        onProgress({ stage: 'download', current: ++completed, total: selectedPages.length });
        return {
          page: page.number,
          filename,
          sha256: hash(swf),
          bytes: swf.length,
          width: page.width,
          height: page.height,
        };
      },
      signal,
    );
    const report = {
      version: 1,
      decoderVersion: 2,
      sourceURL,
      total: selectedPages.length,
      declaredTotal: config.total,
      preview: Boolean(previewPages),
      bootstrapMs,
      downloadMs: performance.now() - started - bootstrapMs,
      downloadedBytes,
      retries,
      pages: manifest,
    };
    await atomicWrite(
      path.join(directory, 'download-report.json'),
      JSON.stringify(report, null, 2),
    );
    return report;
  } finally {
    await viewer.close();
  }
}
function deduplicateStreams(pdf) {
  const canonical = new Map(),
    aliases = new Map();
  const objects = pdf.context.enumerateIndirectObjects();
  for (const [ref, object] of objects) {
    if (!(object instanceof PDFRawStream)) continue;
    // Include the entire stream dictionary: equal bytes alone are not enough
    // when filters, colour spaces or decoding parameters differ.
    const key = hash(Buffer.concat([Buffer.from(object.dict.toString()), object.getContents()]));
    if (canonical.has(key)) aliases.set(ref.toString(), canonical.get(key));
    else canonical.set(key, ref);
  }
  const visited = new Set();
  function visit(object) {
    if (!object || visited.has(object)) return;
    visited.add(object);
    if (object instanceof PDFRawStream) visit(object.dict);
    else if (object instanceof PDFDict) {
      for (const [key, value] of object.entries()) {
        if (value instanceof PDFRef && aliases.has(value.toString()))
          object.set(key, aliases.get(value.toString()));
        else visit(value);
      }
    } else if (object instanceof PDFArray) {
      for (let i = 0; i < object.size(); i++) {
        const value = object.get(i);
        if (value instanceof PDFRef && aliases.has(value.toString()))
          object.set(i, aliases.get(value.toString()));
        else visit(value);
      }
    }
  }
  for (const [, object] of objects) visit(object);
  for (const [ref] of objects) if (aliases.has(ref.toString())) pdf.context.delete(ref);
  return aliases.size;
}
async function mergeExport(directory, total, output) {
  const pdf = await PDFDocument.create();
  for (let number = 1; number <= total; number++) {
    const name = `page${String(number).padStart(5, '0')}`;
    const file = path.join(directory, name + '.swf', 'frames.pdf');
    const source = await PDFDocument.load(await fs.readFile(file), { parseSpeed: 1500 });
    if (source.getPageCount() !== 1)
      throw Error(`Page ${number}: converter did not produce exactly one page.`);
    const [page] = await pdf.copyPages(source, [0]);
    pdf.addPage(page);
  }
  pdf.setCreator('DecliPDF experimental direct extractor');
  deduplicateStreams(pdf);
  await atomicWrite(output, await pdf.save({ objectsPerTick: 1500 }));
}
module.exports = {
  configuration,
  decode,
  encode,
  rectBytes,
  assemblePage,
  validateSWF,
  normalizeBlankGlyphs,
  mapLimit,
  downloadDirect,
  mergeExport,
  deduplicateStreams,
};
