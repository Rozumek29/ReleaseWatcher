# --- Angular UI (the Angular CLI runs on Node; Bun is only the package manager here) ---
FROM node:24-alpine AS web
COPY --from=oven/bun:1.4.4-alpine /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY package.json bun.lock ./
COPY web/package.json ./web/
RUN bun install --frozen-lockfile
COPY web/ ./web/
# angular.json writes the bundle to /app/public
RUN bun run --cwd web build

# --- Runtime (Bun runs TypeScript natively; the server has no runtime dependencies) ---
FROM oven/bun:1.4.4-alpine
ENV NODE_ENV=production \
    PORT=8080 \
    DATABASE_PATH=/data/releasewatcher.db
WORKDIR /app
RUN mkdir -p /data && chown bun:bun /data
COPY package.json ./
COPY src ./src
COPY --from=web /app/public ./public
USER bun
VOLUME /data
EXPOSE 8080
CMD ["bun", "src/main.ts"]
