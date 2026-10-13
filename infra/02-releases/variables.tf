# ============================================================================
# ESCOPO: VARIÁVEIS DE RELEASE POR PROJETO (02-RELEASES)
# ============================================================================
variable "github_username" {
  description = "Usuário ou organização do GitHub para o Container Registry (ghcr.io)"
  type        = string
  default     = "benedetlabs"
}

variable "github_token" {
  description = "Personal Access Token do GitHub (write:packages e read:packages) para build/push e pull no K8s"
  type        = string
  sensitive   = true
}

variable "auto_build_images" {
  description = "Se true, o próprio Terraform faz o docker buildx (linux/amd64) e push no GHCR apenas dos projetos habilitados!"
  type        = bool
  default     = true
}

variable "openobserve_admin_email" {
  description = "E-mail de administrador do painel OpenObserve"
  type        = string
  default     = "benedetlabs@gmail.com"
}

# ============================================================================
# CONFIGURAÇÃO INDIVIDUAL POR PROJETO (secret-app, queue-app, todo-app)
# Permite fazer deploy de apenas 1 projeto (enabled = true/false) e versionar tags separadas!
# ============================================================================
variable "projects" {
  description = "Mapa de configuração independente por app do monorepo"
  type = map(object({
    enabled        = bool
    image_tag      = string
    replicas       = optional(number, 2)
    signing_secret = optional(string, "")
    bot_token      = optional(string, "")
  }))

  default = {
    "secret-app" = {
      enabled        = true
      image_tag      = "v1.0.0"
      replicas       = 2
      signing_secret = ""
      bot_token      = ""
    }
    "queue-app" = {
      enabled        = false
      image_tag      = "v1.0.0"
      replicas       = 2
      signing_secret = ""
      bot_token      = ""
    }
    "todo-app" = {
      enabled        = false
      image_tag      = "v1.0.0"
      replicas       = 2
      signing_secret = ""
      bot_token      = ""
    }
  }
}

variable "worker" {
  description = "Configuração independente do Transactional Outbox Worker"
  type = object({
    enabled   = bool
    image_tag = string
    replicas  = optional(number, 2)
  })

  default = {
    enabled   = true
    image_tag = "v1.0.0"
    replicas  = 2
  }
}
