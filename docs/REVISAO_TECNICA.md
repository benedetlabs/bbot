# Revisão técnica (somente leitura) — BenedetLabsBots

**Repo:** `/Users/leonardobenedet/Code/BenedetLabsBots`  
**MachineId:** `ca04daf3-8722-4841-8775-8a2826451616`  
**Data:** 14 out 2026 (America/Sao_Paulo)  
**Escopo:** Deno monorepo (apps `secret-app`, `queue-app`, `todo-app`, `outbox-worker`; packages `outbox`, `crypto`, `slack-kit`, `db`, `billing`; manifests; infra).  
**Método:** leitura via Shell (`ls`, `cat`, `grep`, `git`); nenhuma alteração, install, execução ou commit.

---

## Resumo executivo

A base criptográfica do Secret (AES-256-GCM + split-key), a verificação de assinatura Slack (HMAC + janela de replay + comparação timing-safe) e o burn-after-read atômico no `kv_store` (UNLOGGED + `FOR UPDATE`) estão bem encaminhados e cobertos por testes.

Para **distribuição no Slack Marketplace**, faltam peças críticas: **fluxo OAuth multi-workspace (install + callback)**, **URLs de privacy/support**, **handlers de desinstalação/revogação**, e **billing operacional** (hoje só há schema MAU + calculadora de tiers, sem Stripe/enforcement). Há também riscos de **SLA de 3s** em caminhos síncronos pesados e um **fallback de master key / signing secret hardcoded** perigoso se deployed sem env.

**Segredos no Git:** `.env.secret` e `*.tfvars` / `*.tfstate` estão no `.gitignore` e **não** aparecem tracked. `.env.secret` existe localmente (ignorado). Não se imprimiu conteúdo de secrets.

---

## Achados por tema

### 1. Verificação de assinatura Slack

| Aspecto | Status | Paths |
|--------|--------|-------|
| HMAC-SHA256 `v0:ts:body`, janela ±300s, comparação constant-time | OK | `packages/slack-kit/mod.ts` (`verifySlackSignature`, `timingSafeEqualString`, `slackSignatureMiddleware`) |
| Middleware aplicado em commands/interactions/(events) | OK | `apps/secret-app/main.ts`, `apps/queue-app/main.ts`, `apps/todo-app/main.ts` |
| Testes de assinatura / replay / tamper | OK | `packages/slack-kit/mod_test.ts`, `apps/secret-app/main_test.ts` |
| Fallback de signing secret de desenvolvimento | Risco | `getSigningSecret()` em cada app — default `dev_*_signing_secret` se env ausente |

### 2. Crypto / Secret (chave, burn-after-read)

| Aspecto | Status | Paths |
|--------|--------|-------|
| AES-256-GCM, IV 12B, master key 32B, encrypt OAuth token | OK | `packages/crypto/mod.ts` |
| Split-key: `K_eph` → server/client 128b; server half cifrada com master | OK | `createSplitSecret` / `revealSplitSecret` |
| Burn atômico / multi-view com auth pré-mutação | OK | `packages/db/kv.ts` (`burnSecret`, `consumeMultiViewSecret`) |
| Auth de destinatário antes de consumir views | OK | `apps/secret-app/main.ts` (~L349–361); teste unauthorized |
| `clientKeyHex` no `value` do botão Reveal | By design (PRD), mas limita “ZK” | `packages/slack-kit/mod.ts` `buildSecretActiveCard` — quem vê o Block Kit (e Slack) tem metade da chave |
| Fallback ephemeral com plaintext no chat se `views.open` falhar | Contradiz objetivo “nunca no histórico Slack” | `apps/secret-app/main.ts` (~L566–590), `buildSecretRevealedEphemeral` |
| Master key default hardcoded | **Bloqueador de segurança em prod** | `getMasterKeyHex()` → hex previsível `01234567…` em todos os apps |
| KV UNLOGGED (perda em crash sem WAL) | Aceitável p/ efêmero; documentar | `packages/db/migrations/001_init.sql` |

### 3. OAuth / multi-workspace / token storage

| Aspecto | Status | Paths |
|--------|--------|-------|
| Schema `workspace_installations` + token BYTEA cifrado | OK | `001_init.sql`, `packages/db/mod.ts` (`installationsRepo.find*` / `upsert`) |
| `encryptOAuthToken` / `decryptOAuthToken` | OK | `packages/crypto/mod.ts` |
| Rotas HTTP install/callback (`oauth.v2.access`, state CSRF, redirect) | **AUSENTE** | Nenhum handler em `apps/*/main.ts` |
| `oauth_config.redirect_urls` nos manifests | **AUSENTE** | `manifests/manifest-*.yaml` |
| Distribuição hoje assume `SLACK_BOT_TOKEN` / install manual single-workspace | Limitação | Comentários + `resolveBotToken` / fallbacks env |
| `token_rotation_enabled: false` | Gap Marketplace/hardening | manifests |
| Eventos `app_uninstalled` / `tokens_revoked` | **AUSENTE** | Nenhum handler |

### 4. Billing readiness

| Aspecto | Status | Paths |
|--------|--------|-------|
| Tiers free/team/growth/business/enterprise + `isMauLimitExceeded` | Parcial | `packages/billing/mod.ts` |
| Tracking MAU em Postgres | OK | `mauRepo.recordUserInteraction` em `packages/db/mod.ts`; chamado nas apps |
| Enforcement (bloquear criação acima do limite) | **AUSENTE** | Apps não consultam `isMauLimitExceeded` |
| Stripe Checkout / webhooks / App Home billing | **AUSENTE** | Schema tem `stripe_*` em `workspaces`, sem uso nas apps |
| Audit add-on UI ($99) / CSV / App Home Secret | Só backend condicional | `has_secret_audit_addon` + `secretAuditRepo`; sem App Home no Secret |

### 5. Compliance 3s ack

| Path | Avaliação |
|------|-----------|
| `/secret` command | Bom: `views.open` em background + `200` imediato (`apps/secret-app/main.ts` ~L101–145) |
| `view_submission` Secret | Risco: crypto + `kv.set` + enqueue outbox **síncronos** antes de `slackModalClear()` |
| `secret_reveal_click` | **Alto risco**: consume KV + decrypt + resolve token + `views.open` (e às vezes ephemeral/update) antes do response |
| `/queue` commands | Risco: `resolveBotToken` + `findOrCreateQueue` + mutações antes do JSON de resposta |
| Events Todo/Queue | Aceitável se responder rápido; App Home publish pode ser pesado (Todo/Queue fazem publish no request) |

### 6. Scopes (minimalidade)

| App | Scopes no manifest | Notas |
|-----|-------------------|--------|
| Secret | `commands`, `chat:write`, `chat:write.public` | Alinhado ao PRD Phase 1; `users_select` no modal tipicamente não exige `users:read` |
| Queue | + `users:read` | Justificável p/ kick/admin UX; validar se ainda necessário |
| Todo | `commands`, `chat:write`, `chat:write.public` | Sem `reactions:read` → emoji `:todo:` do PRD impossível; events só `app_home_opened` |
| Queue manifest | Sem `event_subscriptions` | App Home queue implementado em código (`/slack/events`) mas **não** no `manifest-queue.yaml` |

### 7. Privacy policy / Support URL (Marketplace)

- **Não há** páginas, rotas estáticas nem campos de marketplace docs no repo apontando Privacy Policy ou Support URL.
- Slack App Directory exige ambos para review — **bloqueador de submissão**.

### 8. Testes

- ~104 `Deno.test` espalhados: crypto (7), slack-kit (16), secret-app (10), queue (26), todo (15), worker (10), db/queue/todo, billing (1), outbox (4).
- Cobertura forte: assinatura, burn atômico, unauthorized reveal, OAuth token enc.
- Lacunas: OAuth install E2E (inexistente), billing enforcement, timeout worker, race 3s, desinstalação.

### 9. Gaps PRD ↔ implementação

| PRD | Implementação |
|-----|----------------|
| OAuth v2 installer multi-tenant (Phase 1) | Só persistência/leitura de token; sem HTTP OAuth |
| Submit Secret ao Marketplace | Bloqueado (OAuth + privacy/support + distribuição) |
| `/secret request`, Global Shortcut | Ausentes |
| App Home Audit + CSV | Ausente (só logs condicionais) |
| Secret scanning / reaction guardrail | Ausente |
| Queue: soft warning 5m + auto-expire | Worker tem `queue.auto_expire` / warnings — parcialmente alinhado |
| Queue: swap / round-robin / triage | Ausentes |
| Cross-sell Attach Secret no Queue | Presente (`queue_attach_secret_click`) |
| Todo: `reaction_added` `:todo:` | Ausente |
| Todo: NLP datas | Presente (`chrono-node` em `todo-app`) |
| Todo: App Home GTD | Presente |
| Suite Bundle / Stripe no App Home | Ausente |
| Cross-promo Secret→Todo reminder | Mencionado no card builder; fluxo completo frágil |
| Redis GETDEL | Substituído por Postgres UNLOGGED (decisão de stack OK se documentada) |
| Ack <150ms ideal / <3s hard | Commands Secret OK; interactions/queue ainda síncronas demais |

### 10. Segredos e higiene Git

- `.gitignore`: `.env`, `.env.*`, `*.tfvars`, `*.tfstate`, etc.
- `.env.secret` local: **ignorado**, não tracked.
- `terraform.tfvars` / `.tfstate` locais: ignorados (não commitados no `git ls-files`).
- Templates seguros: `terraform.tfvars.example`, Helm `secrets.yaml` (refs a K8s secrets, não valores).
- **Risco runtime:** defaults de `MASTER_ENCRYPTION_KEY_HEX` e signing secrets se o deploy esquecer env.

---

## Lista priorizada

### Bloqueadores para launch / Marketplace

1. **Implementar OAuth v2 multi-workspace** (authorize URL + callback com `oauth.v2.access`, state CSRF, `encryptOAuthToken` + `installationsRepo.upsert`, redirect HTTPS).  
   - Falta: rotas nas apps (ou serviço compartilhado).  
   - Atualizar: `manifests/manifest-*.yaml` → `oauth_config.redirect_urls`.  
   - PRD: `PRD2.md` Phase 1 §7.

2. **Privacy Policy URL + Support URL** públicos e configurados no app Slack (fora do código ou site estático). Sem isso o review do Directory rejeita.

3. **Handlers `app_uninstalled` / `tokens_revoked`** (+ event subscriptions nos manifests) para apagar/invalidar tokens e dados de instalação.  
   - Hoje: inexistente.

4. **Remover ou falhar-hard defaults de produção** para `MASTER_ENCRYPTION_KEY_HEX` e signing secrets (`apps/*/main.ts`, `outbox-worker`). Em prod sem env, a cifra fica previsível / assinatura aceita secret de dev.

5. **Distribuição Marketplace sem token único env** — hoje o caminho feliz ainda depende de `SLACK_BOT_TOKEN` / `*_APP_BOT_TOKEN`; sem OAuth populando `workspace_installations`, multi-workspace não escala.

### Importante

6. **SLA 3s no reveal e no `view_submission` do Secret** — ack imediato + trabalho async (outbox/`response_url`/`views.open` cedo). Paths: `apps/secret-app/main.ts` (submission ~L180–329, reveal ~L341+).

7. **Billing operacional** — chamar `isMauLimitExceeded` antes de criar secret/queue/todo; Stripe Checkout + webhook; UI App Home. Paths: `packages/billing/mod.ts`, schema `workspaces.stripe_*`, apps.

8. **Alinhar manifests × código** — `manifest-queue.yaml` sem events/`app_home` embora `queue-app` publique App Home; Todo sem scopes/events para reactions se for MVP PRD.

9. **Evitar plaintext no fallback ephemeral** do reveal — falhar fechado (mensagem “abra de novo” / DM modal) em vez de postar o segredo no Slack. `apps/secret-app/main.ts`, `buildSecretRevealedEphemeral`.

10. **Documentar modelo de ameaça ZK** — `clientKey` no botão é intencional; claim de marketing deve ser “servidor não armazena chave completa / ciphertext irrecuperável após burn”, não “Slack nunca vê material de chave”.

11. **Token rotation** — considerar `token_rotation_enabled: true` + refresh storage para Directory maturity.

12. **Secret App Home / Audit UI + export** (PRD Phase 1 milestone 3) — hoje só `secretAuditRepo` condicional.

### Nice-to-have

13. `/secret request` + Global Shortcut “Share a Secret” (`PRD1.md` §3.3).  
14. Reaction `:todo:` + `reactions:read` (`PRD2` Phase 3).  
15. Queue swap / round-robin / presence skip.  
16. Secret scanning em canais públicos.  
17. Suite cross-sell completo (Todo reminder a partir do Secret).  
18. Testes de carga no caminho reveal + integração OAuth.  
19. Purge/job periódico de `kv_store` expirado (índice existe; GC explícito ajuda).  
20. `org_deploy_enabled` / Enterprise Grid quando houver demanda (`PRD1` tenant isolation).

---

## Pontos positivos (não bloqueiam)

- Assinatura Slack correta e testada (`packages/slack-kit`).  
- Crypto split-key + testes (`packages/crypto`).  
- Burn/multi-view atômico com negação de auth sem consumir views (`packages/db/kv.ts` + testes Secret).  
- Outbox worker para card updates / queue expire (`apps/outbox-worker`).  
- Scopes Secret minimalistas — favorece review rápido.  
- Monorepo Deno organizado; manifests e docs de hosting presentes.  
- Segredos locais não tracked pelo Git.

---

## Conclusão

O núcleo técnico do **Secret** (crypto + assinatura + burn) está em bom estado para um MVP privado/single-workspace. Para **lançamento público no Slack Marketplace**, os bloqueadores reais são **OAuth multi-workspace**, **privacy/support URLs**, **lifecycle de tokens**, e **eliminar defaults criptográficos de desenvolvimento** — depois billing enforcement e endurecimento do ack de 3s nos caminhos de reveal/submission.
