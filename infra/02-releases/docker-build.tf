# ============================================================================
# ESCOPO: BUILD & PUSH AUTOMÁTICO DAS IMAGENS DOCKER POR PROJETO (linux/amd64)
# Compila e envia para o GHCR APENAS os projetos com `enabled = true` e apenas
# quando a respectiva `image_tag` (ou o Dockerfile) mudar!
# ============================================================================
resource "terraform_data" "docker_build_push" {
  for_each = local.enabled_build_targets

  triggers_replace = [
    each.key,
    each.value.image_tag,
    filesha256("${local.repo_root}/Dockerfile")
  ]

  provisioner "local-exec" {
    working_dir = local.repo_root
    environment = {
      GHCR_TOKEN = var.github_token
    }
    command = <<-EOT
      set -e
      echo "$GHCR_TOKEN" | docker login ghcr.io -u "${var.github_username}" --password-stdin
      echo "🚀 [Terraform Build] Compilando ${each.key}:${each.value.image_tag} (linux/amd64)..."
      docker buildx build \
        --platform linux/amd64 \
        --build-arg APP_NAME="${each.key}" \
        -t "ghcr.io/${var.github_username}/${each.key}:${each.value.image_tag}" \
        --push .
    EOT
  }
}
