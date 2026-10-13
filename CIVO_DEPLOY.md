# Guia Completo de Deploy Ponta a Ponta: Arquitetura Terraform em Camadas Isoladas (`01-foundation` + `02-releases`)

Este guia documenta a arquitetura de produção da suíte **BenedetLabsBots** seguindo o **padrão corporativo de isolamento de States e arquivos por escopo no Terraform**:

1. **`infra/01-foundation/` (Infraestrutura Geral / Nuvem):** Provisiona a rede, Firewall Zero-Trust, Chave SSH, Cluster K3s com **4 Node Pools dedicados na Civo** e o **Cloudflare Zero Trust Tunnel + DNS**.
2. **`infra/02-releases/` (Releases K8s / Helm):** Camada 100% isolada da infraestrutura física. Lê o state da fundação via `terraform_remote_state` e gerencia o Namespace, Secrets criptográficas e o **`helm_release` (`hashicorp/helm`)**.
3. **`infra/charts/slack-suite/` (Catálogo Helm):** Chart unificado contendo o PostgreSQL 18 (`StatefulSet` + Disco `Retain` + Backup), PgCache, Bots Deno, Outbox Worker e **OpenObserve + OpenTelemetry**.

---

## 1. Estrutura de Pastas e Arquivos por Escopo

```text
infra/
├── 01-foundation/                  # [CAMADA 1: INFRAESTRUTURA DE NUVEM — Civo + Cloudflare]
│   ├── versions.tf                 # Versão do Terraform e required_providers (civo, cloudflare, local, null, random)
│   ├── providers.tf                # Inicialização dos providers civo e cloudflare
│   ├── variables.tf                # Variáveis tipadas com blocos validation {} e mapa declarativo node_pools
│   ├── locals.tf                   # Convenções de nomes e mapa declarativo tunnel_routes
│   ├── ssh.tf                      # Escopo: Chave SSH Ed25519 na Civo
│   ├── network.tf                  # Escopo: Rede Civo + Firewall Zero-Trust (apenas porta 6443)
│   ├── k3s-cluster.tf              # Escopo: Cluster K3s (dynamic "pools" p/ os 4 Node Pools) + Labels de afinidade
│   ├── cloudflare-tunnel.tf        # Escopo: Cloudflare Zero Trust Tunnel + Ingress Rules dinâmicas
│   ├── cloudflare-dns.tf           # Escopo: Registros DNS CNAME (secret, queue, todo, observe)
│   ├── outputs.tf                  # Outputs exportados para o state (consumidos pela 02-releases)
│   └── terraform.tfvars.example    # Exemplo de variáveis de infraestrutura
│
├── 02-releases/                    # [CAMADA 2: RELEASES DE APLICAÇÃO — Kubernetes + Helm]
│   ├── versions.tf                 # required_providers (hashicorp/kubernetes, hashicorp/helm, hashicorp/random)
│   ├── data.tf                     # data "terraform_remote_state" "foundation" (lê outputs da 01-foundation)
│   ├── locals.tf                   # Decodificação automática do kubeconfig vindo do remote_state
│   ├── providers.tf                # Providers kubernetes e helm autenticados dinamicamente
│   ├── variables.tf                # Variáveis exclusivas de release (image_tag, réplicas, Slack secrets, GHCR)
│   ├── namespace.tf                # Escopo: Namespace Kubernetes `slack-suite`
│   ├── secrets.tf                  # Escopo: Geração de senhas criptográficas + Secret `ghcr-secret`
│   ├── helm-slack-suite.tf         # Escopo: resource "helm_release" "slack_suite" (atomic = true)
│   ├── outputs.tf                  # Outputs do release Helm e senhas geradas (Postgres / OpenObserve)
│   └── terraform.tfvars.example    # Exemplo de variáveis de release
│
└── charts/                         # [CATÁLOGO HELM ISOLADO]
    └── slack-suite/
        ├── Chart.yaml
        ├── values.yaml
        ├── files/
        │   └── 001_init.sql
        └── templates/
            ├── storageclass.yaml   # StorageClass `civo-volume-retain` (reclaimPolicy: Retain)
            ├── secrets.yaml        # Suite secrets + Auth OTLP do OpenObserve
            ├── postgres.yaml       # StatefulSet PG 18 (db-pool, 50Gi SSD) + CronJob Backup (20Gi SSD)
            ├── pgcache.yaml        # Deployment PgCache (cache-pool, 3Gi RAM)
            ├── apps.yaml           # Deployments secret, queue, todo (app-pool, 2 réplicas, OTEL_DENO=true)
            ├── worker.yaml         # Deployment outbox-worker (app-pool, 2 réplicas, OTEL_DENO=true)
            ├── cloudflared.yaml    # Deployment cloudflared-tunnel (app-pool, 2 réplicas)
            ├── openobserve.yaml    # StatefulSet OpenObserve (obs-pool, 30Gi SSD) + DaemonSet OTel Collector
            └── networkpolicy.yaml  # Isolamento Zero-Trust Leste-Oeste do PostgreSQL 18
```

### Por que separar `01-foundation` e `02-releases` é a melhor prática do Terraform?
1. **Ciclos de Vida Independentes:** Você sobe a fundação (`01-foundation`) uma única vez e faz dezenas de deploys de código por semana na `02-releases` em poucos segundos, sem tocar no cluster ou no DNS.
2. **Zero Travamento de Provider:** A HashiCorp recomenda nunca misturar o recurso que cria o cluster K8s com o `provider "helm"` no mesmo state. Com `01-foundation` e `02-releases` isolados e conectados via [`data.tf`](file:///Users/leonardobenedet/Code/BenedetLabsBots/infra/02-releases/data.tf), o `terraform plan` e `destroy` funcionam de forma 100% limpa e previsível.

---

## 2. Topologia dos 4 Node Pools Dedicados

| Node Pool | Máquina Civo | Especificação | Label (`nodeSelector`) | O que roda nele |
| :--- | :--- | :--- | :--- | :--- |
| **1. `db-pool`** | `g4s.kube.medium` | **4 vCPU, 8 GB RAM** | `workload-tier: database` | **PostgreSQL 18 (`StatefulSet`)** isolado com `2GB` de `shared_buffers`, `6GB` de `effective_cache_size`, disco de **50 GiB SSD (`Retain`)** + **CronJob de Backup (20 GiB SSD)** a cada 6h. |
| **2. `cache-pool`** | `g4s.kube.small` | **2 vCPU, 4 GB RAM** | `workload-tier: cache` | **PgCache Proxy** isolado com até **3 GiB de RAM** exclusivos para cache de consultas via CDC. |
| **3. `app-pool`** | `g4s.kube.medium` | **4 vCPU, 8 GB RAM** | `workload-tier: apps` | **2 réplicas** de cada bot (`secret`, `queue`, `todo`), **2 réplicas** do `outbox-worker` e **2 réplicas** do `cloudflared`. |
| **4. `obs-pool`** | `g4s.kube.medium` | **4 vCPU, 8 GB RAM** | `workload-tier: observability` | **OpenObserve (`StatefulSet`)** com disco de **30 GiB SSD (`Retain`)** recebendo Traces, Métricas e Logs via OTLP do Deno e do `otel-node-collector`. |

---

## 3. Passo a Passo para o Primeiro Deploy

### Fase 1: Gerar a Chave SSH e Instalar as CLIs no Mac

```bash
# 1. Gera o par de chaves Ed25519 dedicado para a Civo
ssh-keygen -t ed25519 -C "benedetlabs@gmail.com" -f ~/.ssh/id_ed25519_civo -N ""
chmod 600 ~/.ssh/id_ed25519_civo
chmod 644 ~/.ssh/id_ed25519_civo.pub
ssh-add ~/.ssh/id_ed25519_civo

# 2. Instala Terraform, Helm, Civo CLI, kubectl e k9s
brew install terraform helm civo kubectl k9s
```

---

### Fase 2: Comprar o Domínio e Configurar a Cloudflare

1. **Compre o domínio no próprio Cloudflare Registrar:**
   * Acesse [dash.cloudflare.com](https://dash.cloudflare.com/) > **Domain Registration > Register Domains**.
   * Comprando direto na Cloudflare, o DNS e os Nameservers já nascem ativos na hora.
2. **Ajuste SSL/TLS e Bot Fight Mode no painel do domínio:**
   * **SSL/TLS > Overview:** Selecione **Full** (ou **Full (Strict)**).
   * **Security > Bots:** Deixe o *Bot Fight Mode* desligado (ou crie uma regra em *Security > WAF > Custom rules* dando **Skip** quando `User Agent contains "Slackbot"`).
3. **Pegue os 3 dados da API da Cloudflare:**
   * Na página inicial do domínio (**Overview**), barra direita inferior: copie o **Zone ID** e o **Account ID**.
   * Em **My Profile > API Tokens > Create Custom Token**:
     * Permissões: `Account : Cloudflare Tunnel : Edit` e `Zone : DNS : Edit`.
     * Copie o token gerado.

---

### Fase 3: Provisionar a Camada 1 (`infra/01-foundation`)

```bash
# 1. Crie e preencha o terraform.tfvars da fundação
cp infra/01-foundation/terraform.tfvars.example infra/01-foundation/terraform.tfvars

# 2. Inicialize e aplique a infraestrutura base (Cluster K3s + 4 Node Pools + Cloudflare Tunnel & DNS)
terraform -chdir=infra/01-foundation init
terraform -chdir=infra/01-foundation apply
```

Assim que terminar (~90 segundos), valide os 4 nós rotulados:
```bash
export KUBECONFIG=~/.kube/config-civo
kubectl get nodes -L workload-tier
```

---

### Fase 4: Build e Push das Imagens Docker (`linux/amd64` + OpenTelemetry)

```bash
export GITHUB_TOKEN="ghp_SEU_TOKEN_DO_GITHUB"
echo "$GITHUB_TOKEN" | docker login ghcr.io -u benedetlabs --password-stdin

for APP in secret-app queue-app todo-app outbox-worker; do
  echo "🚀 Building & pushing ghcr.io/benedetlabs/$APP:v1.0.0..."
  docker buildx build \
    --platform linux/amd64 \
    --build-arg APP_NAME=$APP \
    -t ghcr.io/benedetlabs/$APP:v1.0.0 \
    --push .
done
```

---

### Fase 5: Aplicar a Camada 2 (`infra/02-releases` via `helm_release`)

A camada `02-releases` lê automaticamente o `kubeconfig` e o `cloudflare_tunnel_token` do state da `01-foundation`!

```bash
# 1. Crie e preencha o terraform.tfvars de releases (GHCR + Slack Signing Secrets)
cp infra/02-releases/terraform.tfvars.example infra/02-releases/terraform.tfvars

# 2. Inicialize e aplique o release Helm no cluster
terraform -chdir=infra/02-releases init
terraform -chdir=infra/02-releases apply
```

---

## 4. Consultando Credenciais e Operando no Dia a Dia

### 4.1 Recuperar Senhas Geradas (OpenObserve & PostgreSQL 18)
```bash
# Senha de Admin do OpenObserve (https://observe.seudominio.com)
terraform -chdir=infra/02-releases output -raw openobserve_admin_password ; echo

# Senha do PostgreSQL 18
terraform -chdir=infra/02-releases output -raw postgres_password ; echo
```

### 4.2 Atualizar Versão da Aplicação (`v1.0.1`) sem Tocar na Infraestrutura
Quando alterar código nos bots, você **só mexe na pasta `02-releases`**:
```bash
terraform -chdir=infra/02-releases apply -var="image_tag=v1.0.1"
```

### 4.3 Testar os Endpoints Públicos HTTPS
```bash
curl -i https://secret.seudominio.com/healthz
curl -i https://queue.seudominio.com/healthz
curl -i https://todo.seudominio.com/healthz
```
E acesse **`https://observe.seudominio.com`** para visualizar **Logs, Métricas dos 4 Nós e Distributed Traces (OpenTelemetry)** no OpenObserve!
