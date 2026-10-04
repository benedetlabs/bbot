Essa decisão de arquitetura é excelente. Eliminar o Redis, focar 100% no
PostgreSQL 18 + PgCache (pgcache.com) como proxy wire-compatible alimentado por
CDC (Logical Replication) e consolidar tudo em um Monorepo Deno 2.9 reduz
drasticamente a superfície operacional e o custo de infraestrutura, sem abrir
mão de latência sub-milissegundo nas leituras quentes.

Abaixo está a Documentação de Arquitetura e Engenharia (RFC / Stack Spec v3.0)
completa, desenhada especificamente para essas restrições de segurança (Supply
Chain), KV nativo no Postgres 18, Transactional Outbox e integração com o
PgCache.

Technical Architecture & Stack Specification (v3.0)

Project: Slack Micro-Utility Suite (Secret, Queue, Todo) Runtime: Deno 2.9
(Native Workspaces Monorepo) Database Engine: PostgreSQL 18 (wal_level =
logical) Caching Layer: PgCache (pgcache.com) — Wire-compatible CDC Query Proxy
External KV / Message Broker: None (100% PostgreSQL Native KV + Transactional
Outbox Polling)

1. Visão Geral da Topologia (Zero-Redis Architecture)

Como o PgCache senta entre a aplicação Deno e o PostgreSQL 18 falando o
protocolo nativo do Postgres (wire protocol) e mantendo o cache consistente em
tempo real via Logical Replication (CDC), nossa aplicação não precisa gerenciar
invalidação de cache manual (cache-aside).

    [ Slack Platform Webhooks / Slash Commands ]
                         │
                         ▼ (HTTPS / TLS 1.3)

+---------------------------------------------------------------------------------------+
| DENO 2.9 MONOREPO RUNTIME | | | | ┌───────────────────────┐
┌───────────────────────┐ ┌─────────────────────────┐ | | │ apps/secret-api │ │
apps/queue-api │ │ apps/todo-api │ | | └───────────┬───────────┘
└───────────┬───────────┘ └────────────┬────────────┘ | |
└───────────────────────────┼────────────────────────────┘ | | ▼ | |
┌─────────────────────────────────────────────────────────────────────────────────┐
| | │ packages/db-client (Dual-Pool Router: Read/Cache Pool vs. Direct Write/KV
Pool) │ | |
└───────────────────┬─────────────────────────────────────────┬───────────────────┘
|
+----------------------┼─────────────────────────────────────────┼──────────────────────+
│ (1) Cacheable Reads │ (2) Writes, Atomic KV │ (Workspaces, Plans, │ (DELETE
RETURNING), │ Active Queues, Todos) │ & Outbox Polling ▼ ▼
┌─────────────────────────────┐ ┌─────────────────────────────┐ │ PgCache Proxy
(:5433) │◄──────────│ PostgreSQL 18 (:5432) │ │ - Wire-Compatible Proxy │
Logical │ - Primary Origin DB │ │ - Local PG + pgcache_pgrx │ Repl. │ - UNLOGGED
kv_store (JSONB)│ │ - Zero Stale Reads │ (CDC) │ - outbox_events (SKIP LOCK)│
└─────────────────────────────┘ └─────────────────────────────┘

Regra de Ouro da Integração com o PgCache (pgcache.com)

1. Primary Keys Obrigatórias: O PgCache exige que todas as tabelas cacheadas
   possuam PRIMARY KEY explícita. Queries em tabelas sem PK são repassadas
   direto para a origem (Origin DB).
2. Single-Table Queries = Zero Invalidação: Como o PgCache aplica INSERT, UPDATE
   e DELETE diretamente sobre o resultado cacheado em queries de tabela única
   (via stream CDC), modelamos nossas leituras críticas (verificação de
   Workspace, busca de Token OAuth, checagem de Bucket de Billing, listagem da
   Queue ativa e Todos) como queries de tabela única por PK/Index, garantindo
   Hit Rate próximo de 100% e zero stale reads.
3. Dual Connection String (Opcional, mas recomendado para KV Efêmero): ⚬ Embora
   o PgCache repasse escritas automaticamente para o Origin DB, operações
   altamente voláteis que nunca devem ser cacheadas — como o DELETE ...
   RETURNING de queima única do app Secret na tabela kv_store (que pode ser
   UNLOGGED) e o polling de FOR UPDATE SKIP LOCKED do outbox_events — podem usar
   uma pool conectada diretamente ao Origin DB (ou simplesmente bater na tabela
   UNLOGGED, que por definição não entra no stream de replicação lógica do
   Postgres).

4. Estrutura do Monorepo Deno 2.9 & Supply Chain Security

2.1 Árvore de Diretórios (Deno Workspaces)

O Deno 2.9 suporta nativamente monorepos via propriedade "workspace" no
deno.json raiz, permitindo compartilhamento de pacotes internos (@suite/*) sem
build steps intermediários.

slack-suite-monorepo/ ├── deno.json # Configuração global, workspace, lint, fmt
e Minimum Dependency Age ├── deno.lock # Lockfile v5 com hashes de integridade
SHA-512 estritos (commit obrigatório) ├── .npmrc # ignore-scripts=true (bloqueia
postinstall maliciosos de pacotes npm) ├── apps/ │ ├── secret-app/ # HTTP
Webhook Server do App Secret │ │ ├── deno.json │ │ └── main.ts │ ├── queue-app/

# HTTP Webhook Server do App Queue │ │ ├── deno.json │ │ └── main.ts │ ├──

todo-app/ # HTTP Webhook Server do App Todo │ │ ├── deno.json │ │ └── main.ts │
└── outbox-worker/ # Worker de background (Polling do Outbox, Timeouts do Queue,
Digests) │ ├── deno.json │ └── main.ts └── packages/ ├── db/ # Cliente Postgres,
Migrations, PgCache Router e KV Store Engine ├── outbox/ # Publisher e Poller do
Transactional Outbox Pattern ├── crypto/ # WebCrypto API nativa (AES-256-GCM)
para o Secret e Tokens OAuth ├── slack-kit/ # Verificador HMAC-SHA256 do Slack,
Block Kit Builders e Modals └── billing/ # Motor de contagem de Buckets (5 / 10
/ 30 / 50+ usuários)

2.2 Política Estrita Anti-Supply Chain Attack no Deno 2.9

Para cumprir a exigência de usar especificadores npm:, nunca usar a versão
latest e mitigar ataques de Supply Chain (como pacotes comprometidos horas após
o publicação no registro do NPM), aplicamos 4 camadas de defesa nativa:

1. Pinagem Exata Sem Caret (^) ou Tilde (~): No imports do deno.json, é proibido
   usar npm:pacote@^1.2.0 ou latest. Todas as versões são cravadas exatamente
   (ex: "npm:postgres@3.4.4") e auditadas pelo menos 14 a 30 dias após o
   lançamento oficial.
2. Trava Nativa de Idade Mínima (minimumDependencyAge): Configuramos o Deno para
   recusar qualquer versão de pacote npm: ou jsr: publicada recentemente (janela
   de quarentena de 14 dias), impedindo que um ataque zero-day no NPM entre em
   uma atualização acidental.
3. Bloqueio de Lifecycle Scripts (--frozen + ignore-scripts): Nenhum pacote npm:
   tem permissão para rodar scripts de preinstall / postinstall.
4. Permissões Granulares de Runtime: Em produção, os binários/containers rodam
   apenas com --allow-net=slack.com,pgcache-internal:5433,postgres-origin:5432
   --allow-env (zero acesso a escrita em disco --allow-write ou subprocessos
   --allow-run).

Arquivo deno.json (Raiz do Monorepo)

{ "workspace": [ "./apps/secret-app", "./apps/queue-app", "./apps/todo-app",
"./apps/outbox-worker", "./packages/db", "./packages/outbox",
"./packages/crypto", "./packages/slack-kit", "./packages/billing" ],
"minimumDependencyAge": "14d", "nodeModulesDir": "none", "lock": { "path":
"./deno.lock", "frozen": true }, "imports": { "@suite/db":
"./packages/db/mod.ts", "@suite/outbox": "./packages/outbox/mod.ts",
"@suite/crypto": "./packages/crypto/mod.ts", "@suite/slack-kit":
"./packages/slack-kit/mod.ts", "@suite/billing": "./packages/billing/mod.ts",
"postgres": "npm:postgres@3.4.4", "hono": "npm:hono@4.5.8", "zod":
"npm:zod@3.23.8", "chrono-node": "npm:chrono-node@2.7.6" }, "tasks": {
"dev:secret": "deno run --allow-net --allow-env --watch
apps/secret-app/main.ts", "dev:queue": "deno run --allow-net --allow-env --watch
apps/queue-app/main.ts", "dev:todo": "deno run --allow-net --allow-env --watch
apps/todo-app/main.ts", "dev:worker": "deno run --allow-net --allow-env --watch
apps/outbox-worker/main.ts", "audit:lock": "deno install --frozen" },
"compilerOptions": { "strict": true, "noImplicitAny": true,
"exactOptionalPropertyTypes": true } }

(Nota: Usamos a Web Crypto API 100% nativa do Deno crypto.subtle para
criptografia AES-256-GCM e validação de assinatura HMAC do Slack, reduzindo
ainda mais a quantidade de dependências npm: externas).

3. PostgreSQL 18 Native KV Store (kv_store com JSONB)

Para substituir o Redis completamente, criamos uma tabela kv_store otimizada
para PostgreSQL 18.

3.1 Decisão de Engenharia: UNLOGGED vs LOGGED na Tabela KV

⚬ No PostgreSQL 18, uma tabela UNLOGGED não escreve no WAL (Write-Ahead Log).
Isso faz com que operações de INSERT, UPDATE e DELETE sejam quase tão rápidas
quanto o Redis em memória RAM (pois ficam nos shared_buffers sem latência de
fsync de WAL), além de não poluir o stream de Logical Replication (CDC) do
PgCache com dados efêmeros de segundos de vida! ⚬ Como a tabela kv_store
armazena Segredos Efêmeros Criptografados (que por requisito de segurança devem
sumir se o servidor reiniciar), Rate Limits, Locks de Idempotência de Webhooks
do Slack e Estados Temporários de Modais, UNLOGGED é o encaixe perfeito.

3.2 DDL da Tabela kv_store (PostgreSQL 18)

# -- ============================================================================ -- NATIVE POSTGRESQL 18 KEY-VALUE STORE (ZERO-REDIS REPLACEMENT) --

CREATE UNLOGGED TABLE kv_store ( key TEXT PRIMARY KEY, value JSONB NOT NULL,
expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW() ) WITH ( fillfactor = 70, --
Reserva 30% das páginas para HOT (Heap-Only Tuple) updates rápidos
autovacuum_vacuum_scale_factor = 0.01, -- Autovacuum agressivo para limpar
chaves deletadas/expiradas autovacuum_vacuum_cost_limit = 2000 );

-- Índice parcial enxuto apenas para o processo de garbage collection de chaves
expiradas CREATE INDEX idx_kv_store_expires_at ON kv_store (expires_at);

3.3 As 4 Operações Atômicas do nosso Módulo @suite/db/kv.ts

Em vez de fazer múltiplos round-trips, o PostgreSQL 18 nos permite fazer tudo em
uma única query atômica:

1. kv.set(key, jsonPayload, ttlSeconds) (Upsert com TTL): INSERT INTO kv_store
   (key, value, expires_at, updated_at) VALUES ($1, $2::jsonb, NOW() + ($3 || '
   seconds')::interval, NOW()) ON CONFLICT (key) DO UPDATE SET value =
   EXCLUDED.value, expires_at = EXCLUDED.expires_at, updated_at = NOW();

2. kv.get(key) (Leitura com Filtro de Expiração Instantâneo): Mesmo que o
   garbage collector ainda não tenha rodado, uma chave vencida há 1 milissegundo
   jamais é retornada: SELECT value FROM kv_store WHERE key = $1 AND expires_at
   > NOW();

3. kv.getAndDelete(key) (O GETDEL Atômico para o App Secret): Quando o usuário
   clica em [ 👁️ Reveal Secret ] no Slack, precisamos ler o JSONB criptografado
   e destruí-lo na mesma instrução SQL. Se duas requisições concorrentes
   chegarem no mesmo milissegundo, o lock de linha nativo do Postgres garante
   que apenas a primeira receba a linha no RETURNING, e a segunda receba 0 rows:
   DELETE FROM kv_store WHERE key = $1 AND expires_at > NOW() RETURNING value;

4. kv.consumeMultiViewSecret(key) (Decremento Atômico no JSONB ou Burn na Última
   Leitura): Para segredos compartilhados em um canal (ex: "Pode ser visto por
   até 5 pessoas em 1 hora"), usamos uma CTE atômica que decrementa o contador
   dentro do JSONB ou deleta a linha se for a última visualização restante: WITH
   updated AS ( UPDATE kv_store SET value = jsonb_set(value,
   '{remaining_views}', to_jsonb((value->>'remaining_views')::int - 1)),
   updated_at = NOW() WHERE key = $1 AND expires_at > NOW() AND
   (value->>'remaining_views')::int > 0 RETURNING key, value ), burned AS (
   DELETE FROM kv_store WHERE key IN ( SELECT key FROM updated WHERE
   (value->>'remaining_views')::int <= 0 ) ) SELECT value FROM updated;

5. Mensageria Nativa: Padrão Transactional Outbox com Polling (SKIP LOCKED)

No Slack, os webhooks exigem resposta rápida (<150ms), mas muitas ações disparam
efeitos colaterais assíncronos:

⚬ Atualizar o Card do Secret no chat via chat.update após a modal abrir. ⚬
Notificar o próximo engenheiro da fila no Queue quando o slot é liberado ou
quando o tempo expira. ⚬ Enviar o Morning Digest do Todo às 09:00 ou processar
eventos de faturamento (alertas de limite de 10/30/50 usuários).

Com o Transactional Outbox Pattern, gravamos a mudança de estado do negócio (ex:
liberar a fila no queue_entries) e o evento de mensageria (outbox_events) na
mesma transação ACID do PostgreSQL 18. Zero risco de atualizar o banco e falhar
ao publicar a mensagem!

4.1 DDL da Tabela outbox_events (PostgreSQL 18)

Usamos a função nativa uuidv7() do PostgreSQL 18 como chave primária! O UUIDv7 é
ordenado temporalmente (timestamp nos primeiros 48 bits), o que elimina a
fragmentação de índice B-Tree (index bloat) em tabelas de altíssima inserção
como um Outbox.

# -- ============================================================================ -- TRANSACTIONAL OUTBOX TABLE (POSTGRESQL 18 NATIVE UUIDv7) --

CREATE TABLE outbox_events ( id UUID PRIMARY KEY DEFAULT uuidv7(), -- Nativo no
Postgres 18! Ordenado por tempo. workspace_id UUID NOT NULL, app_source
VARCHAR(16) NOT NULL, -- 'secret', 'queue', 'todo', 'billing' event_type
VARCHAR(64) NOT NULL, -- ex: 'queue.slot_promoted', 'secret.burned_card_update'
payload JSONB NOT NULL, -- Dados necessários para chamar a API do Slack status
VARCHAR(16) NOT NULL DEFAULT 'pending', -- 'pending', 'processing', 'completed',
'dead_letter' attempts INT NOT NULL DEFAULT 0, max_attempts INT NOT NULL DEFAULT
5, next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), -- Permite agendar
eventos futuros (ex: Queue TTL!) locked_by VARCHAR(64), locked_at TIMESTAMPTZ,
last_error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), completed_at
TIMESTAMPTZ ) WITH ( fillfactor = 80, autovacuum_vacuum_scale_factor = 0.02 );

-- Índice parcial ultra-compacto: indexa APENAS os eventos que ainda precisam
ser processados! CREATE INDEX idx_outbox_poll ON outbox_events (next_attempt_at
ASC, id ASC) WHERE status = 'pending';

4.2 A Sacada do next_attempt_at: Outbox + Agendador de Timeouts Unificados!

Repare na coluna next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(). Ela resolve
dois problemas com uma única tabela:

1. Eventos Imediatos: next_attempt_at = NOW(). O worker pega na próxima batida
   de polling (ex: a cada 250ms).
2. Eventos Agendados (Delays e Timeouts do Queue e Lembretes do Todo): Quando o
   @leonardo assume a fila #staging-api por 45 minutos, na mesma transação nós
   já inserimos na outbox_events um evento queue.check_expiration_warning com
   next_attempt_at = NOW() + interval '40 minutes'. Não precisamos de um cron
   job separado varrendo tabelas!

4.3 Query de Polling Concorrente (FOR UPDATE SKIP LOCKED)

No apps/outbox-worker, podemos rodar 1, 2 ou 10 réplicas do container Deno
simultaneamente. Cada worker executa esta query a cada 250ms (com exponential
jitter para 1000ms quando ocioso):

WITH claimed AS ( SELECT id FROM outbox_events WHERE status = 'pending' AND
next_attempt_at <= NOW() ORDER BY next_attempt_at ASC, id ASC LIMIT 25 FOR
UPDATE SKIP LOCKED ) UPDATE outbox_events o SET status = 'processing', locked_by
= $1, -- worker_instance_id locked_at = NOW(), attempts = o.attempts + 1 FROM
claimed WHERE o.id = claimed.id RETURNING o.id, o.workspace_id, o.app_source,
o.event_type, o.payload, o.attempts, o.max_attempts;

Se a chamada para a API do Slack falhar (ex: Rate Limit HTTP 429 do Slack), o
worker devolve o evento para 'pending' aplicando Exponential Backoff:

UPDATE outbox_events SET status = CASE WHEN attempts >= max_attempts THEN
'dead_letter' ELSE 'pending' END, next_attempt_at = NOW() + (POWER(2, attempts)
|| ' seconds')::interval, last_error = $2, locked_by = NULL WHERE id = $1;

5. Como o PgCache (pgcache.com) Acelera os 3 Apps na Prática

Para tirar proveito máximo do motor de análise de queries do PgCache, desenhamos
o schema das tabelas relacionais no PostgreSQL 18 seguindo as regras do
analisador de cacheabilidade do PgCache:

Operação na Suite Slack	Frequência	Como é Modelada no Postgres 18	Comportamento
no PgCache (pgcache.com) Autenticação de Workspace & Checagem de Plano ($0 / $9
/ $20 / $30)	Toda requisição (100% dos webhooks)	SELECT id,
bot_access_token_enc, plan_tier, has_secret_audit_addon, active_users_count FROM
workspaces WHERE slack_team_id = $1	100% Cache Hit em Memória. Como é uma
single-table query com PK/Unique, o PgCache nunca precisa invalidar essa linha;
se o time fizer upgrade no Stripe ou o contador de usuários mudar, o CDC
atualiza o registro em memória no PgCache instantaneamente. Verificação se
Usuário já está no Bucket Mensal (MAU)	Toda requisição	SELECT 1 FROM
workspace_monthly_active_users WHERE id = $1 (onde id é chave composta
determinística team_id:YYYY-MM:user_id)	100% Cache Hit. Só dispara INSERT no
banco na primeira interação do usuário naquele mês. Nas outras 500 interações do
mês, o PgCache responde em <0.3ms direto da memória local. Renderização da Fila
(Queue) e App Home (Todo)	Altíssima (Leitura constante)	SELECT * FROM
queue_entries WHERE queue_id = $1 AND status IN ('active', 'waiting')	100% Cache
Hit Consistente. Quando alguém entra ou sai da fila, a escrita vai para o Origin
DB, o stream de replicação lógica (CDC) avisa o PgCache e a listagem já está
pronta na memória para todos os usuários do canal. Armazenamento e Queima do
Segredo (Secret)	Episódica & Crítica	DELETE FROM kv_store WHERE key = $1
RETURNING value	Bypass Automático para o Origin DB. Por ser um DELETE RETURNING
em uma tabela UNLOGGED, executa atomicamente direto nos buffers do Postgres 18
sem passar pelo cache de leitura.

Configuração Recomendada do pgcache.toml + postgresql.conf

No container/servidor do PostgreSQL 18 principal (Origin DB), basta habilitar a
replicação lógica:

# postgresql.conf (Origin DB - PostgreSQL 18)

wal_level = logical max_replication_slots = 10 max_wal_senders = 10

E no arquivo pgcache.toml do proxy:

# pgcache.toml

listen_addr = "0.0.0.0:5433" origin_host = "postgres-origin.internal"
origin_port = 5432 origin_user = "suite_app" origin_dbname = "slack_suite_prod"

cache_host = "127.0.0.1" cache_port = 5434 # Instância local com
shared_preload_libraries = 'pgcache_pgrx' cdc_publication_name =
"pgcache_suite_pub" cdc_slot_name = "pgcache_suite_slot" num_workers = 4

6. Implementação de Referência em Deno 2.9 (packages/db + packages/outbox)

Aqui está como o código fica limpo, tipado e seguro dentro do nosso monorepo
Deno:

6.1 packages/db/mod.ts (Dual Pool + KV Nativo)

import postgres from "postgres";

// 1. Read Pool aponta para o PgCache (:5433) -> Leituras cacheadas com CDC em
tempo real export const sqlRead = postgres(Deno.env.get("PGCACHE_URL")!, { max:
25, idle_timeout: 30, prepare: true, });

// 2. Write/Atomic Pool aponta direto para o Postgres 18 Origin (:5432) ->
Transações, Outbox e KV Burn export const sqlWrite =
postgres(Deno.env.get("DATABASE_ORIGIN_URL")!, { max: 15, idle_timeout: 30,
prepare: true, });

export interface SecretKVPayload { ciphertextBase64: string; ivBase64: string;
authTagBase64: string; creatorSlackId: string; allowedRecipients: string[] |
null; remainingViews: number; }

export const kv = { /**

- Salva um valor JSONB na tabela UNLOGGED kv_store com TTL em segundos. */ async
  set<T extends Record<string, unknown>>( key: string, value: T, ttlSeconds:
  number, ): Promise<void> { await
  sqlWrite`INSERT INTO kv_store (key, value, expires_at, updated_at)
      VALUES (
        ${key},
        ${sqlWrite.json(value)},
        NOW() + (${ttlSeconds} * INTERVAL '1 second'),
        NOW()
      )
      ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value,
          expires_at = EXCLUDED.expires_at,
          updated_at = NOW()`;
  },

/**

- Queima atômica de 1 leitura (Burn-on-Read) para o App Secret.
- Garante no nível de linha do Postgres 18 que apenas 1 clique recupere o
  payload. */ async burnSecret(key: string): Promise<SecretKVPayload | null> {
  const rows = await sqlWrite<{ value: SecretKVPayload
  }[]>`DELETE FROM kv_store
      WHERE key = ${key}
        AND expires_at > NOW()
      RETURNING value`;
  return rows.length > 0 ? rows[0].value : null; }, };

6.2 packages/outbox/mod.ts (Gravação Transacional + Worker Polling)

import { sqlWrite } from "@suite/db"; import type { Sql } from "postgres";

export interface OutboxEventInput { workspaceId: string; appSource: "secret" |
"queue" | "todo" | "billing"; eventType: string; payload: Record<string,
unknown>; delaySeconds?: number; // Se > 0, agenda para o futuro (ex: Queue
Auto-Expire!) }

/**

- Deve ser chamado DENTRO de um bloco sqlWrite.begin(async (tx) => { ... })
- para garantir atomicidade entre a regra de negócio e o evento assíncrono. */
  export async function enqueueOutboxEvent( tx: Sql, event: OutboxEventInput, ):
  Promise<void> { const delay = event.delaySeconds ?? 0; await
  tx`INSERT INTO outbox_events (
      workspace_id,
      app_source,
      event_type,
      payload,
      next_attempt_at
    ) VALUES (
      ${event.workspaceId}::uuid,
      ${event.appSource},
      ${event.eventType},
      ${tx.json(event.payload)},
      NOW() + (${delay} * INTERVAL '1 second')
    )`;
  }

7. Resumo das Vantagens desta Stack

8. Custo Operacional Mínimo e Alta Densidade: Você não precisa pagar nem
   gerenciar clusters de Redis, RabbitMQ ou Kafka. Tudo gira em torno do
   PostgreSQL 18 e do PgCache.
9. Proteção Real contra Supply Chain no Deno 2.9: Com "minimumDependencyAge":
   "14d", versões npm: exatas sem ^/~, "nodeModulesDir": "none" e lockfile
   congelado ("frozen": true), seu pipeline de CI/CD jamais baixará uma versão
   recém-infectada do NPM.
10. Zero Stale Reads no PgCache: Diferente de um cache Redis manual onde você
    corre o risco de esquecer um DEL e mostrar para o desenvolvedor uma fila de
    deploy (Queue) desatualizada ou um Todo já concluído, o PgCache reconcilia
    cada COMMIT via replicação lógica do Postgres 18 automaticamente.
11. Evolução Futura Sem Dor: Como toda a mensageria já nasce desacoplada na
    interface enqueueOutboxEvent(tx, ...), se daqui a 2 anos você tiver 10.000
    workspaces ativos e quiser trocar o polling por LISTEN/NOTIFY acordando os
    workers ou um broker dedicado, você altera apenas o pacote packages/outbox
    sem tocar em uma única linha dos apps Secret, Queue ou Todo.

Quer que eu gere também o arquivo .MD atualizado com essa especificação técnica
completa de Stack (Deno 2.9 + PG 18 + KV JSONB + Outbox + PgCache) ou prefere
que a gente já monte o código inicial dos 3 pacotes base (@suite/db,
@suite/crypto e @suite/slack-kit)?
