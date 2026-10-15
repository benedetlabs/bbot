# Guia Completo de Deploy Ponta a Ponta: Arquitetura Terraform em Camadas Isoladas (`01-foundation` + `02-releases`)

Este guia documenta a arquitetura de produção da suíte **BenedetLabsBots** seguindo o **padrão corporativo de isolamento de States e arquivos por escopo no Terraform**:

1. **`infra/01-foundation/` (Infraestrutura Geral / Nuvem):** Provisiona a rede dedicada, Firewall Zero-Trust, Chave SSH, Cluster K3s com **4 Node Pools dedicados na Civo** e o **Cloudflare Zero Trust Tunnel + DNS**.
2. **`infra/02-releases/` (Build Docker + Releases K8s/Helm por Projeto):** Camada 100% isolada da infraestrutura física. Lê o state da fundação via `terraform_remote_state`, **compila e faz push no GHCR automaticamente apenas dos projetos habilitados (`docker-build.tf`)**, gerencia o Namespace, Secrets criptográficas e o **`helm_release` (`hashicorp/helm`)**.
3. **`infra/charts/slack-suite/` (Catálogo Helm):** Chart unificado onde cada projeto (`secret-app`, `queue-app`, `todo-app`, `outbox-worker`) possui seu próprio `enabled`, `imageTag` e `replicas` independentes!

---

## 1. Estrutura de Pastas e Arquivos por Escopo

```text
infra/
├── 01-foundation/                  # [CAMADA 1: INFRAESTRUTURA DE NUVEM — Civo + Cloudflare]
│   ├── versions.tf                 # Versão do Terraform e required_providers (civo, cloudflare, local, random)
│   ├── providers.tf                # Inicialização dos providers civo (~/.civo.json) e cloudflare
│   ├── variables.tf                # Variáveis tipadas com blocos validation {} e mapa declarativo node_pools
│   ├── locals.tf                   # Convenções de nomes e mapa declarativo tunnel_routes
│   ├── ssh.tf                      # Escopo: Chave SSH Ed25519 na Civo
│   ├── network.tf                  # Escopo: Rede dedicada Civo + Firewall Zero-Trust (apenas porta 6443)
│   ├── k3s-cluster.tf              # Escopo: Cluster K3s + Node Pools dedicados + exportação do kubeconfig
│   ├── cloudflare-tunnel.tf        # Escopo: Cloudflare Zero Trust Tunnel + Ingress Rules dinâmicas
│   ├── cloudflare-dns.tf           # Escopo: Registros DNS CNAME (secret, queue, todo, observe)
│   ├── outputs.tf                  # Outputs exportados para o state (consumidos pela 02-releases)
│   └── terraform.tfvars.example    # Exemplo de variáveis de infraestrutura
│
├── 02-releases/                    # [CAMADA 2: BUILD & RELEASES POR PROJETO — Docker + K8s + Helm]
│   ├── versions.tf                 # required_providers (hashicorp/kubernetes, hashicorp/helm, hashicorp/random)
│   ├── data.tf                     # data "terraform_remote_state" "foundation" (lê outputs da 01-foundation)
│   ├── locals.tf                   # Decodificação do kubeconfig e filtro de projetos habilitados (enabled = true)
│   ├── providers.tf                # Providers kubernetes e helm autenticados dinamicamente
│   ├── variables.tf                # Mapa `projects` (enabled, replicas, signing_secret por projeto!)
│   ├── docker-build.tf             # Escopo: Compila (linux/amd64) e faz push no GHCR apenas dos projetos ativos!
│   ├── namespace.tf                # Escopo: Namespace Kubernetes `slack-suite`
│   ├── secrets.tf                  # Escopo: Geração de senhas criptográficas + Secret `ghcr-secret`
│   ├── helm-slack-suite.tf         # Escopo: resource "helm_release" "slack_suite" (atomic = true)
│   ├── outputs.tf                  # Outputs do release Helm e senhas geradas (Postgres / OpenObserve)
│   └── terraform.tfvars.example    # Exemplo de variáveis de release por projeto
│
└── charts/                         # [CATÁLOGO HELM ISOLADO]
    └── slack-suite/
        ├── Chart.yaml
        ├── values.yaml             # Configuração granular por projeto em `apps.projects.<nome>`
        ├── files/
        │   └── 001_init.sql
        └── templates/
            ├── storageclass.yaml   # StorageClass `civo-volume-retain` (reclaimPolicy: Retain)
            ├── secrets.yaml        # Suite secrets + Auth OTLP do OpenObserve
            ├── postgres.yaml       # StatefulSet PG 18 (db-pool, 50Gi SSD) + CronJob Backup (20Gi SSD)
            ├── pgcache.yaml        # Deployment PgCache (cache-pool, 3Gi RAM)
            ├── apps.yaml           # Deployments independentes por projeto (enabled, imageTag, replicas)
            ├── worker.yaml         # Deployment outbox-worker com imageTag próprio
            ├── cloudflared.yaml    # Deployment cloudflared-tunnel (app-pool, 2 réplicas)
            ├── openobserve.yaml    # StatefulSet OpenObserve (obs-pool, 30Gi SSD) + DaemonSet OTel Collector
            └── networkpolicy.yaml  # Isolamento Zero-Trust Leste-Oeste do PostgreSQL 18
```

---

## 2. Topologia dos 4 Node Pools Dedicados

| Node Pool | Máquina Civo | Especificação | Label (`nodeSelector`) | O que roda nele |
| :--- | :--- | :--- | :--- | :--- |
| **1. `db-pool`** | `g4s.kube.medium` | **4 vCPU, 8 GB RAM** | `kubernetes.civo.com/civo-node-pool: db-pool` | **PostgreSQL 18 (`StatefulSet`)** isolado com `2GB` de `shared_buffers`, `6GB` de `effective_cache_size`, disco de **50 GiB SSD (`Retain`)** + **CronJob de Backup (20 GiB SSD)** a cada 6h. |
| **2. `cache-pool`** | `g4s.kube.small` | **2 vCPU, 4 GB RAM** | `kubernetes.civo.com/civo-node-pool: cache-pool` | **PgCache Proxy** isolado com até **3 GiB de RAM** exclusivos para cache de consultas via CDC. |
| **3. `app-pool`** | `g4s.kube.medium` | **4 vCPU, 8 GB RAM** | `kubernetes.civo.com/civo-node-pool: app-pool` | Réplicas dos bots habilitados (`secret-app`, `queue-app`, `todo-app`), `outbox-worker` e `cloudflared`. |
| **4. `obs-pool`** | `g4s.kube.medium` | **4 vCPU, 8 GB RAM** | `kubernetes.civo.com/civo-node-pool: obs-pool` | **OpenObserve (`StatefulSet`)** com disco de **30 GiB SSD (`Retain`)** recebendo Traces, Métricas e Logs via OTLP do Deno e do `otel-node-collector`. |

---

## 3. Como Funciona o Deploy por Projeto e Tags Independentes (`02-releases`)

Agora você **não precisa** fazer build nem deploy de todos os bots de uma vez. A tag de cada imagem é o hash do código que aquele processo executa: a pasta do app, os pacotes que ele importa e os arquivos comuns de build (`Dockerfile`, `deno.json`, `deno.lock`). O SHA do commit fica só no rótulo `org.opencontainers.image.revision`.

No arquivo [`infra/02-releases/terraform.tfvars`](file:///Users/leonardobenedet/Code/BenedetLabsBots/infra/02-releases/terraform.tfvars.example):

```hcl
github_username         = "benedetlabs"
github_token            = "ghp_SEU_GITHUB_TOKEN_WRITE_E_READ_PACKAGES"
auto_build_images       = true
openobserve_admin_email = "benedetlabs@gmail.com"

projects = {
  "secret-app" = {
    enabled        = true
    replicas       = 2
    signing_secret = "SEU_SLACK_SECRET_SIGNING"
  }
  "queue-app" = {
    enabled        = false # Desativado: não faz docker build nem cria pods no K8s!
    replicas       = 2
    signing_secret = ""
  }
  "todo-app" = {
    enabled        = false # Desativado: não faz docker build nem cria pods no K8s!
    replicas       = 2
    signing_secret = ""
  }
}

worker = {
  enabled  = true
  replicas = 2
}
```

### O que acontece quando você roda `terraform -chdir=infra/02-releases apply`?
1. **Build seletivo automático ([`docker-build.tf`](infra/02-releases/docker-build.tf)):**
   * O Terraform olha apenas os projetos com `enabled = true` (no exemplo acima, apenas `secret-app` e `outbox-worker`).
   * Ele faz login no `ghcr.io`, executa o `docker buildx build --platform linux/amd64` só para o projeto habilitado cuja tag mudou, e faz o push para `ghcr.io/benedetlabs/<projeto>:<hash-do-código>`.
   * Os projetos com `enabled = false` (`queue-app` e `todo-app`) são ignorados: não gastam tempo de build, não exigem `signing_secret` e não criam Pods/Services no cluster!
2. **Rolling update só de quem mudou:**
   * Mudança em `apps/secret-app` troca só o Secret. Mudança em `packages/crypto`, `db`, `outbox` ou `slack-kit` troca os apps habilitados, porque todos importam esses pacotes.
   * O worker também importa `apps/queue-app/main.ts`, então mudança no Queue republica o worker. `packages/billing` não entra em nenhuma imagem.
   * Não há `image_tag` semver para incrementar.

---

## 4. Passo a Passo de Execução

### Passo 1: Infraestrutura Base (`01-foundation` — Já Provisionada!)
```bash
cp infra/01-foundation/terraform.tfvars.example infra/01-foundation/terraform.tfvars
terraform -chdir=infra/01-foundation init
terraform -chdir=infra/01-foundation apply
```

### Passo 2: Deploy de Releases e Aplicações (`02-releases`)
```bash
# 1. Copie e preencha o terraform.tfvars da camada de releases
cp infra/02-releases/terraform.tfvars.example infra/02-releases/terraform.tfvars

# 2. Inicialize e aplique (faz o docker buildx dos projetos ativos + instala o Helm Release!)
terraform -chdir=infra/02-releases init
terraform -chdir=infra/02-releases apply
```

---

## 5. Consultando Credenciais e Validando o Deploy

### 5.1 Recuperar Senhas Geradas (OpenObserve & PostgreSQL 18)
```bash
# Senha de Admin do OpenObserve (https://observe.bsuit.app)
terraform -chdir=infra/02-releases output -raw openobserve_admin_password ; echo

# Senha do PostgreSQL 18
terraform -chdir=infra/02-releases output -raw postgres_password ; echo
```

### 5.2 Verificar os Pods no Cluster
```bash
export KUBECONFIG=~/.kube/config-civo
kubectl get pods -n slack-suite -o wide
```

### 5.3 Testar os Endpoints Públicos HTTPS
```bash
curl -i https://secret.bsuit.app/healthz
```
E abra **`https://observe.bsuit.app`** no navegador para visualizar **Logs, Métricas dos 4 Nós e Distributed Traces (OpenTelemetry)** no OpenObserve!
