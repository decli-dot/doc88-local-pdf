FROM node:24-bookworm-slim
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright DOC88_OCR_ENGINE=native OMP_THREAD_LIMIT=1 NODE_OPTIONS=--max-old-space-size=160 PORT=10000
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force \
    && npx playwright install --with-deps chromium \
    && apt-get update && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng \
    && rm -rf /var/lib/apt/lists/* \
    && chmod -R a+rX /ms-playwright
COPY cloud-server.cjs pipeline.cjs runtime.cjs LICENSE ./
COPY cloud ./cloud
COPY web/style.css ./web/style.css
COPY dist/icon.svg ./dist/icon.svg
COPY vendor ./vendor
RUN mkdir -p /app/.data && chown -R node:node /app/.data
USER node
EXPOSE 10000
CMD ["node", "cloud-server.cjs"]
