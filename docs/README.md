# Docs — BenedetLabs / bsuit.app

Validação feita em 14 out 2026 (America/Sao_Paulo).

| Documento | Conteúdo |
|-----------|----------|
| [VALIDACAO_MERCADO.md](./VALIDACAO_MERCADO.md) | Mercado, concorrentes, preço sugerido, regras do Slack Marketplace |
| [REVISAO_TECNICA.md](./REVISAO_TECNICA.md) | Revisão somente leitura do monorepo (segurança, OAuth, billing, 3s ack) |
| [PRD_GATEKEEP.md](./PRD_GATEKEEP.md) | Gatekeep: PRD + design técnico (aprovação humana p/ agentes de IA no Slack; MCP/API/SDKs, binding por hash, integração Secret/Queue/Todo) |

## Veredito rápido

1. **Secret** — promissor (prioridade #1). Produto atual: link de uso único, não mensagem que some do canal.
2. **Queue** — promissor, nicho DevOps (#2). Fora do ciclo atual; rebrand fica para depois.
3. **Todo** — pausado. Não é âncora.

## Estado dos seis passos

1. **Feito** — master key e signing secrets não têm default. Deploy sem env falha na subida.
2. **Feito no Secret** — `GET /slack/install`, callback `oauth.v2.access`, `app_uninstalled` e `tokens_revoked`. Falta preencher `SECRET_APP_CLIENT_ID` / `SECRET_APP_CLIENT_SECRET` no deploy.
3. **Feito no Secret** — `https://secret.bsuit.app/`, `/privacy` e `/support` são servidos pela app.
4. **Feito no Secret** — o segredo não volta para o Slack. A abertura é `POST /s/:id/open` no browser. O ack do `/queue` continua síncrono.
5. **Manual** — ainda é preciso ≥10 workspaces ativos (uso nos últimos 28 dias) durante a review. O caminho de install é `/slack/install`.
6. **Feito** — copy do manifest, modal e páginas falam em one-time secret link. A app não apaga mensagens do Slack.
