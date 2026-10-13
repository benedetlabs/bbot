# syntax=docker/dockerfile:1.7
# ============================================================================
# PRODUCTION RUNTIME (Deno 2.9 Alpine Non-Root + Native OpenTelemetry)
# ============================================================================
FROM denoland/deno:alpine-2.9.7 AS runtime

ARG APP_NAME=secret-app
WORKDIR /app

ENV DENO_DIR=/app/.deno_cache
ENV APP_NAME=${APP_NAME}

# 1. Copy dependency and workspace manifests
COPY deno.json deno.lock* .npmrc ./
COPY packages/ ./packages/
COPY apps/ ./apps/

# 2. Pre-cache all dependencies at build time and grant ownership to nonroot (65532)
RUN deno cache ./apps/${APP_NAME}/main.ts && \
    chown -R 65532:65532 /app

USER 65532:65532
EXPOSE 8080

ENTRYPOINT ["sh", "-c", "exec deno run --unstable-otel --cached-only --allow-net --allow-env ./apps/${APP_NAME}/main.ts"]
