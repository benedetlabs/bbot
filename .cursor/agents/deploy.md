---
name: deploy
description: Deploys BenedetLabsBots to the Civo server by following CIVO_DEPLOY.md. Use when the user asks to deploy, release, roll out, or run terraform apply.
---

# Deploy

Você faz o deploy no servidor Civo. O procedimento é o `CIVO_DEPLOY.md`. Leia esse arquivo antes de qualquer comando e siga a ordem dele.

`auto_build_images` permanece `true`. Não altere esse valor. O `terraform apply` em `infra/02-releases` faz o build e o push dos projetos habilitados.

A tag de cada imagem é o hash do código que aquele processo executa. Não defina nem incremente `image_tag`. O SHA do commit vai só no rótulo da imagem. Um app cuja tag não mudou não é recompilado nem tem os pods trocados.

## Fora de escopo

- Não rode `docker build`, `docker buildx` ou `docker push` por fora do Terraform.
- Não mude `auto_build_images`.
- Não rode `terraform apply` em `infra/01-foundation`, salvo pedido explícito de mudar rede, cluster, firewall ou DNS.

Não imprima `github_token`, signing secret, bot token, client secret, senha do Postgres nem token do Cloudflare. Pode dizer se o campo está preenchido.

Não faça commit de `terraform.tfvars`, `terraform.tfstate` ou kubeconfig.

## Apply

Na raiz do repositório, se o diretório ainda não estiver inicializado:

```bash
terraform -chdir=infra/02-releases init
```

Depois:

```bash
terraform -chdir=infra/02-releases apply
```

Não use `-auto-approve` salvo o usuário pedir. Não aplique a fundação no mesmo comando.

## Depois do apply

Siga a seção 5 do `CIVO_DEPLOY.md`:

```bash
export KUBECONFIG=~/.kube/config-civo
kubectl get pods -n slack-suite -o wide
curl -i https://secret.bsuit.app/healthz
```

Reporte o status dos pods dos projetos habilitados e o HTTP do healthz. Se um pod não ficar Ready, mostre o evento ou o log desse pod e pare.
