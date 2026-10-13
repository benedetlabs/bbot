# Guia Kubernetes: Acesso Remoto Local e Exposição Segura de Serviços

Este guia documenta como gerenciar o cluster Kubernetes (criado manualmente na Oracle Cloud / OCI) a partir da sua **máquina local (Mac)** e como **expor para a internet apenas serviços específicos** (como os webhooks dos Slack bots), mantendo bancos de dados, caches e o restante da infraestrutura 100% privados e isolados.

---

## 1. Visão Geral da Topologia de Rede e Segurança

Por padrão no Kubernetes, a rede interna de pods e serviços (**ClusterIP**) é **completamente isolada da internet pública**. Serviços como `PostgreSQL 18`, `PgCache`, filas e workers nunca devem receber tráfego direto de fora.

```text
  [ Sua Máquina Local (Mac) ]
              │
              ├── (Opção 1: Túnel SSH Criptografado :6443) ──┐
              └── (Opção 2: HTTPS Direto com SANs no Cert) ──┤
                                                             ▼
                                                ┌─────────────────────────┐
                                                │    k8s-control-plane    │
                                                │     kube-apiserver      │
                                                └─────────────────────────┘

  [ Internet / Slack Platform ]
              │
              ▼ (HTTPS / TLS 1.3)
  ┌───────────────────────────────┐
  │      CLOUDFLARE EDGE WAF      │
  └──────────────┬────────────────┘
                 │
                 ▼ (Cloudflare Tunnel Seguro - Zero Portas Abertas)
  ┌────────────────────────────────────────────────────────────────────────┐
  │                      CLUSTER KUBERNETES NA ORACLE                      │
  │                                                                        │
  │  ┌──────────────────────────────────────────────────────────────────┐  │
  │  │   Pod: cloudflared (Agente do Túnel rodando dentro do K8s)       │  │
  │  └───────────────┬───────────────────┬───────────────────┬──────────┘  │
  │                  │                   │                   │             │
  │   (HTTP Interno) │    (HTTP Interno) │    (HTTP Interno) │             │
  │                  ▼                   ▼                   ▼             │
  │          ┌───────────────┐   ┌───────────────┐   ┌───────────────┐     │
  │          │  secret-app   │   │   queue-app   │   │   todo-app    │     │
  │          │ (ClusterIP)   │   │ (ClusterIP)   │   │ (ClusterIP)   │     │
  │          └───────┬───────┘   └───────┬───────┘   └───────┬───────┘     │
  │                  │                   │                   │             │
  │                  └───────────────────┼───────────────────┘             │
  │                                      │ (Rede Interna 100% Privada)     │
  │                                      ▼                                 │
  │                          ┌───────────────────────┐                     │
  │                          │  PostgreSQL 18        │ ◄── BLOQUEADO PARA  │
  │                          │  + PgCache Proxy      │     A INTERNET      │
  │                          │ (ClusterIP :5432)     │                     │
  │                          └───────────────────────┘                     │
  └────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Como Acessar o Cluster da sua Máquina Local (Mac)

Para controlar o cluster com `kubectl` localmente no terminal do seu Mac, existem dois métodos:

### Método A: Túnel SSH Local (Recomendado — Sem mexer em certificados e sem abrir porta 6443)

Esta é a opção mais segura e imediata. Ela dispensa abrir a porta `6443` no firewall da Oracle e evita erros de certificado TLS (*hostname mismatch*), pois o tráfego passa por `localhost:6443`.

#### Passo 1: Baixar o arquivo `admin.conf` do Master para o seu Mac
No terminal do seu Mac:
```bash
# Copia o kubeconfig do nó master da Oracle para o seu Mac
scp ubuntu@<IP_PUBLICO_MASTER>:/home/ubuntu/.kube/config ~/.kube/config-oci-k8s
```

#### Passo 2: Ajustar o IP do servidor para localhost
Abra o arquivo `~/.kube/config-oci-k8s` no seu Mac e localize a linha `server:`:
```yaml
# Altere de:
server: https://10.0.0.10:6443
# Para:
server: https://127.0.0.1:6443
```

#### Passo 3: Criar o túnel SSH em segundo plano
No terminal do seu Mac, execute:
```bash
# Cria o túnel encaminhando a porta local 6443 para a porta 6443 do master
ssh -N -L 6443:localhost:6443 ubuntu@<IP_PUBLICO_MASTER> &
```

#### Passo 4: Testar o acesso local
```bash
kubectl --kubeconfig ~/.kube/config-oci-k8s get nodes
```
Você verá os nós do cluster diretamente no seu Mac!

> 💡 **Dica de Produtividade:** Adicione ao seu `~/.zshrc`:
> ```bash
> alias k-oci="kubectl --kubeconfig ~/.kube/config-oci-k8s"
> ```
> Assim basta digitar `k-oci get pods -A`.

---

### Método B: Acesso Direto via IP Público com Certificado SANs

Se você preferir conectar diretamente sem precisar manter um túnel SSH aberto:

#### Passo 1: Incluir o IP Público nos certificados do API Server (No Master)
Por padrão, o certificado do `kube-apiserver` só aceita conexões pelo IP privado interno. Para autorizar conexões pelo IP público ou domínio da Oracle:

* **Se você está inicializando o cluster agora:**
  ```bash
  sudo kubeadm init \
    --apiserver-advertise-address=10.0.0.10 \
    --apiserver-cert-extra-sans=<IP_PUBLICO_MASTER>,k8s.seudominio.com \
    --pod-network-cidr=10.244.0.0/16
  ```

* **Se o cluster já foi inicializado:**
  Execute no Master para regenerar o certificado incluindo o IP público:
  ```bash
  # 1. Faça backup dos certificados atuais
  sudo cp -r /etc/kubernetes/pki /etc/kubernetes/pki.bak

  # 2. Remova os certificados antigos do apiserver
  sudo rm /etc/kubernetes/pki/apiserver.crt /etc/kubernetes/pki/apiserver.key

  # 3. Regenere com o parâmetro --apiserver-cert-extra-sans
  sudo kubeadm init phase certs apiserver --apiserver-cert-extra-sans <IP_PUBLICO_MASTER>

  # 4. Reinicie o pod do apiserver (matando o container no containerd)
  sudo crictl pods --name kube-apiserver -q | xargs sudo crictl stopp
  ```

#### Passo 2: Liberar a porta 6443 na Security List da Oracle
No console OCI: `Networking > VCN > Security Lists > Default Security List` > **Add Ingress Rule**:
* **Source CIDR:** Seu IP público residencial (ou `0.0.0.0/0`)
* **IP Protocol:** `TCP`
* **Destination Port:** `6443`

#### Passo 3: Baixar e apontar o `kubeconfig` no Mac
No Mac, baixe o arquivo e configure o IP público:
```bash
scp ubuntu@<IP_PUBLICO_MASTER>:/home/ubuntu/.kube/config ~/.kube/config-oci-k8s
sed -i '' 's/10.0.0.10/<IP_PUBLICO_MASTER>/g' ~/.kube/config-oci-k8s
kubectl --kubeconfig ~/.kube/config-oci-k8s get nodes
```

---

## 3. Como Expor para o Mundo Apenas Serviços Específicos

No Kubernetes, existem 3 tipos fundamentais de Service:
1. **`ClusterIP` (Padrão):** O serviço **NÃO tem IP público** e só pode ser acessado de dentro do cluster. *(É aqui que o Postgres, PgCache e workers ficam).*
2. **`NodePort`:** Abre uma porta alta (30000-32767) em todas as VMs. *(Não recomendado expor diretamente na internet).*
3. **`LoadBalancer`:** Em nuvens gerenciadas, cria um balanceador público. Na OCI manual sem Cloud Controller Manager, fica em estado `<pending>`.

### A Solução Perfeita: Cloudflare Tunnel rodando como Pod no K8s

A forma mais elegante e segura de expor **apenas os bots do Slack** sem abrir qualquer porta externa no firewall da Oracle é rodar o **`cloudflared` dentro do próprio Kubernetes**.

O container do `cloudflared` se conecta de dentro para fora com a Cloudflare e atua como uma ponte direta para os `Services` do tipo `ClusterIP`.

---

## 4. Manifestos Práticos para Implantação

### 4.1 Passo 1: Criar o Tunnel no Painel da Cloudflare
1. Acesse: **Zero Trust > Networks > Tunnels > Add a tunnel**.
2. Nomeie como `k8s-oci-bots`.
3. Na tela de instalação, copie o **Tunnel Token** gerado.

---

### 4.2 Passo 2: Criar o Namespace e a Secret no Kubernetes

No seu Mac ou no Master:

```bash
# 1. Criar o namespace da aplicação
kubectl create namespace slack-suite

# 2. Criar a secret com o token do túnel Cloudflare
kubectl create secret generic cloudflare-tunnel-token \
  --from-literal=TUNNEL_TOKEN="<COLE_SEU_TUNNEL_TOKEN_AQUI>" \
  -n slack-suite
```

---

### 4.3 Passo 3: Manifesto do Cloudflare Tunnel no K8s (`k8s/cloudflared-deployment.yaml`)

Salve o arquivo abaixo e aplique com `kubectl apply -f k8s/cloudflared-deployment.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cloudflared-tunnel
  namespace: slack-suite
  labels:
    app: cloudflared
spec:
  replicas: 1
  selector:
    matchLabels:
      app: cloudflared
  template:
    metadata:
      labels:
        app: cloudflared
    spec:
      containers:
      - name: cloudflared
        image: cloudflare/cloudflared:latest
        args:
        - tunnel
        - --no-autoupdate
        - run
        env:
        - name: TUNNEL_TOKEN
          valueFrom:
            secretKeyRef:
              name: cloudflare-tunnel-token
              key: TUNNEL_TOKEN
        resources:
          requests:
            cpu: "50m"
            memory: "32Mi"
          limits:
            cpu: "200m"
            memory: "64Mi"
        securityContext:
          runAsNonRoot: true
          runAsUser: 65532
          allowPrivilegeEscalation: false
```

---

### 4.4 Passo 4: Manifesto dos Serviços dos Bots (`k8s/apps-services.yaml`)

Repare que todos os serviços são do tipo **`ClusterIP`** (sem IP público, 100% internos):

```yaml
apiVersion: v1
kind: Service
metadata:
  name: secret-app-svc
  namespace: slack-suite
spec:
  type: ClusterIP
  selector:
    app: secret-app
  ports:
  - name: http
    port: 80
    targetPort: 8080

---
apiVersion: v1
kind: Service
metadata:
  name: queue-app-svc
  namespace: slack-suite
spec:
  type: ClusterIP
  selector:
    app: queue-app
  ports:
  - name: http
    port: 80
    targetPort: 8080

---
apiVersion: v1
kind: Service
metadata:
  name: todo-app-svc
  namespace: slack-suite
spec:
  type: ClusterIP
  selector:
    app: todo-app
  ports:
  - name: http
    port: 80
    targetPort: 8080

---
# BANCO DE DADOS: 100% FECHADO
apiVersion: v1
kind: Service
metadata:
  name: postgres-origin-svc
  namespace: slack-suite
spec:
  type: ClusterIP
  selector:
    app: postgres-origin
  ports:
  - name: postgresql
    port: 5432
    targetPort: 5432
```

---

### 4.5 Passo 5: Mapear os Subdomínios Públicos no Painel da Cloudflare

No painel do túnel na Cloudflare (**Networks > Tunnels > k8s-oci-bots > Public Hostname**), adicione **apenas** o que o mundo externo pode acessar:

| Subdomínio Público | Tipo de Serviço | URL do Serviço Interno no Kubernetes |
| :--- | :--- | :--- |
| `secret.seudominio.com` | `HTTP` | `http://secret-app-svc.slack-suite.svc.cluster.local:80` |
| `queue.seudominio.com` | `HTTP` | `http://queue-app-svc.slack-suite.svc.cluster.local:80` |
| `todo.seudominio.com` | `HTTP` | `http://todo-app-svc.slack-suite.svc.cluster.local:80` |

#### O que Acontece com o PostgreSQL e o PgCache?
* Eles **NÃO possuem entrada no túnel**.
* A Cloudflare desconhece a existência deles.
* As VMs da Oracle não têm portas 5432 abertas na internet.
* Apenas os pods do `secret-app`, `queue-app` e `todo-app` dentro do cluster conseguem se conectar neles através do DNS interno `postgres-origin-svc.slack-suite.svc.cluster.local:5432`.

---

## 5. Camada Extra: Blindagem com `NetworkPolicy` (Zero-Trust Leste-Oeste)

Para garantir que, mesmo se um dos containers dos bots sofrer um ataque, o invasor não consiga escanear a rede interna do Kubernetes, aplicamos uma `NetworkPolicy` bloqueando conexões não autorizadas ao banco de dados:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: isolate-postgresql
  namespace: slack-suite
spec:
  podSelector:
    matchLabels:
      app: postgres-origin
  policyTypes:
  - Ingress
  ingress:
  # Permitir conexão na porta 5432 APENAS de pods com labels autorizadas
  - from:
    - podSelector:
        matchLabels:
          app: secret-app
    - podSelector:
        matchLabels:
          app: queue-app
    - podSelector:
        matchLabels:
          app: todo-app
    - podSelector:
        matchLabels:
          app: outbox-worker
    ports:
    - protocol: TCP
      port: 5432
```

---

## 6. Resumo das Regras de Ouro

1. **Acesso do Administrador (Você no Mac):**
   * Use o **Túnel SSH** (`ssh -N -L 6443:localhost:6443`). É instantâneo, não exige mexer em certificados e não deixa a porta do Kubernetes exposta para robôs de varredura na internet.
2. **Acesso da Internet (Slack e Usuários):**
   * Rode o **Cloudflare Tunnel como Pod no cluster**.
   * Deixe **zero portas de entrada (0 Ingress)** abertas no firewall da Oracle Cloud.
   * O mundo só enxerga os hostnames declarados no painel da Cloudflare, enquanto bancos, caches e workers permanecem hermeticamente protegidos.

---

## 7. Modo Ultra-Econômico: Cluster Single-Node (All-in-One) em 1 Única VM

Se o objetivo for **apenas brincar, testar manifestos e economizar ao máximo**, você **não precisa de múltiplas VMs**. Você pode rodar todo o Kubernetes em **1 única máquina virtual**.

### 7.1 Comparativo de Custos para 1 Única VM

| Cenário de Hardware | Cota Gratuita Deduzida | Excedente Faturado | Custo por Hora | Custo de um Teste de 5 Horas |
| :--- | :--- | :--- | :--- | :--- |
| **Opção A: 4 OCPUs + 24 GB RAM** | 4 OCPUs + 24 GB RAM | **Zero** | **$0,00 / hora** | **R$ 0,00 (100% Gratuito Permanente)** |
| **Opção B: 8 OCPUs + 24 GB RAM** | 4 OCPUs + 24 GB RAM | 4 OCPUs + 0 GB RAM | **$0,04 / hora** | **~$0,20 (~R$ 1,15)** |

> 💡 **Nota sobre a Opção B (8 OCPUs + 24 GB):** Como a cota gratuita permanente da Oracle já cobre **24 GB de RAM**, você paga **apenas pelas 4 OCPUs extras** ($0,01 × 4 = $0,04/hora). É um valor irrisório para ter uma máquina com 8 núcleos dedicados e 24 GB de memória!

---

### 7.2 Como Fazer o K8s Rodar em 1 Máquina Única

Por padrão, orquestradores vanilla bloqueiam a execução de pods de aplicação no nó master (para isolar o plano de controle). Em uma máquina única, removemos essa restrição com facilidade:

#### Método 1: K3s (Mais Simples — 1 Comando e Pronto)
O K3s já vem configurado de fábrica para atuar como master e worker simultaneamente:

```bash
# Executar na VM da Oracle
curl -sfL https://get.k3s.io | sh -

# Verificar o nó pronto
sudo kubectl get nodes
```
O K3s consome apenas ~500 MB de RAM, deixando **mais de 23 GB de memória livres** para o PostgreSQL 18 e todos os pods dos bots!

#### Método 2: `kubeadm` Vanilla (Removendo o Taint de Control Plane)
Se você preferir usar o Kubernetes vanilla oficial com `kubeadm`:

```bash
# 1. Inicializar normalmente
sudo kubeadm init --pod-network-cidr=10.244.0.0/16

# 2. Configurar kubectl local
mkdir -p $HOME/.kube
sudo cp -i /etc/kubernetes/admin.conf $HOME/.kube/config
sudo chown $(id -u):$(id -g) $HOME/.kube/config

# 3. Instalar o CNI de rede
kubectl apply -f https://github.com/flannel-io/flannel/releases/latest/download/kube-flannel.yml

# 4. REMOVER O BLOQUEIO DO MASTER (Permite que seus apps rodem no master):
kubectl taint nodes --all node-role.kubernetes.io/control-plane-
```

Pronto! A partir desse momento, a sua máquina única de **8 OCPUs (ou 4 OCPUs) e 24 GB de RAM** se comporta como um cluster Kubernetes completo, agendando Deployments, Services, StatefulSets e Ingress normalmente.

---

## 8. K3s em Produção e Alternativas Sólidas de Baixa Manutenção

### 8.1 O K3s Pode Ser Usado em Produção?

**Sim, 100%! O K3s é um projeto de nível corporativo e altamente produtivo.**

* **Certificação CNCF Oficial:** O K3s é uma distribuição **CNCF Certified Kubernetes**. Ele passa rigorosamente em todos os testes de conformidade que o Kubernetes padrão (`kubeadm`, EKS, GKE, AKS) exige. Qualquer manifesto, Helm Chart ou Operator que roda no K8s padrão roda identicamente no K3s.
* **Mantenedor de Peso:** É desenvolvido e suportado pela **SUSE / Rancher**, com comunidade massiva e anos de maturidade.
* **Casos Reais em Produção:** Provedores de nuvem pública inteiros (como a *Civo Cloud*) usam K3s como base do seu serviço de Kubernetes. Além disso, é o padrão da indústria para telecomunicações 5G, edge computing (fábricas, quiosques, navios) e milhares de startups hospedadas em instâncias individuais na Oracle, Hetzner e AWS.

#### Por que o K3s é tão amado para produção enxuta?
1. **Sem Inchaço (*Zero Bloat*):** O Kubernetes vanilla mantém código legado de integrações com provedores de nuvem antigos. O K3s removeu tudo isso, reduzindo o binário para menos de 100 MB.
2. **Armazenamento Flexível (Kine):** Em single-node, ele usa SQLite ultrarrápido em vez do etcd (economizando muita CPU/disco). Em cluster de alta disponibilidade (HA), ele suporta etcd embutido ou até mesmo um PostgreSQL/MySQL externo via driver Kine.
3. **Baterias Inclusas:** Já vem de fábrica com **containerd**, **Flannel CNI**, **Traefik Ingress**, **CoreDNS** e **Local Path Provisioner** pré-configurados e testados juntos.
4. **Atualizações com Zero Dor de Cabeça:** Atualizar a versão do Kubernetes no K3s é feito rodando um único script ou através do operador oficial *System Upgrade Controller*.

---

### 8.2 Outras Opções Sólidas e de Facílima Manutenção

Se você busca máxima facilidade com manutenção mínima (para gastar tempo desenvolvendo os bots e não gerenciando infraestrutura), aqui estão as melhores alternativas do mercado:

---

#### 1. Dokploy (PaaS Open-Source sobre Docker) — *A Recomendação Padrão do Projeto*
* **O que é:** Um painel moderno (estilo Railway/Coolify) que roda diretamente sobre o Docker da sua máquina.
* **Por que é tão prático:**
  * Interface visual web limpa com deploy direto via `git push` no GitHub.
  * O Traefik embutido gera e renova certificados SSL (Let's Encrypt) automaticamente.
  * Zero necessidade de escrever manifestos YAML de Kubernetes (`Service`, `Deployment`, `Ingress`, `PVC`).
  * Monitoramento de CPU/RAM em tempo real e visualizador de logs dos containers na interface.
* **Manutenção:** **Mínima (1/10).** Praticamente "configurar uma vez e esquecer".

---

#### 2. Coolify (O "Heroku / Netlify" Self-Hosted Mais Famoso)
* **O que é:** O projeto PaaS open-source mais popular do ecossistema atual.
* **Vantagens:**
  * Suporta mais de 50 serviços em 1 clique (PostgreSQL com backup automático no S3/Backblaze, Redis, MinIO, etc.).
  * Gerencia múltiplos servidores a partir de um único painel.
  * Roda sobre Docker nativo, extremamente rápido em processadores ARM64.
* **Manutenção:** **Muito Baixa (2/10).** Atualiza a si mesmo com 1 clique pelo painel.

---

#### 3. Docker Swarm (Orquestrador Nativo do Docker Engine)
* **O que é:** O orquestrador de containers que já vem instalado dentro do próprio Docker (`docker swarm init`).
* **Vantagens:**
  * Oferece os mesmos recursos centrais do Kubernetes (auto-healing de containers que caem, rolling updates sem downtime, réplicas e rede overlay criptografada entre múltiplos nós).
  * **Sintaxe idêntica ao `docker-compose.yml`:** Você usa exatamente o mesmo arquivo que usa no desenvolvimento local (`docker stack deploy -c docker-compose.yml suite`).
  * Consumo de memória quase nulo (menos de 50 MB de overhead).
* **Manutenção:** **Baixa (2/10).** Estabilidade de rocha, sem dependências de CNI ou etcd.

---

#### 4. MicroK8s (Canonical / Ubuntu)
* **O que é:** A distribuição Kubernetes oficial da Canonical (mantenedora do Ubuntu).
* **Vantagens:**
  * Instalação via Snap (`sudo snap install microk8s --classic`).
  * Add-ons ativáveis via linha de comando (`microk8s enable ingress dns cert-manager dashboard`).
  * Ideal se sua infraestrutura já for 100% padronizada em servidores Ubuntu.
* **Contras vs K3s:** Mais pesado no consumo de memória que o K3s e mais acoplado ao ecossistema Snap da Canonical.

---

### 8.3 Comparativo Pragmático de Decisão

| Critério | Dokploy / Coolify | Docker Swarm | K3s (Lightweight K8s) | K8s Vanilla (`kubeadm`) |
| :--- | :--- | :--- | :--- | :--- |
| **Curva de Aprendizado** | Baixíssima (minutos) | Muito Baixa (1 hora) | Média (exige noções K8s) | Alta (exige perfil DevOps) |
| **Manutenção no Dia a Dia** | Quase zero (Web UI) | Muito baixa (CLI Docker) | Baixa (Script/CLI) | Alta (certificados, etcd, CNI) |
| **Overhead de Recursos** | Mínimo (~150 MB) | Quase nulo (~50 MB) | Leve (~500 MB) | Pesado (2 GB a 3 GB) |
| **Deploy via Git (CI/CD)** | Nativo (Webhook Git) | Requer GitHub Actions | Requer ArgoCD/Actions | Requer ArgoCD/Actions |
| **Pronto para Produção?** | **Sim (Excelente para PMEs)**| **Sim (Ultra estável)** | **Sim (CNCF Certified)** | **Sim (Enterprise padrão)** |

---

### 8.4 Veredito: O Que Escolher para o BenedetLabsBots?

1. **Se você quer "paz de espírito", rapidez e foco 100% no código dos bots:**
   👉 **Dokploy** (ou **Coolify**). Você terá uma máquina com Traefik, SSL automático, deploy no `git push` e 23 GB de RAM dedicados integralmente às suas aplicações e banco de dados, sem complexidade de infraestrutura.
2. **Se você quer aprender e dominar Kubernetes profissionalmente sem sofrer com o peso do K8s clássico:**
   👉 **K3s**. É a escolha padrão da indústria hoje para rodar Kubernetes enxuto em produção. Você usa `kubectl`, escreve manifestos idênticos aos do AKS/EKS ([STACK2.md](file:///Users/leonardobenedet/Code/BenedetLabsBots/STACK2.md)) e roda com uma fração do custo e da manutenção.


