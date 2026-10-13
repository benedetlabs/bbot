# ============================================================================
# ESCOPO: OUTPUTS DE RELEASE & CREDENCIAIS GERADAS
# ============================================================================
output "helm_release_info" {
  description = "Metadados do release Helm e status individual de cada projeto"
  value = {
    name      = helm_release.slack_suite.name
    namespace = helm_release.slack_suite.namespace
    status    = helm_release.slack_suite.status
    version   = helm_release.slack_suite.version
    deployed_projects = {
      for k, v in var.projects : k => {
        enabled   = v.enabled
        image_tag = v.image_tag
        replicas  = v.replicas
      }
    }
    worker = var.worker
  }
}

output "public_endpoints" {
  description = "Endpoints públicos HTTPS herdados da fundação"
  value       = data.terraform_remote_state.foundation.outputs.public_endpoints
}

output "openobserve_admin_email" {
  description = "E-mail de login do OpenObserve"
  value       = var.openobserve_admin_email
}

output "openobserve_admin_password" {
  description = "Senha gerada para o OpenObserve (use: terraform -chdir=infra/02-releases output -raw openobserve_admin_password)"
  value       = random_password.openobserve_password.result
  sensitive   = true
}

output "postgres_password" {
  description = "Senha gerada para o PostgreSQL 18 (use: terraform -chdir=infra/02-releases output -raw postgres_password)"
  value       = random_password.postgres_password.result
  sensitive   = true
}
