# RepoLedger web server.
#   docker build -t repoledger .
#   docker run -p 8600:8600 --env-file .env repoledger
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY src ./src
COPY scripts ./scripts
COPY public ./public

# Run as the image's unprivileged user, not root.
USER node
EXPOSE 8600
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD wget -qO- "http://127.0.0.1:${PORT:-8600}/healthz" > /dev/null || exit 1
CMD ["node", "server.js"]
