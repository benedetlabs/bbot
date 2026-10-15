# ============================================================================
# ESCOPO: HELM RELEASE (hashicorp/helm -> slack-suite)
# ============================================================================
resource "helm_release" "slack_suite" {
  name             = "slack-suite"
  chart            = local.chart_path
  namespace        = kubernetes_namespace.slack_suite.metadata[0].name
  create_namespace = false
  atomic           = false
  cleanup_on_fail  = false
  wait             = true
  timeout          = 300

  values = [
    yamlencode({
      global = {
        imageRegistry = "ghcr.io/${var.github_username}"
        chartHash     = sha256(join("", [for f in fileset(local.chart_path, "**") : filesha256("${local.chart_path}/${f}")]))
      }
      apps = {
        projects = {
          for k, v in var.projects : k => {
            enabled  = v.enabled
            imageTag = local.image_tags[k]
            replicas = v.replicas
          }
        }
      }
      worker = {
        enabled  = var.worker.enabled
        imageTag = local.image_tags["outbox-worker"]
        replicas = var.worker.replicas
      }
      secrets = {
        postgresPassword       = random_password.postgres_password.result
        masterEncryptionKeyHex = random_id.master_encryption_key.hex
        secretAppSigningSecret = try(var.projects["secret-app"].signing_secret, "")
        secretAppClientId      = try(var.projects["secret-app"].client_id, "")
        secretAppClientSecret  = try(var.projects["secret-app"].client_secret, "")
        secretPublicBaseUrl    = try(data.terraform_remote_state.foundation.outputs.public_endpoints["secret"], "https://secret.bsuit.app")
        queueAppSigningSecret  = try(var.projects["queue-app"].signing_secret, "")
        todoAppSigningSecret   = try(var.projects["todo-app"].signing_secret, "")
        secretAppBotToken      = try(var.projects["secret-app"].bot_token, "")
        queueAppBotToken       = try(var.projects["queue-app"].bot_token, "")
        todoAppBotToken        = try(var.projects["todo-app"].bot_token, "")
        cloudflareTunnelToken  = data.terraform_remote_state.foundation.outputs.cloudflare_tunnel_token
      }
    })
  ]

  depends_on = [
    kubernetes_namespace.slack_suite,
    kubernetes_secret.ghcr_secret,
    terraform_data.docker_build_push
  ]
}
