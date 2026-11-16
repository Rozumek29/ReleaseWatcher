# --- Build: Angular UI + self-contained server executable (UI embedded) ---
# The Angular CLI runs on Node; Bun is the package manager and compiles the server.
FROM node:26-trixie-slim AS build
COPY --from=oven/bun:1.4.4-debian /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY package.json bun.lock ./
COPY web/package.json ./web/
RUN bun install --frozen-lockfile
COPY web/ ./web/
# angular.json writes the bundle to /app/public
RUN bun run --cwd web build
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
# Debian (glibc) build stage on purpose: when the target matches the host, Bun embeds its own runtime,
# so an Alpine stage would produce a musl binary that cannot start on the glibc distroless image below.
RUN bun scripts/compile.ts --target=bun-linux-x64 --outfile=dist/releasewatcher \
 && mkdir -p /data

# --- Runtime: just the executable (no Bun, no Node, no shell) ---
FROM gcr.io/distroless/cc-debian13:nonroot
ENV PORT=8080 \
    DATABASE_PATH=/data/releasewatcher.db
WORKDIR /app
COPY --from=build /app/dist/releasewatcher ./releasewatcher
COPY --from=build --chown=nonroot:nonroot /data /data
VOLUME /data
EXPOSE 8080
ENTRYPOINT ["/app/releasewatcher"]
