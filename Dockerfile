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
# Version shown in the UI (the release workflow passes the Git tag); empty = package.json.
ARG VERSION=
# Bun runtime embedded in the executable: bun-linux-x64 needs a CPU with AVX2 (Haswell, 2013, and newer);
# bun-linux-x64-baseline runs on older x64 CPUs too (the release workflow publishes it as the *-baseline tags).
ARG TARGET=bun-linux-x64
# Debian (glibc) build stage on purpose: when the target matches the host, Bun embeds its own runtime,
# so an Alpine stage would produce a musl binary that cannot start on the glibc Debian image below.
RUN bun scripts/compile.ts --target=$TARGET --outfile=dist/releasewatcher ${VERSION:+--version=$VERSION} \
 && mkdir -p /data

# --- Runtime: the executable + OpenSSH client (used to reach the Proxmox node) ---
FROM debian:trixie-slim
# Same UID/GID as the distroless "nonroot" user used before, so existing /data volumes stay writable.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-client ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 65532 nonroot \
 && useradd --uid 65532 --gid 65532 --create-home --shell /usr/sbin/nologin nonroot
ENV PORT=8080 \
    DATABASE_PATH=/data/releasewatcher.db
WORKDIR /app
COPY --from=build /app/dist/releasewatcher ./releasewatcher
COPY --from=build --chown=nonroot:nonroot /data /data
USER nonroot
VOLUME /data
EXPOSE 8080
ENTRYPOINT ["/app/releasewatcher"]
