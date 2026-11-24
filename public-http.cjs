'use strict';
const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');
function publicAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (!net.isIPv6(address)) return false;
  const value = address.toLowerCase();
  if (value.startsWith('::ffff:')) return publicAddress(value.slice(7));
  return /^[23]/.test(value) && !value.startsWith('2001:db8');
}
function webURL(value, hosts) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    url.hostname === 'localhost' ||
    net.isIP(url.hostname.replace(/[\[\]]/g, '')) ||
    (hosts && !hosts.some((host) => url.hostname === host || url.hostname.endsWith('.' + host)))
  )
    throw Error('Недопустимый адрес источника.');
  return url;
}
async function requestPublic(
  value,
  {
    signal,
    maxBytes = 6 * 1024 * 1024,
    hosts,
    method = 'GET',
    body,
    headers = {},
    redirects = 4,
    timeoutMs = 20000,
  } = {},
) {
  const url = webURL(value, hosts);
  const combined = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]);
  const result = await new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method,
        signal: combined,
        headers: {
          'User-Agent': 'DecliPDF/1.9 (+local standards search)',
          Accept: '*/*',
          'Accept-Encoding': 'identity',
          ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
          ...headers,
        },
        lookup(host, options, callback) {
          dns.lookup(host, { all: true, family: 4 }, (error, addresses) => {
            if (error) return callback(error);
            if (!addresses.length || addresses.some((item) => !publicAddress(item.address)))
              return callback(Error('Private network addresses are not allowed.'));
            if (options.all) callback(null, addresses);
            else callback(null, addresses[0].address, addresses[0].family);
          });
        },
      },
      (response) => {
        const chunks = [];
        const responseLimit = /(?:text\/|application\/json)/i.test(
          response.headers['content-type'] || '',
        )
          ? Math.min(maxBytes, 6 * 1024 * 1024)
          : maxBytes;
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > responseLimit)
            response.destroy(Error('Источник вернул слишком большой файл.'));
          else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            bytes: Buffer.concat(chunks),
            url: url.href,
          }),
        );
      },
    );
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
  if ([301, 302, 303, 307, 308].includes(result.status) && result.headers.location) {
    if (!redirects) throw Error('Слишком много перенаправлений источника.');
    return requestPublic(new URL(result.headers.location, url).href, {
      signal: combined,
      maxBytes,
      hosts,
      timeoutMs,
      redirects: redirects - 1,
    });
  }
  if (result.status < 200 || result.status >= 300)
    throw Object.assign(Error(`Источник недоступен: HTTP ${result.status}.`), {
      code: 'SOURCE_HTTP_ERROR',
      status: result.status,
      retryAfter: result.headers['retry-after'],
    });
  return result;
}
module.exports = { publicAddress, webURL, requestPublic };
