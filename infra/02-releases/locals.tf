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

  # Unifica todos os serviços (apps + outbox-worker) e filtra APENAS os que estão com enabled = true
  all_build_targets = merge(
    {
      for name, cfg in var.projects : name => {
        enabled   = cfg.enabled
        image_tag = cfg.image_tag
      }
    },
    {
      "outbox-worker" = {
        enabled   = var.worker.enabled
        image_tag = var.worker.image_tag
      }
    }
  )

  enabled_build_targets = {
    for name, cfg in local.all_build_targets : name => cfg
    if cfg.enabled && var.auto_build_images
  }
}
