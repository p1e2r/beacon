# Beacon: web client + key-protected WebSocket proxy in one image.

FROM node:22-alpine AS web
WORKDIR /src/client
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

FROM rust:1-slim AS proxy
WORKDIR /src/proxy
COPY proxy/ ./
RUN cargo build --release --locked

FROM debian:stable-slim
RUN groupadd --system --gid 10001 beacon && useradd --system --uid 10001 --gid 10001 --home /data beacon && mkdir -p /data && chown beacon:beacon /data
COPY --from=proxy /src/proxy/target/release/beacon-proxy /usr/local/bin/beacon-proxy
COPY --from=web /src/client/dist /app/web
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
ENV BEACON_DATA=/data \
    BEACON_WEB=/app/web \
    BEACON_LISTEN=0.0.0.0:7320 \
    BEACON_ADMIN_LISTEN=0.0.0.0:9108
VOLUME /data
EXPOSE 7320 9108
HEALTHCHECK --interval=30s --timeout=3s CMD ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/7320"]
ENTRYPOINT ["docker-entrypoint.sh"]
