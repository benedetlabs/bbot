# Validação de mercado — bsuit.app (Slack micro-utilities)

**Autor da pesquisa:** Grok Bot (executor)  
**Para:** Leonardo Benedet (solo, Brasil)  
**Data:** 14 de outubro de 2026 (America/Sao_Paulo)  
**Produto:** suite PLG `bsuit.app` — Secret (`/secret`), Queue (`/queue`), Todo (`/todo` + App Home)  
**Público:** times de engenharia/DevOps/remoto  

> Metodologia: apenas fontes abertas realmente consultadas (WebSearch/WebFetch/API GitHub/X). Números de pricing/reviews só quando publicados nas páginas acessadas. Contagens de installs/reviews no Slack Marketplace **não** aparecem nos HTMLs públicos das listagens fetchadas — não inventamos esses sinais.

---

## 1. Resumo executivo

| App | Veredito | Motivo curto |
|-----|----------|--------------|
| **Secret** | **Promissor** | Dor real e recorrente (HN, X); vários players Slack-nativos e web; espaço para E2EE + escopos mínimos + preço workspace-friendly no Brasil/LATAM. |
| **Queue** | **Promissor (nicho)** | Dor clara de staging/deploy; Marketplace já tem Queue (ubots) e Dibs; Staging App cobra por usuário; freemium OSS existe. Diferenciar em DevOps + privacidade + locks FIFO. |
| **Todo** | **Lotado / fraco solo** | Todoist, Tatsu (ex-Kyber) e Todo (ubots) já cobrem “mensagem → tarefa” + App Home. Só faz sentido como **upsell leve no bundle**, não como produto âncora. |
| **Suite PLG** | **Viável com Marketplace** | Modelo ubots (vários apps focados) valida o formato; mudanças de ToS/rate limits 2025 empurram distribuição comercial para o Marketplace. |

**Preço sugerido (hipótese de go-to-market, não “benchmark oficial”):**

- **Free forever:** 1 workspace pequeno (ex.: até 10 usuários ativos ou N secrets/filas/mês).
- **Pro workspace:** **US$ 29–49/mês** pela suite (todas as apps), ou **US$ 4–6/usuário ativo/mês** se preferir seat-based.
- Apps avulsas: Secret ~US$ 19–29/ws; Queue ~US$ 15–25/ws; Todo só no bundle (ou free capped).
- Âncora competitiva: 1TimeLink cobra **US$ 49/mês** só por Slack secrets; LinkPilot Pro é **US$ 29/mês** (secrets + short links); Staging Premium **US$ 1,99/usuário**.

---

## 2. Slack Marketplace — requisitos e impacto nas apps (2025–2026)

### 2.1 Requisitos de listing (fontes oficiais)

Fontes:

- [Slack Marketplace app guidelines and requirements](https://docs.slack.dev/slack-marketplace/slack-marketplace-app-guidelines-and-requirements)
- [Slack Marketplace review guide](https://api.slack.com/slack-marketplace/review-guide) (redirect docs)
- [Updated installation requirement (1 set 2026)](https://docs.slack.dev/changelog/2026/09/01/slack-marketplace-install-requirement)

**Pontos práticos para um solo BR:**

1. **≥ 10 instalações em workspaces ativos** (usados nos últimos 28 dias) **durante toda a review** — limiar elevado em julho/2026 após um período temporário mais baixo ([changelog](https://docs.slack.dev/changelog/2026/09/01/slack-marketplace-install-requirement)).
2. App **pronto para produção**, testado end-to-end (inclui uninstall) fora do workspace de desenvolvimento.
3. **Landing pública**, **página de suporte** (resposta em até 2 dias úteis, sem exigir conta extra), **privacy policy** clara (dados coletados, uso, retenção, exclusão, contato).
4. Listing: short description ≤ 10 palavras; screenshots **1600×1000**, &lt; 2 MB; ícone de qualidade; pricing model declarado.
5. **Least privilege** de scopes; justificar cada scope; evitar `*:history` amplo sem caso claro.
6. Apps **inadequadas** incluem: export/backup de mensagens; “**self-destructing messages**” / deleção em massa; falta de funcionalidade *in* Slack; &lt; 10 WAUs; beta privado; etc. ([guidelines](https://docs.slack.dev/slack-marketplace/slack-marketplace-app-guidelines-and-requirements)).
7. Timeline típica de review: prelim até ~**10 dias úteis**; funcional até ~**10 semanas** (novas) / ~**6 semanas** (updates) ([review guide](https://api.slack.com/slack-marketplace/review-guide)).

**Implicação para Secret:** o guideline cita *self-destructing messages* como inadequado. Apps existentes usam **links one-time fora do histórico** (não apagam mensagens do Slack). Posicionar `/secret` como **geração de link efêmero**, nunca como “mensagem que some do canal”.

### 2.2 Rate limits `conversations.history` / `conversations.replies` (mai/2025)

Fontes:

- [Rate limit changes for non-Marketplace apps (29 mai 2025)](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/)
- [Clarifying rate limits (3 jun 2025)](https://docs.slack.dev/changelog/2025/06/03/rate-limits-clarity)
- [`conversations.history` method](https://docs.slack.dev/reference/methods/conversations.history)
- Espelho FAQ: [api.slack.com changelog](https://api.slack.com/changelog/2025-05-terms-rate-limit-update-and-faq)

**Resumo factual:**

| Tipo de app | Limite em history/replies |
|-------------|---------------------------|
| Marketplace aprovado | Tier 3 (50+/min; até ~1000 msgs) |
| Interno (customer-built) | Mantém limites altos |
| Comercial **fora** do Marketplace — apps novas / **novas installs** (após 29 mai 2025) | **1 req/min**, máx **15** objetos por request |

ToS atualizados reforçam: Marketplace é o canal apropriado para distribuição comercial.

**Impacto no bsuit:**

- Secret / Queue / Todo bem desenhados usam **slash commands, shortcuts, modals, App Home, Events API** — **não precisam** de `conversations.history` para o MVP.
- Message shortcut “transformar esta mensagem em secret/todo” recebe o payload da mensagem — sem history.
- **Mesmo assim**, listar no Marketplace é estratégico: ToS comercial + confiança de admins + rate limits se no futuro precisar de history.

---

## 3. App Secret — compartilhamento efêmero de credenciais

### 3.1 Concorrentes diretos (Slack + adjacentes)

| Player | Slack? | Pricing (publicado) | Notas | Fonte |
|--------|--------|---------------------|-------|-------|
| **LinkPilot** | Sim — `/secret`, shortcut “Send as secret link”; scope `commands` | Free: 5 secret links; **Pro US$ 29/mo** (50 secrets, passphrase, audit); Agency US$ 299/mo | Texto criptografado no serviço Slack; chave no `#` fragment; web app = caminho mais estrito | [uselinkpilot.com/slack](https://uselinkpilot.com/slack), [pricing](https://uselinkpilot.com/pricing) |
| **1TimeLink** | Sim — `/1tl` | Launch: **Standard US$ 49/mo** (até 1k users); **Enterprise US$ 99/mo**; On-prem sob consulta | E2EE, audit channel, purge-on-burn | [1timelink.com](https://1timelink.com/) |
| **SparkVault Sparks** | Sim — `/secret` ou `/share_secret` | Sparks **gratuitos, unmetered** em toda conta | Segredo Slack abre só na notificação Slack (não via x.sv) | [sparkvault.com/secret-sharing](https://sparkvault.com/secret-sharing/) |
| **EnvShareApp** | Sim — `/envshare` | **Pro US$ 5 one-time**; CLI/API/Slack; self-host | Foco DevOps `.env` | [envshare.app/for/devops](https://envshare.app/for/devops) |
| **Onetime Secret** | Sem app Slack nativo nas páginas consultadas | Basic **€0**; Identity Plus **€35/mês**; Team Plus **€125/mês** | Self-host OSS; API; branding | [onetimesecret.com/en/pricing](https://onetimesecret.com/en/pricing/), [docs pricing](https://docs.onetimesecret.com/en/pricing/) |
| **Doppler Share** | Web (colar link no Slack) | Ferramenta gratuita de share (upsell Doppler SecretOps) | “temporary URL”, encrypted | [share.doppler.com](https://share.doppler.com/) |
| **Yopass** | Web/self-host (marketing anti-Slack paste) | OSS **Free** self-host; Business License **€149/ano** | 3173★ / 446 forks (GitHub API 14 out 2026) | [yopass.se](https://yopass.se/), [github.com/jhaals/yopass](https://github.com/jhaals/yopass) |

GitHub adjacente: **onetimesecret/onetimesecret** ~2961★ (API GitHub, 14 out 2026).

### 3.2 Sinais de demanda (dor)

- **Ask HN (2020):** “How do you share passwords simply and securely?” — 60 pontos, 84 comentários; menções a Onetime Secret, Flashpaper, PrivateBin, e um time que já usava **`/secret` no Slack** apontando para instância própria ([news.ycombinator.com/item?id=23020183](https://news.ycombinator.com/item?id=23020183)).
- **Show HN Enseal (2026):** framing explícito — “Stop pasting secrets into Slack”; problema reconhecido no único comentário fetchado ([item?id=47132038](https://news.ycombinator.com/item?id=47132038)).
- **Show HN Stasher (ago/2025):** 72 pontos; autor: “Not trust Slack threads”; debate longo sobre trust/E2EE ([item?id=44823262](https://news.ycombinator.com/item?id=44823262)).
- **X (out/2026):** post de DevOps — equipes pequenas “need to stop pasting database credentials in Slack” ([x.com/dgniccum/status/2106821674821693942](https://x.com/dgniccum/status/2106821674821693942)); PrivateNote marketing “API key in Slack” ([x.com/privatenote_ai/status/2099484261191389633](https://x.com/privatenote_ai/status/2099484261191389633)).

Índices de busca apontam threads Reddit (`r/devops`, `r/SaaS`) sobre secrets no Slack; **fetch bloqueado** pela rede do Reddit — não citar conteúdo de corpo.

### 3.3 Gaps de diferenciação

1. **E2EE no cliente** (padrão Yopass/1TimeLink) + UX Slack tão simples quanto LinkPilot (`commands` only).
2. **Workspace billing** (não por pessoa com API key individual — dor do LinkPilot Free).
3. **Audit leve** (quem criou/abriu) sem enterprise tax.
4. **Residência / LGPD** (server BR/LATAM) — Onetime já vende soberania de dados; poucos Slack-nativos enfatizam BR.
5. **Bundle** com Queue (mesmo ICP DevOps): “não cole credenciais; não brigue por staging”.

### 3.4 Pricing sugerido + veredito

- Free: N secrets/mês + TTL curto.
- Paid: **US$ 19–29/ws/mês** (ou incluído no suite US$ 29–49).
- **Veredito: PROMISSOR** — mercado ativo, willingness-to-pay demonstrado (US$ 29–49), dor cultural confirmada; sucesso depende de confiança (crypto + privacy + Marketplace).

---

## 4. App Queue — filas FIFO / locks de recursos

### 4.1 Concorrentes

| Player | Canal | Pricing | Sinais | Fonte |
|--------|-------|---------|--------|-------|
| **Queue (ubots)** | [Slack Marketplace AQ2PPBWJX](https://slack.com/marketplace/AQ2PPBWJX-queue) | Premium por **nº de membros do workspace** (bots/guests excluídos); valor $ **não** publicado nas páginas HC/fetch | FIFO, status, timeout, stats, Workflows; parte da suite ubots | Marketplace + [ubots.co](https://ubots.co/) + [HC subscription](https://ubots.co/hc/how-to-manage-premium-plan-subscription-681b04d4abef444a991e50b52ac54f76/) |
| **Dibs On Stuff** | [Marketplace AT3N0PJUB](https://slack.com/marketplace/AT3N0PJUB-dibs-on-stuff) | Free; pagamentos opcionais via Buy Me A Coffee | Desde 2020; “installed all over the world”; “thousands of resources every day” (claim do site) | [dibsonstuff.com](https://dibsonstuff.com/) |
| **Staging (getstagingapp)** | Slack bot | Free: 2 envs; **Premium US$ 1,99/usuário/mês** (até 50 envs); Enterprise custom | Claim/release, auto-release, App Home | [getstagingapp.com](https://www.getstagingapp.com/) |
| **Lockbot** | OSS Slack | Self-host | `/lock`, `/unlock`, `/locks`; 61★ / 11 forks | [github.com/connorads/lockbot](https://github.com/connorads/lockbot) |
| **reservebot** | OSS | Self-host (memória) | Filas + namespaces | [github.com/ameliagapin/reservebot](https://github.com/ameliagapin/reservebot) |

Busca indexou artigo Medium sobre time que considerou Queue e Dibs mas rejeitou por **pedirem muitos dados** (IT) e construiu bot próprio — página Medium retornou 403 no fetch; não citar números do artigo.

### 4.2 Demanda

- Casos de uso explícitos nas listagens: staging, deploy, salas, tickets, AI capacity (Dibs), envs (Staging).
- Padrão recorrente: times **hackeiam canal Slack** (“quem está no staging?”) e depois querem bot.
- OSS Lockbot/reservebot mostram disposição a self-host quando SaaS parece “pesado” em scopes.

### 4.3 Gaps

1. Foco **DevOps-only**: deploy queue, PR review queue, env lock — sem diluir em “ping-pong table”.
2. **Escopos mínimos** + transparência de dados (contra a objeção IT citada em buscas).
3. Timeouts, auto-release, force-unlock com audit (melhor que Lockbot simples).
4. Integração leve GitHub/GitLab (notificar quando PR merge → liberar fila) — sem virar Jira.
5. Bundle com Secret.

### 4.4 Pricing + veredito

- Free: 1–2 filas / 2 recursos.
- Pro: **US$ 15–25/ws** ou **US$ 1,5–2,5/usuário ativo** (alinhar/undercut Staging US$ 1,99).
- **Veredito: PROMISSOR (nicho)** — não é oceano azul (ubots + Dibs + Staging), mas ICP engenharia paga e PLG funciona; Dibs free limita ceiling → posicionar UX/timeouts/privacy/suite.

---

## 5. App Todo — captura leve de ações

### 5.1 Concorrentes

| Player | Slack | Pricing | Fonte |
|--------|-------|---------|-------|
| **Todoist** | [Marketplace A0NSTB8R3](https://slack.com/marketplace/A0NSTB8R3-todoist) — `/todoist`, message → task | Beginner free; **Pro US$ 7/mês ou US$ 60/ano**; **Business US$ 10/user/mês ou US$ 8/user anual** | [FAQ pricing](https://www.todoist.com/help/account-and-billing/plans/todoist-plans-pricing-and-billing-faq-Vq2z0HWL6) (atualizado 8 out 2026) |
| **Tatsu** (adquiriu Kyber) | [Marketplace A0EP69E58](https://slack.com/marketplace/A0EP69E58-tatsu) — tasks, standups, polls, App Home | Trial 14 dias; anual: Privileged **US$ 3/participant/mo**; Everyone **US$ 2,50/participant/mo**; Enterprise sob consulta. Listing: “Trusted by hundreds of thousands of companies” (claim do listing) | [tatsu.io/pricing](https://tatsu.io/pricing), [changelog Kyber](https://tatsu.io/changelog/kyber_acquired) |
| **Todo (ubots)** | [Marketplace AU5C4QPQS](https://slack.com/marketplace/AU5C4QPQS-todo) | Pricing $ não nas páginas fetchadas; listing: “Join thousands of companies” | Marketplace + [ubots.co/llms.txt](https://ubots.co/llms.txt) |

Kyber pricing histórico (antes da aquisição): Startup $0 (≤5), Team **$3/user/mês** anual / **$4,50** mensal, Enterprise $9/$12 — página `kyber.me/pricing` retornou **500** no fetch; usar Tatsu como sucessor comercial.

### 5.2 Demanda e gaps

- Demanda genérica de “ação que nasce no Slack” é **alta**, mas já capturada por incumbents com sync multiplataforma (Todoist) ou suite nativa (Tatsu).
- Gap residual: **todo ultra-efêmero** (só App Home, sem segundo sistema, zero fricção, sem seats caros) — difícil monetizar sozinho.

### 5.3 Pricing + veredito

- Não vender Todo sozinho no mesmo preço de Tatsu/Todoist.
- No bundle: free capped / Pro suite.
- **Veredito: LOTADO / FRACO como standalone**; ok como feature de retenção da suite.

---

## 6. Modelo de suite PLG (bsuit.app)

**Referência de formato:** ubots — Queue + Todo + Memo + Expenses ([ubots.co](https://ubots.co/), [llms.txt](https://ubots.co/llms.txt)).

**Recomendação de oferta:**

1. Landing única `bsuit.app` + 3 Add to Slack (ou 1 app multi-feature com 3 commands — tradeoff de review scopes).
2. PLG: install → valor em &lt; 60s (`/secret`, `/queue join staging`).
3. Monetizar **workspace** (simplifica admin BR/PME) com free generous.
4. Ordem de build sugerida: **Secret → Queue → Todo (mínimo)**.
5. Meta pré-Marketplace: 10 workspaces amigos (startups BR, communities DevOps) antes de submeter.

---

## 7. Riscos e mitigações

| Risco | Mitigação |
|-------|-----------|
| Marketplace rejeita “self-destruct messages” | Só links one-time; nunca delete histórico Slack |
| Rate limits / ToS comercial 2025 | Planejar Marketplace desde o dia 1; evitar history |
| Trust em secrets (solo BR) | E2EE client-side, open design doc, pen-test quando houver receita, privacy clara |
| Dibs/Queue free canibalizam Queue | Diferenciar DevOps + timeouts + audit + bundle |
| Todo sem tração | Manter escopo mínimo; não competir com Todoist |
| 10 installs ativos | Beta fechado 8–12 semanas com ICP alvo |

---

## 8. Conclusão

Para um solo no Brasil buscando **indie income** via Slack:

- **Secret** e **Queue** têm dor comprovada e pricing de referência no mercado; a suite PLG é o caminho certo (não três startups).
- **Todo** é feature de suite, não âncora.
- **Listar no Slack Marketplace** deixou de ser “nice to have” após as mudanças de rate limit/ToS de maio/2025 e o limiar de 10 installs (2026).
- Posicionamento vencedor: *“micro-utilities de engenharia dentro do Slack — sem colar secrets, sem brigar por staging, sem abrir o Jira pra um follow-up.”*

---

## Apêndice — URLs consultadas (fetch/search reais)

### Slack / plataforma
- https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/
- https://docs.slack.dev/changelog/2025/06/03/rate-limits-clarity
- https://api.slack.com/changelog/2025-05-terms-rate-limit-update-and-faq
- https://docs.slack.dev/reference/methods/conversations.history
- https://docs.slack.dev/slack-marketplace/slack-marketplace-app-guidelines-and-requirements
- https://api.slack.com/slack-marketplace/review-guide
- https://docs.slack.dev/changelog/2026/09/01/slack-marketplace-install-requirement

### Secret
- https://uselinkpilot.com/slack · https://uselinkpilot.com/pricing
- https://1timelink.com/
- https://sparkvault.com/secret-sharing/
- https://envshare.app/for/devops
- https://docs.onetimesecret.com/en/pricing/ · https://onetimesecret.com/en/pricing/
- https://share.doppler.com/
- https://yopass.se/
- https://news.ycombinator.com/item?id=23020183
- https://news.ycombinator.com/item?id=47132038
- https://news.ycombinator.com/item?id=44823262
- https://x.com/dgniccum/status/2106821674821693942
- https://x.com/privatenote_ai/status/2099484261191389633

### Queue
- https://slack.com/marketplace/AQ2PPBWJX-queue
- https://ubots.co/ · https://ubots.co/llms.txt
- https://ubots.co/hc/how-to-manage-premium-plan-subscription-681b04d4abef444a991e50b52ac54f76/
- https://dibsonstuff.com/ · https://slack.com/marketplace/AT3N0PJUB-dibs-on-stuff
- https://www.getstagingapp.com/
- https://github.com/connorads/lockbot
- https://github.com/ameliagapin/reservebot

### Todo
- https://slack.com/marketplace/A0NSTB8R3-todoist
- https://www.todoist.com/help/account-and-billing/plans/todoist-plans-pricing-and-billing-faq-Vq2z0HWL6
- https://slack.com/marketplace/A0EP69E58-tatsu
- https://tatsu.io/pricing · https://tatsu.io/changelog/kyber_acquired
- https://slack.com/marketplace/AU5C4QPQS-todo

### GitHub API (stars em 14 out 2026)
- jhaals/yopass: 3173★  
- onetimesecret/onetimesecret: 2961★  
- connorads/lockbot: 61★  
