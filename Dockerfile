# Base stage for shared configurations
FROM node:22-alpine AS base

# Install python and create virtual environment with minimal dependencies
RUN apk add --no-cache python3 py3-pip curl && \
    python3 -m venv /opt/venv && \
    rm -rf /var/cache/apk/*

# Activate virtual environment and install apprise
RUN . /opt/venv/bin/activate && \
    pip install --no-cache-dir --upgrade pip apprise && \
    find /opt/venv -type d -name "__pycache__" -exec rm -r {} +

ENV PATH="/opt/venv/bin:$PATH"
WORKDIR /app

# Dependencies stage
FROM base AS deps

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force && chown -R node:node /app

# Development stage
FROM deps AS development
ENV NODE_ENV=development

RUN npm install && npm cache clean --force

RUN mkdir -p uploads && chown -R node:node /app
USER node

COPY --chown=node:node src/ ./src/
COPY --chown=node:node public/ ./public/

EXPOSE 3000
CMD ["npm", "run", "dev"]

# Production stage
FROM deps AS production
ENV NODE_ENV=production

RUN mkdir -p uploads && chown -R node:node /app
USER node

COPY --chown=node:node src/ ./src/
COPY --chown=node:node public/ ./public/

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/api/auth/pin-required || exit 1

CMD ["npm", "start"]
