'use strict';
function join(...parts) {
  const output = [];
  for (const part of parts)
    for (const value of String(part || '').split('/')) {
      if (value === '..') output.pop();
      else if (value && value !== '.') output.push(value);
    }
  return '/' + output.join('/');
}
module.exports = {
  join,
  resolve: join,
  basename: (value) => String(value).split('/').at(-1),
  dirname: (value) => String(value).slice(0, String(value).lastIndexOf('/')),
  sep: '/',
};
