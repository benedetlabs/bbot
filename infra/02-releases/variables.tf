# ============================================================================
# ESCOPO: VARIÁVEIS DE RELEASE & APLICAÇÃO (02-RELEASES)
# ============================================================================
variable "github_username" {
  description = "Usuário ou organização do GitHub para o Container Registry (ghcr.io)"
  type        = string
  default     = "benedetlabs"
}

variable "github_token" {
  description = "Personal Access Token do GitHub (read:packages) para puxar imagens privadas"
  type        = string
  sensitive   = true
}

variable "image_tag" {
  description = "Tag da versão das imagens Docker (ex: v1.0.0, v1.0.1)"
  type        = string
  default     = "v1.0.0"

  validation {
    condition     = length(trimspace(var.image_tag)) > 0
    error_message = "A image_tag não pode ser vazia."
  }
}

variable "app_replicas" {
  description = "Quantidade de réplicas para cada bot (secret-app, queue-app, todo-app)"
  type        = number
  default     = 2
}

variable "worker_replicas" {
  description = "Quantidade de réplicas para o outbox-worker"
  type        = number
  default     = 2
}

variable "openobserve_admin_email" {
  description = "E-mail de administrador do painel OpenObserve"
  type        = string
  default     = "benedetlabs@gmail.com"
}

variable "secret_app_signing_secret" {
  description = "Slack Signing Secret do Secret App"
  type        = string
  sensitive   = true
}

variable "queue_app_signing_secret" {
  description = "Slack Signing Secret do Queue App"
  type        = string
  sensitive   = true
}

variable "todo_app_signing_secret" {
  description = "Slack Signing Secret do Todo App"
  type        = string
  sensitive   = true
}
