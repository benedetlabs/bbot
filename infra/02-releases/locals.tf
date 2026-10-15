locals {
  namespace  = "slack-suite"
  chart_path = "${path.module}/../charts/slack-suite"
  repo_root  = abspath("${path.module}/../..")

  # Decodifica o kubeconfig vindo do state da camada 01-foundation
  kubeconfig = yamldecode(data.terraform_remote_state.foundation.outputs.kubeconfig_raw)
  k8s_host   = local.kubeconfig.clusters[0].cluster.server
  k8s_ca     = base64decode(local.kubeconfig.clusters[0].cluster["certificate-authority-data"])
  k8s_cert   = try(base64decode(local.kubeconfig.users[0].user["client-certificate-data"]), null)
  k8s_key    = try(base64decode(local.kubeconfig.users[0].user["client-key-data"]), null)
  k8s_token  = try(local.kubeconfig.users[0].user.token, null)

  # Pastas que cada imagem executa. Pacotes compartilhados entram em todas
  # porque @suite/db reexporta queue/todo, e esses módulos importam @suite/outbox.
  # O worker importa apps/queue-app/main.ts, então mudança no Queue também o republica.
  # billing não entra: nenhum app importa esse pacote.
  shared_runtime_dirs = [
    "packages/crypto",
    "packages/db",
    "packages/outbox",
    "packages/slack-kit",
    "packages/gatekeep-core",
    "packages/gatekeep-sdk",
    "packages/gatekeep-mcp",
  ]
  image_source_dirs = {
    "secret-app"    = ["apps/secret-app"]
    "queue-app"     = ["apps/queue-app"]
    "todo-app"      = ["apps/todo-app"]
    "gatekeep-app"  = ["apps/gatekeep-app"]
    "outbox-worker" = ["apps/outbox-worker", "apps/queue-app"]
  }
  shared_build_files = [
    for f in ["Dockerfile", "deno.json", "deno.lock", ".npmrc"] : f
    if fileexists("${local.repo_root}/${f}")
  ]

  image_input_files = {
    for name, dirs in local.image_source_dirs : name => sort(concat(
      local.shared_build_files,
      flatten([
        for dir in concat(dirs, local.shared_runtime_dirs) : [
          for f in fileset(local.repo_root, "${dir}/**") : f
          if !endswith(f, "_test.ts")
        ]
      ]),
    ))
  }

  # Tag da imagem. Muda só quando o código que aquele processo executa muda.
  image_tags = {
    for name, files in local.image_input_files : name => substr(sha256(join("", [
      for f in files : "${f}:${filesha256("${local.repo_root}/${f}")}"
    ])), 0, 12)
  }

  all_build_targets = merge(
    {
      for name, cfg in var.projects : name => {
        enabled   = cfg.enabled
        image_tag = local.image_tags[name]
      }
    },
    {
      "outbox-worker" = {
        enabled   = var.worker.enabled
        image_tag = local.image_tags["outbox-worker"]
      }
    }
  )

  enabled_build_targets = {
    for name, cfg in local.all_build_targets : name => cfg
    if cfg.enabled && var.auto_build_images
  }
}
