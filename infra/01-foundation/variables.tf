# ============================================================================
# ESCOPO: PROVEDOR CIVO & AMBIENTE
# ============================================================================
variable "environment" {
  description = "Nome do ambiente (ex: prod, staging)"
  type        = string
  default     = "prod"

  validation {
    condition     = contains(["prod", "staging", "dev"], var.environment)
    error_message = "O environment deve ser 'prod', 'staging' ou 'dev'."
  }
}

variable "project_name" {
  description = "Prefixo padrão para nomenclatura de recursos"
  type        = string
  default     = "benedetlabs"
}

variable "civo_token" {
  description = "API Key da Civo (Dashboard -> Settings -> Profile -> Security)"
  type        = string
  sensitive   = true
}

variable "civo_region" {
  description = "Região do datacenter na Civo (NYC1, PHX1, LON1, FRA1)"
  type        = string
  default     = "NYC1"

  validation {
    condition     = contains(["NYC1", "PHX1", "LON1", "FRA1"], var.civo_region)
    error_message = "Região da Civo inválida. Use NYC1, PHX1, LON1 ou FRA1."
  }
}

variable "ssh_public_key_path" {
  description = "Caminho local da chave SSH pública Ed25519 no Mac"
  type        = string
  default     = "~/.ssh/id_ed25519_civo.pub"
}

variable "kubeconfig_output_path" {
  description = "Caminho local onde o kubeconfig do cluster será salvo"
  type        = string
  default     = "~/.kube/config-civo"
}

# ============================================================================
# ESCOPO: NODE POOLS DO K3S
# ============================================================================
variable "node_pools" {
  description = "Mapa declarativo dos 4 Node Pools dedicados do cluster K3s"
  type = map(object({
    size          = string
    node_count    = number
    workload_tier = string
  }))
  default = {
    "db-pool" = {
      size          = "g4s.kube.medium" # 4 vCPU, 8 GB RAM
      node_count    = 1
      workload_tier = "database"
    }
    "cache-pool" = {
      size          = "g4s.kube.small" # 2 vCPU, 4 GB RAM
      node_count    = 1
      workload_tier = "cache"
    }
    "app-pool" = {
      size          = "g4s.kube.medium" # 4 vCPU, 8 GB RAM
      node_count    = 1
      workload_tier = "apps"
    }
    "obs-pool" = {
      size          = "g4s.kube.medium" # 2 vCPU, 4 GB RAM por nó (total 2 nós = 4 vCPU, 8 GB RAM)
      node_count    = 2
      workload_tier = "observability"
    }
  }
}

# ============================================================================
# ESCOPO: CLOUDFLARE ZERO TRUST & DNS
# ============================================================================
variable "cloudflare_api_token" {
  description = "API Token da Cloudflare (Cloudflare Tunnel:Edit + DNS:Edit)"
  type        = string
  sensitive   = true
}

variable "cloudflare_account_id" {
  description = "Account ID da conta Cloudflare"
  type        = string
}

variable "cloudflare_zone_id" {
  description = "Zone ID do domínio na Cloudflare"
  type        = string
}

variable "domain_name" {
  description = "Domínio base registrado na Cloudflare (ex: benedetlabs.com)"
  type        = string
}
