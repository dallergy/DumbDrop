# syntax=docker/dockerfile:1
# Node 24 is Active LTS as of 2026; Alpine keeps the image small.

ARG NODE_IMAGE=node:24-alpine

# ---- Apprise (notifications) lives in its own venv, built here so pip never
# ---- reaches the runtime image.
FROM ${NODE_IMAGE} AS apprise
RUN apk add --no-cache python3 py3-pip && \
    python3 -m venv /opt/venv && \
    /opt/venv/bin/pip install --no-cache-dir --upgrade pip && \
    /opt/venv/bin/pip install --no-cache-dir apprise && \
    /opt/venv/bin/pip uninstall -y pip && \
    find /opt/venv -type d -name "__pycache__" -prune -exec rm -rf {} +

# ---- Shared runtime base: patched OS packages plus the Python interpreter.
FROM ${NODE_IMAGE} AS base
RUN apk upgrade --no-cache && \
    apk add --no-cache python3 tini
COPY --from=apprise /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
WORKDIR /app

# ---- Production dependencies only.
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# ---- Local development with hot reload (docker build --target development).
FROM base AS development
ENV NODE_ENV=development
COPY package.json package-lock.json ./
RUN npm ci && npm cache clean --force
RUN mkdir -p /app/uploads
COPY src/ ./src/
COPY public/ ./public/
EXPOSE 3000
CMD ["npm", "run", "dev"]

# ---- Production image.
FROM base AS production
ENV NODE_ENV=production
ENV UPLOAD_DIR=/app/uploads

# The app never shells out to npm/yarn at runtime, and their bundled
# dependencies are the main source of scanner findings, so drop them.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* && \
    mkdir -p /app/uploads && chown -R node:node /app

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src/ ./src/
COPY --chown=node:node public/ ./public/

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini reaps zombies (apprise subprocesses) and forwards signals for clean shutdown.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
