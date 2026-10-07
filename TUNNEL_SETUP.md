# Guia de Configuração de Túneis: Cloudflare Tunnel & ngrok

Este guia orienta como expor localmente os serviços da suíte (`secret-app`,
`queue-app`, `todo-app`) para a API do Slack utilizando **Cloudflare Tunnel
(`cloudflared`)** ou **ngrok**.

---

## 1. Comparativo: Cloudflare Tunnel vs. ngrok

| Recurso                           | Cloudflare Quick Tunnel | Cloudflare Named Tunnel       | ngrok (Plano Free)                  |
| :-------------------------------- | :---------------------- | :---------------------------- | :---------------------------------- |
| **Custo**                         | Gratuito                | Gratuito                      | Gratuito                            |
| **Necessita Domínio?**            | Não                     | Sim                           | Não                                 |
| **URL Fixa?**                     | Não (muda ao reiniciar) | **Sim (seu domínio)**         | **Sim (1 estático grátis)**         |
| **Tela Intermediária de Aviso**   | Não                     | Não                           | Sim (em navegadores)                |
| **Múltiplos Serviços por Túnel**  | 1 por processo          | **Sim (múltiplos hostnames)** | Apenas 1 no plano free              |
| **Painel de Inspeção de Tráfego** | Logs CLI / Dashboard    | Dashboard Zero Trust          | Local Web (`http://localhost:4040`) |

---

## 2. Como Obter um Domínio Gratuito (ou Quase Gratuito) para o Cloudflare

A Cloudflare **não distribui domínios gratuitos diretamente** (ela vende
domínios a preço de custo / sem margem de lucro), e ela exige que o domínio
permita delegar servidores de nomes (**Nameservers / NS**).

Antigos serviços como Freenom (`.tk`, `.ml`) foram descontinuados. Hoje, as
opções viáveis são:

### Opção A: Domínio 100% Gratuito via `nic.eu.org` (Suporta Cloudflare)

O projeto sem fins lucrativos [nic.eu.org](https://nic.eu.org/) fornece
subdomínios gratuitos (ex.: `seubot.eu.org`) com suporte total a delegação de
DNS:

1. Crie uma conta no [nic.eu.org](https://nic.eu.org/).
2. Adicione o domínio planejado (ex: `meubot.eu.org`) no painel da Cloudflare
   (Plano Free) para obter os dois Nameservers da Cloudflare (ex:
   `chloe.ns.cloudflare.com` e `skip.ns.cloudflare.com`).
3. No painel do `eu.org`, cadastre a requisição do domínio informando os
   Nameservers da Cloudflare.
4. _Nota:_ A aprovação no `eu.org` é manual e pode levar de alguns dias a poucas
   semanas.

### Opção B: GitHub Student Developer Pack (Se for estudante)

Se você tem vínculo acadêmico, o
[GitHub Student Developer Pack](https://education.github.com/pack) oferece:

- 1 ano gratuito de domínio `.me` (via Namecheap).
- 1 ano gratuito de domínio `.tech` ou `.live`. Basta ativar o domínio no
  registrador e apontar os Nameservers para a Cloudflare.

### Opção C: Domínio de Baixo Custo (~R$ 5 a R$ 10 / US$ 1 a US$ 2 por ano)

Registradores como [Porkbun](https://porkbun.com) ou
[Namecheap](https://namecheap.com) vendem extensões promocionais como `.xyz`,
`.site`, `.top`, `.online` ou `.space` por menos de US$ 2 no primeiro ano.

1. Compre o domínio por ~US$ 1.
2. Adicione o domínio na sua conta Cloudflare.
3. Altere os servidores DNS no registrador para os da Cloudflare.

### Opção D: Usar o Domínio Estático Gratuito do ngrok (Sem precisar de domínio próprio)

Se o objetivo principal é apenas ter **uma URL estável gratuita sem comprar
domínio**, o ngrok oferece **1 domínio estático gratuito** vitalício por conta
(ver Seção 4).

---

## 3. Configurando Cloudflare Tunnel (`cloudflared`)

### Opção 3.1: Quick Tunnel (Sem cadastro, rápido para testes)

Gera uma URL aleatória temporária `https://<aleatorio>.trycloudflare.com`.

Adicione ao seu `docker-compose.yml`:

```yaml
cloudflared:
  image: cloudflare/cloudflared:latest
  container_name: suite-cloudflared
  restart: unless-stopped
  command: tunnel --no-autoupdate --url http://secret-app:8080
  depends_on:
    - secret-app
```

Inicie e visualize a URL gerada:

```bash
docker compose up -d cloudflared
docker compose logs -f cloudflared
```

Procure pela linha:

```text
https://xxxx-xxxx-xxxx.trycloudflare.com
```

---

### Opção 3.2: Named Tunnel via Cloudflare Zero Trust (Recomendado — URL Fixa e Multi-Serviços)

Essa configuração permite que um único container `cloudflared` exponha todos os
seus serviços locais através de subdomínios fixos.

#### Passo 1: Criar o Túnel no Cloudflare Zero Trust

1. Acesse o [Cloudflare Zero Trust](https://one.dash.cloudflare.com/).
2. Vá em **Networks** > **Tunnels** > **Create a Tunnel**.
3. Selecione o tipo **Cloudflared** e dê um nome (ex.: `slack-suite-local`).
4. Na tela de instalação, escolha a opção **Docker**.
5. Copie o token exibido após `--token` (ex.: `eyJhIjoi...`).

#### Passo 2: Configurar o Token no Ambiente

No arquivo `.env` (ou `.env.secret`):

```env
CLOUDFLARE_TUNNEL_TOKEN=eyJhIjoi...seu_token_aqui...
```

#### Passo 3: Adicionar o Serviço ao `docker-compose.yml`

```yaml
cloudflared:
  image: cloudflare/cloudflared:latest
  container_name: suite-cloudflared
  restart: unless-stopped
  environment:
    - TUNNEL_TOKEN=${CLOUDFLARE_TUNNEL_TOKEN}
  command: tunnel --no-autoupdate run
  depends_on:
    - secret-app
    - queue-app
    - todo-app
```

#### Passo 4: Configurar os Hostnames no Dashboard

Na aba **Public Hostnames** do seu túnel no dashboard da Cloudflare, crie as
rotas apontando para a rede interna do Docker:

| Subdomínio / Hostname   | Service Type | URL do Serviço    | Destino Interno |
| :---------------------- | :----------- | :---------------- | :-------------- |
| `secret.seudominio.com` | `HTTP`       | `secret-app:8080` | Secret App      |
| `queue.seudominio.com`  | `HTTP`       | `queue-app:8080`  | Queue App       |
| `todo.seudominio.com`   | `HTTP`       | `todo-app:8080`   | Todo App        |

_Nota:_ O `cloudflared` consegue resolver `secret-app:8080` diretamente porque
compartilha a mesma rede bridge do Docker Compose.

---

## 4. Configurando ngrok

### Opção 4.1: ngrok via Docker Compose com Domínio Estático Gratuito

O ngrok disponibiliza 1 domínio estático gratuito por conta no formato
`seu-nome.ngrok-free.app`.

#### Passo 1: Obter Token e Domínio Estático

1. Acesse [dashboard.ngrok.com](https://dashboard.ngrok.com/).
2. Vá em **Endpoints** > **Domains** e clique em **Claim static domain** (ex.:
   `alpha-bravo-charlie.ngrok-free.app`).
3. Vá em **Getting Started** > **Your Authtoken** e copie seu token de
   autenticação.

#### Passo 2: Configurar no `.env`

```env
NGROK_AUTHTOKEN=seu_authtoken_ngrok
NGROK_DOMAIN=alpha-bravo-charlie.ngrok-free.app
```

#### Passo 3: Adicionar o Serviço no `docker-compose.yml`

```yaml
ngrok:
  image: ngrok/ngrok:latest
  container_name: suite-ngrok
  restart: unless-stopped
  environment:
    - NGROK_AUTHTOKEN=${NGROK_AUTHTOKEN}
  command:
    - "http"
    - "--domain=${NGROK_DOMAIN}"
    - "secret-app:8080"
  ports:
    - "4040:4040" # Web UI do ngrok para inspecionar payloads do Slack
  depends_on:
    - secret-app
```

---

### Opção 4.2: ngrok via CLI do Host (macOS)

Se preferir rodar fora do Docker:

```bash
# Instalação via Homebrew
brew install ngrok/ngrok/ngrok

# Autenticação
ngrok config add-authtoken <SEU_TOKEN>

# Iniciar apontando para a porta exposta no host (ex: secret-app na porta 8081)
ngrok http 8081 --domain=<SEU_DOMINIO_ESTATICO>.ngrok-free.app
```

---

## 5. Atualizando os Manifests do Slack

Após obter sua URL pública (seja via Cloudflare ou ngrok), substitua o
placeholder `your-domain.com` nos manifestos da pasta
[`manifests/`](./manifests/):

### Exemplo para o `manifest-dev-suite.yaml` (URL Unificada)

```yaml
features:
  slash_commands:
    - command: "/secret"
      url: "https://secret.seudominio.com/slack/commands"
    - command: "/queue"
      url: "https://queue.seudominio.com/slack/commands"
    - command: "/todo"
      url: "https://todo.seudominio.com/slack/commands"

settings:
  interactivity:
    is_enabled: true
    request_url: "https://secret.seudominio.com/slack/interactions"
```

### Importando no Slack

1. Acesse [api.slack.com/apps](https://api.slack.com/apps).
2. Selecione seu aplicativo ou clique em **Create New App** > **From an app
   manifest**.
3. Cole o YAML atualizado com seus domínios reais.
4. Salve e reinstale o app no seu workspace de desenvolvimento.

---

## 6. Dicas de Diagnóstico e Troubleshooting

1. **Slack 3000ms Timeout:** O Slack exige resposta HTTP 200 em até 3 segundos
   após o envio de um comando ou interação. Certifique-se de que o container do
   app está saudável (`docker compose ps`).
2. **Inspecionar requisições do Slack em tempo real:**
   - **ngrok:** Abra `http://localhost:4040` no navegador para inspecionar
     headers, bodies e dar "Replay" em payloads do Slack.
   - **Cloudflare:** Acompanhe os logs via `docker compose logs -f cloudflared`
     ou no console do Cloudflare Zero Trust.
3. **Verificação de Saúde dos Bots:**
   ```bash
   curl -I https://secret.seudominio.com/healthz
   ```
   Deve retornar status `HTTP/2 200` com
   `{ "status": "ok", "app": "secret-app" }`.
