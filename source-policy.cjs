'use strict';
const DEFAULT = 'doc88-first';
const orders = {
  'doc88-first': ['doc88', 'anna'],
  'anna-first': ['anna', 'doc88'],
  'doc88-only': ['doc88'],
  'anna-only': ['anna'],
};
function validatePolicy(value = DEFAULT) {
  if (typeof value !== 'string' || !Object.hasOwn(orders, value))
    throw Error('Выберите источники из списка.');
  return value;
}
function requestedPolicy(value, isDev) {
  const policy = validatePolicy(value);
  if (!isDev && policy !== DEFAULT)
    throw Object.assign(Error('Выбор источников доступен в dev-режиме.'), { status: 403 });
  return policy;
}
function providersFor(value) {
  return [...orders[validatePolicy(value)]];
}
module.exports = { DEFAULT, validatePolicy, requestedPolicy, providersFor };
