# Docs — BenedetLabs / bsuit.app

Validação feita em 14 out 2026 (America/Sao_Paulo).

| Documento | Conteúdo |
|-----------|----------|
| [VALIDACAO_MERCADO.md](./VALIDACAO_MERCADO.md) | Mercado, concorrentes, preço sugerido, regras do Slack Marketplace |
| [REVISAO_TECNICA.md](./REVISAO_TECNICA.md) | Revisão somente leitura do monorepo (segurança, OAuth, billing, 3s ack) |
| [PRD_GATEKEEP.md](./PRD_GATEKEEP.md) | Gatekeep: PRD + design técnico (aprovação humana p/ agentes de IA no Slack; MCP/API/SDKs, binding por hash, integração Secret/Queue/Todo) |

## Veredito rápido

1. **Secret** — promissor (prioridade #1)
2. **Queue** — promissor, nicho DevOps (#2)
3. **Todo** — fraco sozinho; manter no bundle

## Próximos passos (ordem sugerida)

1. Remover defaults hardcoded de master key / signing secrets
2. Implementar OAuth v2 multi-workspace + handlers `app_uninstalled` / `tokens_revoked`
3. Privacy + Support URLs + landing
4. Corrigir riscos de ack >3s (reveal Secret, `/queue`) e fallback ephemeral com plaintext
5. Conseguir ≥10 workspaces ativos antes / durante review do Marketplace
6. Posicionar Secret como *one-time secret links* (não “self-destructing messages”)
