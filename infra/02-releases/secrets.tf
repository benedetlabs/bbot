# ============================================================================
# ESCOPO: SEGREDOS CRIPTOGRÁFICOS & REGISTRY SECRET (GHCR)
# ============================================================================
resource "random_password" "postgres_password" {
  length  = 32
  special = false
}

resource "random_id" "master_encryption_key" {
  byte_length = 32 # 64 caracteres hexadecimais (AES-256-GCM)
}


resource "kubernetes_secret" "ghcr_secret" {
  metadata {
    name      = "ghcr-secret"
    namespace = kubernetes_namespace.slack_suite.metadata[0].name
  }

  type = "kubernetes.io/dockerconfigjson"

  data = {
    ".dockerconfigjson" = jsonencode({
      auths = {
        "ghcr.io" = {
          username = var.github_username
          password = var.github_token
          auth     = base64encode("${var.github_username}:${var.github_token}")
        }
      }
    })
  }
}
