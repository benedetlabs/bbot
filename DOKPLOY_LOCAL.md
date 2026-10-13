# Dokploy Local: Guia de Testes no macOS (Docker Desktop)

O **Dokploy** está instalado e rodando localmente no seu Mac sobre o Docker Desktop e Docker Swarm.

---

## 1. Como Acessar o Painel Web

Abra o seu navegador e acesse:

👉 **[http://localhost:3000](http://localhost:3000)**

### Primeiro Acesso (Setup Inicial):
1. Ao abrir pela primeira vez, o Dokploy exibirá a tela de **Onboarding**.
2. Preencha seu **Nome**, **E-mail** e defina uma **Senha de Administrador**.
3. Clique em **Create Account**. Você entrará diretamente no painel de controle do Dokploy.

---

## 2. Componentes que Subiram no seu Mac

| Container / Serviço | Papel na Stack | Porta Mapeada | Status |
| :--- | :--- | :--- | :--- |
| **`dokploy`** | Painel Web & API de Orquestração (Next.js) | `3000` | `Up (healthy)` |
| **`dokploy-postgres`** | Banco de dados interno do Dokploy (PostgreSQL 16) | Interna (`dokploy-network`) | `Up (healthy)` |
| **`dokploy-traefik`** | Proxy reverso e roteador de tráfego (Traefik v3) | `80`, `443` | `Up` |

*Os dados de configuração e certificados locais ficam salvos em:* `~/.dokploy`

---

## 3. O Que Você Pode Testar Agora no Dokploy Local

1. **Criar um Projeto:**
   * Clique em **Create Project** e dê um nome (ex.: `Slack Bots Local`).
2. **Conectar com GitHub:**
   * Vá em **Settings > Git Providers > GitHub** para integrar com seus repositórios e testar deploys automáticos via Git.
3. **Subir Aplicações:**
   * Crie uma aplicação a partir de um Dockerfile, Docker Compose ou imagem Docker direta.
4. **Subir Bancos de Dados em 1 Clique:**
   * No menu do projeto, clique em **Add Service > Database** e teste subir um PostgreSQL, Redis ou MySQL gerenciado pelo Dokploy.

---

## 4. Comandos de Gerenciamento do Dokploy Local

Execute no terminal do seu Mac quando desejar pausar ou retomar os testes:

### Para Pausar (Economizar Bateria / CPU do Mac):
```bash
# Reduz as réplicas dos serviços para 0 e pausa o Traefik
docker service scale dokploy=0 dokploy-postgres=0
docker stop dokploy-traefik
```

### Para Retomar os Serviços:
```bash
# Sobe as réplicas de volta para 1 e inicia o Traefik
docker service scale dokploy=1 dokploy-postgres=1
docker start dokploy-traefik
```

### Para Ver Logs em Tempo Real:
```bash
docker service logs dokploy -f
```

### Para Desinstalar Completamente do Mac:
```bash
# Remove serviços, proxy, rede, segredos e pasta local
docker service rm dokploy dokploy-postgres
docker rm -f dokploy-traefik
docker network rm dokploy-network
docker secret rm dokploy_postgres_password dokploy_auth_secret
rm -rf ~/.dokploy
```
