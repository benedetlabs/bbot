# Diretrizes do Workspace — BenedetLabsBots (bsuit.app)

Monorepo Deno 2.x + TypeScript para micro-utilitários Slack distribuídos via Cloudflare Tunnel e Kubernetes (k3s na Civo).

---

## 1. Segurança & Variáveis de Ambiente (Fail-Fast)

- **Zero fallbacks inseguros**: Nunca reintroduzir strings hardcoded ou previsíveis como fallback para `MASTER_ENCRYPTION_KEY_HEX`, signing secrets ou tokens de API.
- **Validação estrita**: Todas as aplicações devem inicializar e executar chamando `requireMasterKeyHex()` (`@suite/crypto`) e `requireNonEmptyEnv()` (`@suite/slack-kit`). Se qualquer variável obrigatória estiver ausente, a aplicação deve falhar imediatamente no startup (`fail-fast`).
- **Sigilo absoluto**: Nunca comitar nem registrar em logs conteúdos de `.env.secret`, `terraform.tfvars`, `terraform.tfstate`, kubeconfig, senhas de banco ou tokens de signing/bot.

---

## 2. Pipeline de Deploy (Civo / Terraform)

O procedimento oficial de publicação está documentado em [`CIVO_DEPLOY.md`](./CIVO_DEPLOY.md) e na instrução do agente deployer (`.cursor/agents/deploy.md`).

- **Build declarativo e seletivo**: O build e push das imagens para o GHCR (`ghcr.io/benedetlabs/*`) é feito exclusivamente pelo Terraform em `infra/02-releases`. Nunca rode comandos manuais de `docker build` ou `docker push` fora do Terraform.
- **Tags de Imagem**: As tags não são versões semver manuais; são hashes determinísticos (SHA-256 de 12 caracteres) calculados automaticamente a partir dos arquivos de cada app e seus pacotes compartilhados (`infra/02-releases/locals.tf`). Não defina nem incremente `image_tag` em `terraform.tfvars`.
- **Comando de deploy**:
  ```bash
  terraform -chdir=infra/02-releases apply
  ```
  *(Não use `-auto-approve` a menos que explicitamente solicitado pelo usuário).*
- **Verificação pós-deploy**:
  ```bash
  export KUBECONFIG=~/.kube/config-civo
  kubectl get pods -n slack-suite -o wide
  curl -i https://secret.bsuit.app/healthz
  ```

---

## 3. Diretrizes de Produto & Slack Marketplace (2025/2026)

- **Secret App (`/secret`) — Prioridade #1**:
  - Gera **links de uso único** (`https://secret.bsuit.app/s/:id`) abertos exclusivamente no navegador do destinatário com burn-after-read e split-key encryption.
  - **Não implementar mensagens autodestrutivas no Slack**: O Marketplace proíbe apps que deletam histórico de mensagens de forma destrutiva. O segredo nunca é enviado no canal em texto puro.
  - Hospeda diretamente suas páginas regulatórias e de onboarding: `/`, `/privacy`, `/support`, além de gerenciar OAuth (`/slack/install`, `/slack/oauth_redirect`).
  - Trata eventos obrigatórios de lifecycle: `app_uninstalled` e `tokens_revoked`, expurgando segredos ativos do workspace via `kv.deleteByWorkspaceId`.

- **Queue App (`/queue`) — Prioridade #2**:
  - Foco em locks de recursos (staging, deploy, pull request merges) em fila FIFO para times de DevOps.
  - Sincroniza card interativo no canal e gerencia notificações privadas via DM com fallback no Outbox Worker.

- **Todo App (`/todo`)**:
  - Em pausa estratégica como produto âncora; mantido funcional para futuro bundle upsell.

- **Gatekeep (Próximo produto / `docs/PRD_GATEKEEP.md`)**:
  - Camada de aprovação humana no Slack para agentes de IA e automações via MCP, REST API e SDKs, com binding de integridade via RFC 8785 (JCS canonical hash).

---

## 4. Performance & SLA do Slack (3 Segundos)

- Responda aos endpoints de comando slash e interações em menos de 3 segundos (retornando `200 OK` vazio, modal view ou resposta imediata).
- Processamentos pesados, chamadas com retry, alertas agendados e notificações com garantia de entrega devem sempre ser despachados via **Transactional Outbox Worker** (`@suite/outbox`).

---

## 5. Qualidade de Código & Testes

- Antes de finalizar alterações, execute a suíte de testes completa do monorepo:
  ```bash
  deno test -A
  ```
- Todas as novas funcionalidades ou refatorações devem manter 100% dos testes verdes.
