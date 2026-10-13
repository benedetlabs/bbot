# syntax=docker/dockerfile:1.7
# ============================================================================
# STAGE 1: BUILDER (Deno 2.9 Monorepo Compiler)
# ============================================================================
FROM denoland/deno:2.9.7 AS builder

ARG APP_NAME=secret-app
WORKDIR /workspace

# 1. Copy dependency and workspace manifests
COPY deno.json deno.lock* .npmrc ./
COPY packages/ ./packages/
COPY apps/${APP_NAME}/ ./apps/${APP_NAME}/

# 2. Compile standalone native executable with built-in OpenTelemetry support
RUN deno compile \
    --unstable-otel \
    --allow-net \
    --allow-env \
    --output /workspace/bin/app-runner \
    ./apps/${APP_NAME}/main.ts

# ============================================================================
# STAGE 2: PRODUCTION RUNTIME (Distroless Non-Root)
# ============================================================================
FROM gcr.io/distroless/cc-debian12:nonroot AS runtime

WORKDIR /app

# Copy compiled binary only (Zero Node/NPM cache, zero disk write)
COPY --from=builder /workspace/bin/app-runner /app/app-runner

USER nonroot:nonroot
EXPOSE 8080

ENTRYPOINT ["/app/app-runner"]
