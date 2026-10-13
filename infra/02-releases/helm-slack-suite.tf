# ============================================================================
# ESCOPO: HELM RELEASE (hashicorp/helm -> slack-suite)
# ============================================================================
resource "helm_release" "slack_suite" {
  name             = "slack-suite"
  chart            = local.chart_path
  namespace        = kubernetes_namespace.slack_suite.metadata[0].name
  create_namespace = false
  atomic           = true
  cleanup_on_fail  = true
  wait             = true
  timeout          = 600

  set {
    name  = "global.imageRegistry"
    value = "ghcr.io/${var.github_username}"
  }

  # Configura individualmente cada projeto (enabled, imageTag e replicas)
  dynamic "set" {
    for_each = var.projects
    content {
      name  = "apps.projects.${set.key}.enabled"
      value = tostring(set.value.enabled)
    }
  }

  dynamic "set" {
    for_each = var.projects
    content {
      name  = "apps.projects.${set.key}.imageTag"
      value = set.value.image_tag
    }
  }

  dynamic "set" {
    for_each = var.projects
    content {
      name  = "apps.projects.${set.key}.replicas"
      value = tostring(set.value.replicas)
    }
  }

  # Configura individualmente o Outbox Worker
  set {
    name  = "worker.enabled"
    value = tostring(var.worker.enabled)
  }

  set {
    name  = "worker.imageTag"
    value = var.worker.image_tag
  }

  set {
    name  = "worker.replicas"
    value = tostring(var.worker.replicas)
  }

  set {
    name  = "secrets.openobserveAdminEmail"
    value = var.openobserve_admin_email
  }

  set_sensitive {
    name  = "secrets.postgresPassword"
    value = random_password.postgres_password.result
  }

  set_sensitive {
    name  = "secrets.masterEncryptionKeyHex"
    value = random_id.master_encryption_key.hex
  }

  set_sensitive {
    name  = "secrets.openobserveAdminPassword"
    value = random_password.openobserve_password.result
  }

  set_sensitive {
    name  = "secrets.secretAppSigningSecret"
    value = try(var.projects["secret-app"].signing_secret, "")
  }

  set_sensitive {
    name  = "secrets.queueAppSigningSecret"
    value = try(var.projects["queue-app"].signing_secret, "")
  }

  set_sensitive {
    name  = "secrets.todoAppSigningSecret"
    value = try(var.projects["todo-app"].signing_secret, "")
  }

  # Token recuperado automaticamente do state da camada 01-foundation
  set_sensitive {
    name  = "secrets.cloudflareTunnelToken"
    value = data.terraform_remote_state.foundation.outputs.cloudflare_tunnel_token
  }

  depends_on = [
    kubernetes_namespace.slack_suite,
    kubernetes_secret.ghcr_secret,
    terraform_data.docker_build_push
  ]
}
