module.exports = {
  createReadStream() {
    throw Error('Потоки Node.js недоступны в браузере.');
  },
};
