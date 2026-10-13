# Estratégia de Hospedagem: OCI Always Free + Dokploy + Cloudflare

Este documento formaliza a estratégia de infraestrutura e hospedagem de produção/homologação para a suíte **BenedetLabsBots** (`secret-app`, `queue-app`, `todo-app`, `outbox-worker` e camada de banco/cache). A arquitetura foi desenhada para atingir **custo zero permanente (R$ 0,00 / $0.00/mês)** com performance de nível corporativo e alta confiabilidade.

---

## 1. O que você ganha gratuitamente nessa stack

A combinação de **Oracle Cloud Infrastructure (OCI) Always Free**, **Dokploy** (PaaS self-hosted) e **Cloudflare** entrega uma infraestrutura robusta, moderna e com capacidade computacional superior a planos comerciais pagos de entrada e intermediários.

### 1.1 Oracle Cloud Infrastructure (OCI) — Always Free Tier (Cota Atualizada)

A Oracle disponibiliza uma das cotas gratuitas permanentes mais generosas do mercado através de instâncias baseadas em processadores **Ampere Altra (ARM64)**:

* **Processamento (Compute):**
  * **1.500 OCPU-horas por mês**, o que equivale exatamente a até **2 OCPUs dedicadas 24/7** com núcleos ARM Ampere A1 (arquitetura ARM64 / Neoverse-N1).
  * Pode ser provisionada como **1 VM (2 OCPUs + 12 GB RAM)** ou dividida em **2 VMs** (1 OCPU + 6 GB RAM cada).
* **Memória RAM:**
  * **9.000 GB-horas por mês**, o que equivale a **12 GB de RAM permanente** rodando 24 horas por dia.
  * *Contexto de valor:* 12 GB de RAM ainda é gigantesco para um plano gratuito (12× mais que o 1 GB oferecido por AWS EC2 t2.micro, GCP e2-micro ou Azure B1s). Permite rodar com folga o Dokploy, PostgreSQL 18, PgCache e múltiplos containers Deno.
* **Bônus AMD (x86_64):**
  * Além das instâncias ARM, a Oracle inclui **2 VMs AMD adicionais** (1/8 OCPU e 1 GB de RAM cada) para pequenas tarefas ou proxies auxiliares.
* **Armazenamento em Bloco (Block Volume):**
  * **200 GB de disco SSD/NVMe** de alta performance gratuitos.
* **Largura de Banda (Network Egress):**
  * **10 TB de tráfego de saída (egress) gratuito por mês**, com entrada ilimitada.
* **IP Público Estático:**
  * **1 endereço IPv4 público estático (reservado) gratuito**, além de blocos IPv6 (/64).


---

### 1.2 Dokploy (PaaS Open-Source Self-Hosted)

O **Dokploy** atua como o painel de controle e orquestrador de aplicações na máquina virtual, funcionando como uma alternativa moderna, rápida e open-source ao Railway, Render, Fly.io e Coolify:

* **Gerenciamento de Containers:**
  * Orquestra containers Docker e stacks completas com Docker Compose nativo.
  * Interface web limpa, intuitiva e sem overhead de orquestradores pesados como Kubernetes puro para workloads monomáquina.
* **Proxy Reverso e SSL Automático (Traefik Integrado):**
  * Vem com **Traefik** pré-configurado como proxy reverso de borda da VM.
  * Roteamento dinâmico de subdomínios (ex.: `secret.seudominio.com`, `queue.seudominio.com`, `todo.seudominio.com`).
  * Emissão e renovação automática de certificados SSL/TLS via Let's Encrypt (HTTP-01 ou DNS-01 challenge).
* **CI/CD e Deploys Contínuos via Git:**
  * Integração direta com repositórios GitHub / GitLab via Webhooks.
  * Disparo automático de builds no `git push` na branch configurada.
* **Compatibilidade Nativa ARM64:**
  * Roda com suporte pleno à arquitetura `arm64/aarch64`.
  * Como a imagem base do nosso monorepo é **Deno 2.9 (`denoland/deno:2.9.0`)** com compilação para Linux ARM64, os binários rodam nativamente nos núcleos Ampere A1 sem necessidade de emulação QEMU ou perda de performance.

---

### 1.3 Cloudflare (Plano Gratuito)

A **Cloudflare** é posicionada como a primeira camada de rede e segurança da stack, blindando a VM da Oracle contra a internet pública:

* **DNS Autoritativo Global Anycast:**
  * Resolução de nomes com propagação global em milissegundos.
  * Suporte a registros CNAME flattening no apex do domínio.
* **Proteção Anti-DDoS e Segurança de Borda:**
  * Mitigação ilimitada e não-metrificada de ataques DDoS em camadas 3, 4 e 7.
  * Ocultação do IP real da VM da Oracle através do proxy reverso com "nuvem laranja" ativada.
* **Terminação SSL/TLS e Criptografia:**
  * SSL/TLS Universal na borda com suporte a TLS 1.3, HTTP/2 e HTTP/3 (QUIC).
  * Modo **Full (Strict)** entre Cloudflare e o Traefik da VM, garantindo criptografia ponta a ponta (E2EE).
* **Cloudflare Tunnel (`cloudflared`) Opcional:**
  * Possibilidade de criar um túnel direto com a VM da Oracle, permitindo **fechar 100% das portas de entrada (ingress)** na Security List da OCI (Zero Open Inbound Ports).

---

## 2. Comparativo de Equivalência de Mercado

A tabela abaixo compara a cota gratuita permanente dessa stack com as opções comerciais equivalentes no mercado atual:

| Provedor / Serviço | Configuração de Hardware | Custo Estimado / Mês | Custo na Stack OCI + Dokploy |
| :--- | :--- | :--- | :--- |
| **AWS EC2** | `t4g.xlarge` (4 vCPU Graviton2, 16 GB RAM) + 200 GB EBS | ~$75 - $110/mês | **$0.00 (Grátis)** |
| **DigitalOcean** | Basic Droplet (4 vCPU, 16 GB RAM, 160 GB SSD) | ~$96/mês | **$0.00 (Grátis)** |
| **Hetzner Cloud** | `CAX31` (ARM 8 vCPU, 16 GB RAM, 160 GB NVMe) | ~€15 - €20/mês | **$0.00 (Grátis)** |
| **Railway** | 4 vCPU + 16-24 GB RAM (baseado em uso de recursos) | ~$60 - $90/mês | **$0.00 (Grátis)** |
| **Nossa Stack (OCI + Dokploy + Cloudflare)** | **2 OCPUs ARM Ampere + 12 GB RAM + 200 GB SSD + 10 TB Egress** | **R$ 0,00 / $0.00** | **Permanente Always Free** |


---

## 3. Topologia e Arquitetura de Comunicação

O fluxo de requisições dos Slack Bots através da stack ocorre conforme a topologia abaixo:

```text
       [ Slack Platform: Slash Commands & Interactivity ]
                               │
                               ▼ (HTTPS / TLS 1.3)
      ┌──────────────────────────────────────────────────┐
      │             CLOUDFLARE EDGE NETWORK              │
      │   - DNS Anycast                                  │
      │   - DDoS Mitigation Layer                        │
      │   - Edge SSL/TLS Termination (Strict Mode)       │
      │   - WAF & Rate Limiting                          │
      └────────────────────────┬─────────────────────────┘
                               │
                               ▼ (Proxy HTTPS / Cloudflare Tunnel)
      ┌──────────────────────────────────────────────────┐
      │       ORACLE CLOUD (OCI) ALWAYS FREE VM          │
      │        (4 OCPUs Ampere A1 • 24 GB RAM)           │
      │                                                  │
      │  ┌────────────────────────────────────────────┐  │
      │  │        Dokploy PaaS & Traefik Proxy        │  │
      │  │    - SSL Let's Encrypt / Internal Routing   │  │
      │  └──────────────────────┬─────────────────────┘  │
      │                         │                        │
      │     ┌───────────────────┼────────────────────┐   │
      │     ▼                   ▼                    ▼   │
      │ ┌───────────────┐ ┌───────────────┐ ┌──────────┐ │
      │ │  secret-app   │ │   queue-app   │ │ todo-app │ │
      │ │ (Deno 2.9 ARM)│ │ (Deno 2.9 ARM)│ │ (Deno ARM│ │
      │ └───────┬───────┘ └───────┬───────┘ └────┬─────┘ │
      │         │                 │              │       │
      │         └─────────────────┼──────────────┘       │
      │                           ▼                      │
      │                 ┌────────────────────┐           │
      │                 │   PostgreSQL 18    │           │
      │                 │  + PgCache Proxy   │           │
      │                 │ (200 GB NVMe Data) │           │
      │                 └────────────────────┘           │
      └──────────────────────────────────────────────────┘
```

---

## 4. Por que essa stack é perfeita para o BenedetLabsBots?

1. **Paridade ARM64:** O compilador nativo do **Deno 2.9** e as imagens base do projeto compilam para binários standalone Linux ARM64, rodando no nível do kernel com o menor consumo de memória e latência possível.
2. **Capacidade para toda a suíte:** 24 GB de RAM comporta com folga o PostgreSQL 18, o PgCache proxy, o outbox worker e os 3 bots de Slack simultaneamente, restando mais de 16 GB de RAM livres para crescimento e caching.
3. **Imunidade a Picos de Tráfego:** Os 10 TB de saída somados à proteção DDoS da Cloudflare garantem que picos de uso nos canais do Slack não gerem cobranças extras nem derrubem o serviço.
4. **Simplicidade de Operação:** O Dokploy elimina a complexidade excessiva de orquestração manual via SSH, oferecendo visualização gráfica de logs, monitoramento de saúde e deploy automático via GitHub.

---

## 5. Como Apontar um Domínio Comprado na Cloudflare para a VM na Oracle

Quando você adquire um domínio diretamente pelo **Cloudflare Registrar**, ele já fica **100% ativado e pré-configurado** com os Nameservers autoritativos da Cloudflare, dispensando qualquer espera de propagação de registrador ou troca manual de NS.

Existem duas abordagens para conectar esse domínio à sua instância OCI:

1. **Abordagem A (Padrão / Mais Rápida):** Apontamento DNS tradicional (Registro `A` + Proxy Nuvem Laranja) liberando portas 80/443 na Oracle.
2. **Abordagem B (Recomendada / Máxima Segurança):** Cloudflare Tunnel (`cloudflared`), mantendo todas as portas da Oracle 100% fechadas para a internet.

---

### Abordagem A: Apontamento via Registros DNS (Proxy Ativo)

#### Passo 1 — Obter o IP Público Estático na OCI
1. No console da Oracle Cloud, acesse: `Compute > Instances` e clique na sua VM Ampere.
2. Na seção **Instance Access** ou **Primary VNIC**, localize o campo **Public IP**.
3. *Importante:* Certifique-se de que o IP é **Reserved Public IP** (estático) e não efêmero, para que ele não mude caso a VM seja reiniciada.

#### Passo 2 — Liberar o Tráfego no Firewall da Oracle (VCN + Sistema Operacional)
> ⚠️ **Pegadinha Clássica da OCI:** A Oracle possui duas camadas de firewall independentes. Você precisa liberar as portas **em ambas**, senão a requisição não chega ao Traefik/Dokploy.

1. **Camada 1 — Security List da VCN (Nuvem):**
   * Vá em `Networking > Virtual Cloud Networks > [Sua VCN] > Security Lists > Default Security List`.
   * Clique em **Add Ingress Rules** e crie as seguintes regras:
     * **Source CIDR:** `0.0.0.0/0` (ou apenas os blocos de IP oficiais da Cloudflare)
     * **IP Protocol:** `TCP`
     * **Destination Port Range:** `80, 443`
     * **Description:** `HTTP e HTTPS para Traefik / Dokploy`
2. **Camada 2 — Firewall Interno do Linux (Host):**
   * Por padrão, as imagens Ubuntu/Oracle Linux da OCI bloqueiam portas externas no `iptables`/`firewalld`.
   * Acesse a VM via SSH e execute os comandos correspondentes:
     * **Se Ubuntu:**
       ```bash
       sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
       sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
       sudo netfilter-persistent save
       ```
     * **Se Oracle Linux:**
       ```bash
       sudo firewall-cmd --permanent --zone=public --add-service=http
       sudo firewall-cmd --permanent --zone=public --add-service=https
       sudo firewall-cmd --reload
       ```

#### Passo 3 — Criar os Registros de DNS no Painel da Cloudflare
1. Acesse o painel da Cloudflare e selecione o seu domínio recém-comprado.
2. Vá no menu lateral em **DNS > Records** e clique em **Add record**:
   * **Registro Apex (Raiz):**
     * **Type:** `A`
     * **Name:** `@` (ou o nome do seu domínio)
     * **IPv4 address:** `<SEU_IP_PUBLICO_DA_ORACLE>`
     * **Proxy status:** **Proxied (Nuvem Laranja ativada)** *(Protege o IP real da Oracle e ativa o DDoS/WAF)*.
     * **TTL:** `Auto`
   * **Registro Wildcard (para subdomínios dos bots):**
     * **Type:** `CNAME`
     * **Name:** `*`
     * **Target:** `@`
     * **Proxy status:** **Proxied (Nuvem Laranja ativada)**.
     *(Com o wildcard `*`, qualquer subdomínio como `secret.seudominio.com`, `queue.seudominio.com`, `todo.seudominio.com` ou `dokploy.seudominio.com` é automaticamente roteado para sua máquina).*

#### Passo 4 — Configurar Criptografia SSL/TLS na Cloudflare
1. No menu lateral, acesse **SSL/TLS > Overview**.
2. Defina o modo de encriptação:
   * **Full (Strict)**: Modo ideal. Exige que o Traefik do Dokploy tenha um certificado válido (Let's Encrypt gerado automaticamente pelo Dokploy ou um Cloudflare Origin Certificate instalado).
   * **Full**: Aceita certificado autoassinado inicial durante a subida dos containers.
3. No submenu **Edge Certificates**, ative:
   * **Always Use HTTPS:** `On`
   * **Minimum TLS Version:** `TLS 1.2` (ou `TLS 1.3`)

---

### Abordagem B: Cloudflare Tunnel (Recomendada — Zero Portas Abertas)

Se você preferir segurança máxima sem precisar abrir as portas 80/443 na Security List da Oracle, utilize o **Cloudflare Tunnel (`cloudflared`)**:

1. No painel da Cloudflare, acesse **Zero Trust > Networks > Tunnels**.
2. Clique em **Add a tunnel** e selecione **Cloudflare Tunnel (cloudflared)**.
3. Dê um nome ao túnel (ex.: `oci-benedet-bots`).
4. Copie o comando de instalação do conector via Docker fornecido pelo painel:
   ```bash
   docker run -d --restart=always --name cloudflared \
     cloudflare/cloudflared:latest tunnel --no-autoupdate run --token <SEU_TUNNEL_TOKEN>
   ```
5. Na aba **Public Hostname**, aponte os domínios para a porta local do Traefik/Dokploy:
   * **Subdomínio:** `*.seudominio.com` ou `secret.seudominio.com`
   * **Type:** `HTTP`
   * **URL:** `localhost:80` (o Traefik interno do Dokploy recebe o cabeçalho `Host` e despacha para o container correto).
6. **Vantagem:** A Security List da Oracle pode manter todas as regras de Ingress fechadas (`0.0.0.0` bloqueado), pois o túnel faz apenas conexões de saída (Outbound) para a Cloudflare.

---

## 6. Como Conectar os Subdomínios aos Apps no Dokploy

Com o DNS da Cloudflare configurado, configure o roteamento em cada app da suíte:

1. Acesse o painel web do Dokploy (`http://<IP_ORACLE>:3000` ou pelo domínio do Dokploy).
2. Para cada bot da suíte (**Secret**, **Queue**, **Todo**):
   * Abra a aplicação e vá na aba **Domains**.
   * Adicione o subdomínio desejado:
     * `secret-app` ➔ `secret.seudominio.com` (Container Port: `8001`)
     * `queue-app`  ➔ `queue.seudominio.com`  (Container Port: `8002`)
     * `todo-app`   ➔ `todo.seudominio.com`   (Container Port: `8003`)
   * O Traefik integrado do Dokploy gerencia o roteamento interno, balanceamento e certificados SSL automaticamente.
3. No portal do Slack App ([api.slack.com/apps](https://api.slack.com/apps)), configure as URLs de Request e Slash Commands usando as URLs seguras geradas:
   * Exemplo: `https://secret.seudominio.com/slack/commands`
   * Exemplo: `https://queue.seudominio.com/slack/events`

---

## 7. Escalar CPU e Memória: Como Funciona a Cobrança do Excedente

### 7.1 Sim, Você Paga Apenas o Excedente!

Na Oracle Cloud (OCI), o modelo para ultrapassar a cota gratuita funciona através da atualização da conta para **Pay As You Go (PAYG)**:

1. **A cota gratuita NÃO é perdida:** A Oracle concede mensalmente um desconto fixo de **1.500 OCPU-horas** e **9.000 GB-horas** de instâncias Ampere A1. Isso equivale exatamente a **2 OCPUs e 12 GB de RAM rodando 24 horas por dia, 7 dias por semana**, durante todo o mês.
2. **Cobrança granular:** Ao aumentar para 4, 8 ou 16 OCPUs, a fatura deduz primeiro a cota gratuita integral (2 OCPUs + 12 GB) e cobra **estritamente a diferença (o excedente)** consumida pelas horas ativas.
3. **Forma Flexível (`VM.Standard.A1.Flex`):** Você não precisa escolher pacotes rígidos pré-fixados. É possível customizar livremente a proporção (ex.: 4 OCPUs com 12 GB de RAM, pagando apenas a CPU extra, ou 2 OCPUs com 24 GB de RAM, pagando apenas a memória extra).

---

### 7.2 Valores Unitários dos Recursos Ampere A1 (Regiões dos EUA / Global)

Os preços da Oracle são padronizados globalmente (incluindo as regiões dos EUA, como `us-ashburn-1` e `us-phoenix-1`):

| Recurso | Preço por Hora | Preço Médio Mensal (~730 horas) |
| :--- | :--- | :--- |
| **OCPU Adicional (Ampere A1)** | **$0,0100** / OCPU-hora | **~$7,30** por OCPU / mês |
| **Memória RAM Adicional** | **$0,0015** / GB-hora | **~$1,10** por GB / mês |

---

### 7.3 Exemplos Práticos de Dimensionamento e Fatura Mensal

Considerando a dedução automática da cota Always Free atualizada (2 OCPUs e 12 GB RAM gratuitos deduzidos na fatura):

| Configuração Total da VM | Cota Gratuita Deduzida | Excedente Cobrado | Cálculo do Custo Mensal | Valor Final a Pagar |
| :--- | :--- | :--- | :--- | :--- |
| **2 OCPUs + 12 GB RAM** | 2 OCPUs + 12 GB RAM | **Zero** | $0,00 + $0,00 | **$0,00 / mês (100% Grátis)** |
| **4 OCPUs + 12 GB RAM** | 2 OCPUs + 12 GB RAM | 2 OCPUs + 0 GB RAM | 2 × $7,30 | **~$14,60 / mês** |
| **4 OCPUs + 24 GB RAM** | 2 OCPUs + 12 GB RAM | 2 OCPUs + 12 GB RAM | (2 × $7,30) + (12 × $1,10) | **~$27,80 / mês** |
| **8 OCPUs + 24 GB RAM** | 2 OCPUs + 12 GB RAM | 6 OCPUs + 12 GB RAM | (6 × $7,30) + (12 × $1,10) | **~$57,00 / mês** |
| **8 OCPUs + 32 GB RAM** | 2 OCPUs + 12 GB RAM | 6 OCPUs + 20 GB RAM | (6 × $7,30) + (20 × $1,10) | **~$65,80 / mês** |
| **16 OCPUs + 32 GB RAM** | 2 OCPUs + 12 GB RAM | 14 OCPUs + 20 GB RAM | (14 × $7,30) + (20 × $1,10) | **~$124,20 / mês** |

> 💡 *Comparativo de Mercado:* Na AWS, uma máquina equivalente a 8 vCPUs e 32 GB de RAM (`c6g.2xlarge`) custa aproximadamente **$195 a $220/mês**. Na OCI com o desconto Always Free aplicado, o custo cai para **menos de $66/mês**.


---

### 7.4 Benefício Oculto do Upgrade para Pay As You Go (PAYG)

Ao cadastrar um método de pagamento e fazer o upgrade da conta para PAYG (onde ocorre apenas uma pré-autorização temporária de ~$100 no cartão para validação, que é imediatamente estornada):

* **Imunidade à Reivindicação de Instâncias Ociosas:** Contas no tier estritamente gratuito podem ter instâncias desativadas pela Oracle se ficarem com CPU abaixo de 10% por 7 dias contínuos. Contas **PAYG nunca perdem instâncias**, mesmo que a sua fatura continue vindo zerada ($0,00).
* **Prioridade de Capacidade:** Em regiões com alta demanda por processadores Ampere A1 (como Ashburn), clientes PAYG têm prioridade imediata de provisionamento sobre contas gratuitas.

---

## 8. Laboratório Temporário: Cluster Kubernetes (k8s) Manual na OCI (16 OCPUs e 32 GB RAM)

Este guia orienta como subir um cluster Kubernetes multi-nó **100% manual (via VMs Ampere A1)** para testes e benchmarks pontuais, mantendo o controle total de custos.

---

### 8.1 Cálculo do Custo do Teste Temporário (Cobrança por Hora)

Como você só pagará as horas em que as máquinas estiverem ativas, o custo de um laboratório temporário é desprezível:

* **Hardware Total Alocado:** 16 OCPUs + 32 GB RAM.
* **Cota Always Free Descontada:** 4 OCPUs + 24 GB RAM (gratuitos).
* **Excedente Efetivamente Faturado:** 12 OCPUs + 8 GB RAM.
* **Custo por Hora do Excedente:**
  $$\text{CPU: } 12 \times \$0,01 = \$0,12/\text{hora}$$
  $$\text{RAM: } 8 \times \$0,0015 = \$0,012/\text{hora}$$
  $$\textbf{Custo Total: } \mathbf{\$0,132/\text{hora}} \text{ (aproximadamente R\$ 0,75 por hora)}$$

#### Simulação de Duração do Teste:
* **Teste de 4 horas:** $\$0,132 \times 4 = \mathbf{\$0,53}$ (~R$ 3,00)
* **Teste de 8 horas (dia de trabalho):** $\$0,132 \times 8 = \mathbf{\$1,06}$ (~R$ 6,00)
* **Teste de 24 horas ininterruptas:** $\$0,132 \times 24 = \mathbf{\$3,17}$ (~R$ 18,00)

> ⚠️ **Regra de Ouro:** Ao concluir o laboratório, selecione as instâncias de teste e clique em **Terminate** (marcando a opção para excluir o Boot Volume). Dessa forma, a cobrança cessa imediatamente no exato segundo da exclusão.

---

### 8.2 Topologia das VMs (4 Nós Simétricos)

Distribuímos os **16 OCPUs e 32 GB de RAM** em uma arquitetura de 4 nós utilizando o shape `VM.Standard.A1.Flex` com imagem **Ubuntu 24.04 ou 22.04 LTS (aarch64 / ARM64)**:

| Nome da VM | Papel no Cluster | OCPUs | RAM | IP Privado Exemplo |
| :--- | :--- | :--- | :--- | :--- |
| `k8s-control-plane` | Master / API Server / etcd | 4 OCPUs | 8 GB | `10.0.0.10` |
| `k8s-worker-01` | Worker Node | 4 OCPUs | 8 GB | `10.0.0.11` |
| `k8s-worker-02` | Worker Node | 4 OCPUs | 8 GB | `10.0.0.12` |
| `k8s-worker-03` | Worker Node | 4 OCPUs | 8 GB | `10.0.0.13` |
| **Total Combinado** | **1 Master + 3 Workers** | **16 OCPUs** | **32 GB** | — |

---

### 8.3 Configuração de Rede na OCI (VCN & Security List)

Antes de rodar qualquer comando no Linux, configure a rede da Oracle para não bloquear a comunicação interna dos pods:

1. Acesse: `Networking > Virtual Cloud Networks > [Sua VCN] > Security Lists > Default Security List`.
2. Adicione as seguintes regras de **Ingress**:
   * **Comunicação Interna do Cluster (Crítica):**
     * **Source CIDR:** `10.0.0.0/16` (o bloco da sua sub-rede privada)
     * **IP Protocol:** `All Protocols`
     * **Description:** `Permitir tráfego total irrestrito entre os nós do cluster K8s`
   * **Acesso Externo ao API Server (Opcional - para kubectl local):**
     * **Source CIDR:** `0.0.0.0/0` (ou seu IP residencial)
     * **IP Protocol:** `TCP`
     * **Destination Port:** `6443`

---

### 8.4 Passo a Passo Manual com `kubeadm` e `containerd`

Execute os passos a seguir via SSH nas instâncias criadas.

#### Etapa 1: Preparação do Sistema Operacional (EXECUTAR EM TODOS OS 4 NÓS)

```bash
# 1. Desabilitar Swap (Obrigatório para o Kubernetes)
sudo swapoff -a
sudo sed -i '/ swap / s/^\(.*\)$/#\1/g' /etc/fstab

# 2. Carregar módulos de kernel para rede e ponte de containers
cat <<EOF | sudo tee /etc/modules-load.d/k8s.conf
overlay
br_netfilter
EOF

sudo modprobe overlay
sudo modprobe br_netfilter

# 3. Ajustar parâmetros de sysctl para encaminhamento de pacotes
cat <<EOF | sudo tee /etc/sysctl.d/k8s.conf
net.bridge.bridge-nf-call-iptables  = 1
net.bridge.bridge-nf-call-ip6tables = 1
net.ipv4.ip_forward                 = 1
EOF

sudo sysctl --system

# 4. Ajustar iptables local da Oracle para não barrar portas internas
sudo iptables -P INPUT ACCEPT
sudo iptables -P FORWARD ACCEPT
sudo iptables -F
sudo netfilter-persistent save 2>/dev/null || true
```

#### Etapa 2: Instalar o Container Runtime `containerd` (EXECUTAR EM TODOS OS 4 NÓS)

```bash
# Instalar containerd
sudo apt-get update
sudo apt-get install -y containerd

# Gerar configuração padrão com systemd cgroup driver ativo
sudo mkdir -p /etc/containerd
containerd config default | sudo tee /etc/containerd/config.toml > /dev/null
sudo sed -i 's/SystemdCgroup = false/SystemdCgroup = true/g' /etc/containerd/config.toml

# Reiniciar e habilitar containerd
sudo systemctl restart containerd
sudo systemctl enable containerd
```

#### Etapa 3: Instalar `kubeadm`, `kubelet` e `kubectl` (EXECUTAR EM TODOS OS 4 NÓS)

```bash
# Adicionar repositório oficial da Kubernetes (v1.31)
sudo apt-get install -y apt-transport-https ca-certificates curl gpg
curl -fsSL https://pkgs.k8s.io/core:/stable:/v1.31/deb/Release.key | sudo gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg

echo 'deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/v1.31/deb/ /' | sudo tee /etc/apt/sources.list.d/kubernetes.list

sudo apt-get update
sudo apt-get install -y kubelet kubeadm kubectl
sudo apt-mark hold kubelet kubeadm kubectl
```

---

#### Etapa 4: Inicializar o Control Plane (EXECUTAR APENAS NO `k8s-control-plane`)

```bash
# Obtenha o IP privado local da VM (ex: 10.0.0.10)
INTERNAL_IP=$(hostname -I | awk '{print $1}')

# Inicializar o cluster com rede de pods do Flannel
sudo kubeadm init \
  --apiserver-advertise-address=$INTERNAL_IP \
  --pod-network-cidr=10.244.0.0/16

# Configurar o kubeconfig para o usuário não-root
mkdir -p $HOME/.kube
sudo cp -i /etc/kubernetes/admin.conf $HOME/.kube/config
sudo chown $(id -u):$(id -g) $HOME/.kube/config

# Instalar o CNI Flannel para comunicação entre pods
kubectl apply -f https://github.com/flannel-io/flannel/releases/latest/download/kube-flannel.yml
```

> 📌 O comando `kubeadm init` exibirá no final uma linha de join parecida com:
> `sudo kubeadm join 10.0.0.10:6443 --token abcdef.1234567890 --discovery-token-ca-cert-hash sha256:...`

---

#### Etapa 5: Conectar os Workers (EXECUTAR NO `k8s-worker-01`, `02` e `03`)

Cole o comando `kubeadm join` gerado pelo master em cada um dos nós workers:

```bash
sudo kubeadm join <IP_PRIVADO_DO_MASTER>:6443 \
  --token <SEU_TOKEN> \
  --discovery-token-ca-cert-hash sha256:<SEU_HASH>
```

---

#### Etapa 6: Validar o Cluster no Master

No nó `k8s-control-plane`, execute:

```bash
kubectl get nodes -o wide
```

Você verá os 4 nós com status **`Ready`** e arquitetura **`arm64`**:
```text
NAME                STATUS   ROLES           AGE   VERSION   INTERNAL-IP   OS-IMAGE             ARCH
k8s-control-plane   Ready    control-plane   5m    v1.31.x   10.0.0.10     Ubuntu 24.04.1 LTS   arm64
k8s-worker-01       Ready    <none>          3m    v1.31.x   10.0.0.11     Ubuntu 24.04.1 LTS   arm64
k8s-worker-02       Ready    <none>          2m    v1.31.x   10.0.0.12     Ubuntu 24.04.1 LTS   arm64
k8s-worker-03       Ready    <none>          1m    v1.31.x   10.0.0.13     Ubuntu 24.04.1 LTS   arm64
```

Agora você tem **16 OCPUs reais e 32 GB de RAM** disponíveis para implantar os manifestos do seu monorepo (como especificado em `STACK2.md` e nos manifestos Kubernetes do projeto).

---

### 8.5 Alternativa Express: K3s (Pronto em 3 Minutos)

Se você não quiser configurar `containerd`, `sysctl`, `iptables` e `kubeadm` manualmente nó a nó, você pode subir o mesmo cluster de 16 OCPUs e 32 GB RAM usando o **K3s** (100% compatível com a API padrão do Kubernetes):

1. **No Master (`k8s-control-plane`):**
   ```bash
   curl -sfL https://get.k3s.io | sh -
   # Obtenha o token de conexão:
   sudo cat /var/lib/rancher/k3s/server/node-token
   ```
2. **Em cada Worker (`k8s-worker-01..03`):**
   ```bash
   curl -sfL https://get.k3s.io | K3S_URL=https://<IP_PRIVADO_MASTER>:6443 K3S_TOKEN=<TOKEN> sh -
   ```
O cluster estará operacional em menos de 180 segundos.



