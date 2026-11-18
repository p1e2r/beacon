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
RUN useradd --system --uid 10001 --home /data beacon && mkdir -p /data && chown beacon /data
COPY --from=proxy /src/proxy/target/release/beacon-proxy /usr/local/bin/beacon-proxy
COPY --from=web /src/client/dist /app/web
ENV BEACON_DATA=/data \
    BEACON_WEB=/app/web \
    BEACON_LISTEN=0.0.0.0:8080 \
    BEACON_ADMIN_LISTEN=0.0.0.0:8081
VOLUME /data
EXPOSE 8080 8081
USER beacon
HEALTHCHECK --interval=30s --timeout=3s CMD ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/8080"]
ENTRYPOINT ["beacon-proxy"]
