# ============================================================================
# ESCOPO: LOGIN NO GHCR & BUILD/PUSH AUTOMÁTICO POR PROJETO (linux/amd64)
# 1. `ghcr_login` roda uma única vez (evita colisão concorrente -25299 no macOS Keychain)
# 2. `docker_build_push` compila e envia apenas os projetos com `enabled = true`
# ============================================================================
resource "terraform_data" "ghcr_login" {
  count = length(local.enabled_build_targets) > 0 ? 1 : 0

  triggers_replace = [
    var.github_username,
    sha256(var.github_token)
  ]

  provisioner "local-exec" {
    environment = {
      GHCR_TOKEN = var.github_token
    }
    command = <<-EOT
      echo "$GHCR_TOKEN" | docker login ghcr.io -u "${var.github_username}" --password-stdin
    EOT
  }
}

resource "terraform_data" "docker_build_push" {
  for_each   = local.enabled_build_targets
  depends_on = [terraform_data.ghcr_login]

  triggers_replace = [
    each.key,
    each.value.image_tag,
  ]

  provisioner "local-exec" {
    working_dir = local.repo_root
    command     = <<-EOT
      set -euo pipefail
      rev=$(git rev-parse HEAD)
      echo "🚀 [Terraform Build] Compilando ${each.key}:${each.value.image_tag} (linux/amd64)..."
      docker buildx build \
        --platform linux/amd64 \
        --build-arg APP_NAME="${each.key}" \
        --label org.opencontainers.image.revision="$rev" \
        -t "ghcr.io/${var.github_username}/${each.key}:${each.value.image_tag}" \
        --push .
    EOT
  }
}
