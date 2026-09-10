# syntax=docker/dockerfile:1
# Node 24 is Active LTS as of 2026; Alpine keeps the image small.

FROM node:24-alpine AS base

RUN apk add --no-cache python3 py3-pip && \
    python3 -m venv /opt/venv && \
    rm -rf /var/cache/apk/*

RUN . /opt/venv/bin/activate && \
    pip install --no-cache-dir apprise && \
    find /opt/venv -type d -name "__pycache__" -exec rm -r {} +

ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /app

FROM base AS deps

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM deps AS development
ENV NODE_ENV=development

RUN npm install && npm cache clean --force

RUN mkdir -p /app/uploads

COPY src/ ./src/
COPY public/ ./public/
COPY test/ ./test/
COPY eslint.config.js ./

EXPOSE 3000

CMD ["npm", "run", "dev"]

FROM deps AS production
ENV NODE_ENV=production
ENV UPLOAD_DIR=/app/uploads

RUN mkdir -p /app/uploads && chown -R node:node /app

COPY --chown=node:node src/ ./src/
COPY --chown=node:node public/ ./public/

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
