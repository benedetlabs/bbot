Abaixo está a especificação completa de Infraestrutura, Containerização e
Orquestração (v4.0), desenhada para garantir 100% de paridade entre o seu
ambiente local de desenvolvimento/testes via Docker Compose e a futura topologia
de produção no Azure Kubernetes Service (AKS).

Para que a transição do Docker local para o AKS ocorra sem refatoração de código
nos pacotes @suite/db ou @suite/outbox, toda a comunicação é abstraída por
variáveis de ambiente (PGCACHE_URL e DATABASE_ORIGIN_URL) e binários
autocontidos gerados pelo deno compile.

1. Dockerfile Multi-Stage Unificado (Deno 2.9 + Distroless)

Em vez de manter um Dockerfile diferente para cada app do monorepo (secret-app,
queue-app, todo-app, outbox-worker), utilizamos um único Dockerfile
parametrizado via ARG APP_NAME.

⚬ Stage 1 (builder): Usa a imagem oficial do Deno 2.9, valida o deno.lock em
modo --frozen (garantindo a proteção contra Supply Chain que definimos) e
compila o app alvo em um binário standalone Linux (deno compile). ⚬ Stage 2
(runtime): Usa uma imagem Google Distroless (cc-debian12:nonroot) sem shell
(sh/bash), sem gerenciador de pacotes e rodando com usuário não-root (UID
65532). Se alguém tentar explorar um RCE, não há sequer um /bin/sh dentro do
container no AKS.

# syntax=docker/dockerfile:1.7

# ============================================================================

# STAGE 1: BUILDER (Deno 2.9 Monorepo Compiler)

# ============================================================================

FROM denoland/deno:2.9.0 AS builder

ARG APP_NAME=secret-app WORKDIR /workspace

# 1. Copia apenas arquivos de manifesto e lockfile primeiro para aproveitar cache de layers

COPY deno.json deno.lock .npmrc ./ COPY packages/ ./packages/ COPY
apps/${APP_NAME}/ ./apps/${APP_NAME}/

# 2. Baixa e verifica integridade SHA-512 de todas as dependências (Zero scripts de postinstall)

RUN deno install --frozen

# 3. Compila o app específico do monorepo em um binário nativo autocontido

RUN deno compile\
--frozen\
--allow-net\
--allow-env\
--output /workspace/bin/app-runner\
./apps/${APP_NAME}/main.ts

# ============================================================================

# STAGE 2: PRODUCTION & TEST RUNTIME (Distroless Non-Root)

# ============================================================================

FROM gcr.io/distroless/cc-debian12:nonroot AS runtime

WORKDIR /app

# Copia apenas o binário compilado (Zero código-fonte ou cache do npm na imagem final)

COPY --from=builder /workspace/bin/app-runner /app/app-runner

USER nonroot:nonroot EXPOSE 8080

ENTRYPOINT ["/app/app-runner"]

2. Ambiente Local de Testes (docker-compose.yml)

Para testar localmente na sua máquina, este docker-compose.yml sobe:

1. postgres-origin (PostgreSQL 18): Configurado com wal_level=logical para
   alimentar o CDC do PgCache, além de abrigar a tabela UNLOGGED kv_store e a
   tabela outbox_events.
2. pgcache (pgcache.com): Conectado ao postgres-origin via slot de replicação
   lógica, expondo a porta 5433 para as leituras cacheadas.
3. Os 3 Apps (secret-app, queue-app, todo-app) + outbox-worker: Todos
   construídos a partir do mesmo Dockerfile mudando apenas o
   build.args.APP_NAME.

name: slack-suite-local

services:

# --------------------------------------------------------------------------

# 1. POSTGRESQL 18 (ORIGIN DATABASE + NATIVE KV + TRANSACTIONAL OUTBOX)

# --------------------------------------------------------------------------

postgres-origin: image: postgres:18-alpine container_name: suite-pg18-origin
restart: unless-stopped command: - "postgres" - "-c" - "wal_level=logical" -
"-c" - "max_replication_slots=10" - "-c" - "max_wal_senders=10" - "-c" -
"shared_buffers=256MB" environment: POSTGRES_USER: suite_user POSTGRES_PASSWORD:
suite_local_password POSTGRES_DB: slack_suite ports: - "5432:5432" volumes: -
pg18_data:/var/lib/postgresql/data -
./packages/db/migrations/001_init.sql:/docker-entrypoint-initdb.d/001_init.sql:ro
healthcheck: test: ["CMD-SHELL", "pg_isready -U suite_user -d slack_suite"]
interval: 3s timeout: 3s retries: 10

# --------------------------------------------------------------------------

# 2. PGCACHE PROXY (CDC WIRE-COMPATIBLE CACHE)

# --------------------------------------------------------------------------

pgcache: image: pgcache/pgcache:latest # Pinado por digest SHA256 em produção
container_name: suite-pgcache restart: unless-stopped depends_on:
postgres-origin: condition: service_healthy environment: PGCACHE_LISTEN_ADDR:
"0.0.0.0:5433" PGCACHE_ORIGIN_HOST: "postgres-origin" PGCACHE_ORIGIN_PORT:
"5432" PGCACHE_ORIGIN_USER: "suite_user" PGCACHE_ORIGIN_PASSWORD:
"suite_local_password" PGCACHE_ORIGIN_DB: "slack_suite" PGCACHE_CDC_PUBLICATION:
"pgcache_suite_pub" PGCACHE_CDC_SLOT: "pgcache_suite_slot" ports: - "5433:5433"

# --------------------------------------------------------------------------

# 3. APPS DO MONOREPO DENO 2.9 (SECRET, QUEUE, TODO)

# --------------------------------------------------------------------------

secret-app: build: context: . dockerfile: Dockerfile args: APP_NAME: secret-app
container_name: suite-secret-app depends_on: postgres-origin: condition:
service_healthy pgcache: condition: service_started environment: &common-env
PORT: "8080" DATABASE_ORIGIN_URL:
"postgres://suite_user:suite_local_password@postgres-origin:5432/slack_suite"
PGCACHE_URL:
"postgres://suite_user:suite_local_password@pgcache:5433/slack_suite"
SLACK_SIGNING_SECRET: "${SLACK_SIGNING_SECRET:-dev_signing_secret}"
      MASTER_ENCRYPTION_KEY_HEX: "${MASTER_ENCRYPTION_KEY_HEX:?Set MASTER_ENCRYPTION_KEY_HEX}"
ports: - "8081:8080"

queue-app: build: context: . dockerfile: Dockerfile args: APP_NAME: queue-app
container_name: suite-queue-app depends_on: - pgcache environment: <<:
*common-env ports: - "8082:8080"

todo-app: build: context: . dockerfile: Dockerfile args: APP_NAME: todo-app
container_name: suite-todo-app depends_on: - pgcache environment: <<:
*common-env ports: - "8083:8080"

# --------------------------------------------------------------------------

# 4. TRANSACTIONAL OUTBOX WORKER (POLLING SKIP LOCKED)

# --------------------------------------------------------------------------

outbox-worker: build: context: . dockerfile: Dockerfile args: APP_NAME:
outbox-worker container_name: suite-outbox-worker depends_on: postgres-origin:
condition: service_healthy environment: <<: *common-env WORKER_POLL_INTERVAL_MS:
"250" WORKER_BATCH_SIZE: "25"

volumes: pg18_data:

Dica para testar Webhooks do Slack localmente no Docker: Você pode adicionar um
container cloudflared (Cloudflare Quick Tunnels) ou ngrok no próprio
docker-compose.yml apontando para secret-app:8080, queue-app:8080 e
todo-app:8080, ou usar um único gateway local (como Traefik ou Hono Router)
roteando /webhooks/secret, /webhooks/queue e /webhooks/todo.

3. Arquitetura de Produção Futura no Azure (AKS)

Quando você virar a chave para produção na Azure, a topologia mapeia 1-para-1 do
docker-compose.yml para recursos gerenciados e nativos do AKS:

                [ Slack Platform ]
                        │
                        ▼ (HTTPS / TLS 1.3)
    [ Azure Front Door / NGINX Ingress Controller ]
       ├── /secret/* ──► Service: secret-app
       ├── /queue/*  ──► Service: queue-app
       └── /todo/*   ──► Service: todo-app
                        │

+------------------------------------┼------------------------------------+ |
AZURE KUBERNETES SERVICE (AKS) - VNet Privada | | ▼ | |
┌───────────────────────────────────────────────────────────────────┐ | | │
Deployment: secret-app / queue-app / todo-app (HPA: 2 a 15 Pods) │ | | │ -
Container: Deno 2.9 Distroless (Arm64 / Ampere Altra VMs) │ | | │ - Secrets via
Azure Key Vault CSI Driver (Workload Identity) │ | |
└─────────────────┬───────────────────────────────┬─────────────────┘ | | │
(Leituras: :5433) │ (Escritas/KV: :5432)| | ▼ │ | |
┌───────────────────────────────────┐ │ | | │ StatefulSet / Deployment: PgCache
│ │ | | │ - Disco NVMe Efêmero Local │ │ | |
└─────────────────┬─────────────────┘ │ |
+--------------------┼───────────────────────────────┼────────────────────+ │
(CDC Logical Replication) │ ▼ ▼
+---------------------------------------------------------------+ | PgDog /
PgCat ou PostgreSQL 18 no AKS (CloudNativePG) | | OU Azure Database for
PostgreSQL - Flexible Server (PG 18) | | - Private Endpoint (Sem IP Público) |
| - Server Parameter: wal_level = logical |
+---------------------------------------------------------------+

3.1 Banco de Dados no Azure: Duas Opções para o PostgreSQL 18

1. Opção A (Menor Esforço Operacional): Azure Database for PostgreSQL – Flexible
   Server (assim que a versão 18 GA estiver disponível na sua região, ou
   iniciando com PG 17 no Flexible Server e migrando). Basta ativar wal_level =
   logical nos Server Parameters para o PgCache consumir o CDC.
2. Opção B (Máxima Performance, Custo Baixo e PG 18 Imediato): Rodar o
   PostgreSQL 18 dentro do próprio AKS usando o operador CloudNativePG (CNPG)
   com Azure Premium SSD v2 e backup contínuo (WAL archiving + Barman) direto
   para o Azure Blob Storage. ⚬ Vantagem enorme da Opção B para o nosso caso:
   Você tem PostgreSQL 18 puro desde o dia 1 (com uuidv7() nativo), latência de
   rede sub-milissegundo dentro do mesmo Node Pool do AKS para a tabela UNLOGGED
   kv_store, e custo até 60% menor que o banco gerenciado da Azure.

3.2 PgCache no AKS (Onde rodar?)

⚬ No AKS, o PgCache pode rodar como um Deployment (service dedicado
pgcache-svc.slack-suite.svc.cluster.local:5433) em nós com Ephemeral OS Disks
(NVMe local). ⚬ Como o PgCache usa uma instância Postgres local com a extensão
pgcache_pgrx para armazenar os resultados cacheados, montar o diretório de dados
do PgCache em um volume emptyDir suportado pelo SSD NVMe local do nó do AKS
entrega latência de leitura de ~0.2ms para todos os Pods Deno.

3.3 Auto-Scaling Inteligente do outbox-worker com KEDA (Nativo no AKS)

O AKS possui integração oficial (add-on gerenciado) com o KEDA (Kubernetes
Event-driven Autoscaling).

⚬ O KEDA tem um PostgreSQL Scaler nativo! ⚬ Você configura o KEDA para rodar a
seguinte query a cada 5 segundos no banco: SELECT COUNT(*) FROM outbox_events
WHERE status = 'pending' AND next_attempt_at <= NOW();

⚬ Se a fila do Outbox estiver vazia ou baixa, o AKS mantém apenas 1 Pod do
outbox-worker rodando (gasto mínimo). Se acontecer um pico de uso às 09:00 da
manhã (envio de milhares de Morning Digests do Todo ou picos de expiração do
Queue), o KEDA escala automaticamente o outbox-worker de 1 para 10 Pods em
segundos, e como usamos FOR UPDATE SKIP LOCKED, os 10 Pods dividem o trabalho
sem colisão alguma!

4. Manifesto Base para o AKS (k8s/deployment-apps.yaml)

Quando chegar a hora do deploy no AKS, seus manifests já estão prontos para
Azure Workload Identity e limites rigorosos de memória/CPU (como o Deno 2.9
compilado consome ~35MB de RAM em idle, você consegue rodar dezenas de réplicas
em nós pequenos):

apiVersion: apps/v1 kind: Deployment metadata: name: secret-app namespace:
slack-suite labels: app.kubernetes.io/part-of: slack-micro-suite
app.kubernetes.io/component: secret-app spec: replicas: 2 selector: matchLabels:
app: secret-app template: metadata: labels: app: secret-app
azure.workload.identity/use: "true" spec: serviceAccountName: suite-workload-sa
securityContext: runAsNonRoot: true runAsUser: 65532 runAsGroup: 65532
seccompProfile: type: RuntimeDefault containers: - name: secret-app image:
<seu-acr>.azurecr.io/slack-suite/secret-app:v1.0.0 ports: - containerPort: 8080
name: http envFrom: - secretRef: name: suite-db-and-slack-secrets # Sincronizado
do Azure Key Vault resources: requests: cpu: "100m" memory: "64Mi" limits: cpu:
"500m" memory: "128Mi" readinessProbe: httpGet: path: /healthz port: 8080
initialDelaySeconds: 2 periodSeconds: 5 livenessProbe: httpGet: path: /healthz
port: 8080 initialDelaySeconds: 5 periodSeconds: 10 securityContext:
allowPrivilegeEscalation: false readOnlyRootFilesystem: true # Deno compilado +
KV no PG18 = Zero escrita em disco! capabilities: drop: ["ALL"]

Repare no detalhe readOnlyRootFilesystem: true no manifesto do Kubernetes: como
toda a nossa camada de estado temporário vive na tabela UNLOGGED kv_store no
PostgreSQL 18 e o código Deno 2.9 foi compilado em binário único com --frozen, o
container roda com sistema de arquivos 100% somente-leitura tanto no Docker
local quanto no AKS.

Quer que eu consolide toda essa documentação (PRD v2 + Stack Deno 2.9 / PG 18 /
KV / Outbox / PgCache + Infra Docker & AKS) em um único arquivo .MD mestre
(Master PRD & Architecture Blueprint) para você salvar no repositório, ou
prefere que eu gere os arquivos reais de código do monorepo (deno.json,
001_init.sql, packages/db/mod.ts, Dockerfile e docker-compose.yml) para você já
dar o primeiro docker compose up?
