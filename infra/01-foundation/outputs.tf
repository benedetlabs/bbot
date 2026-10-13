# ============================================================================
# ESCOPO: OUTPUTS DA FUNDAÇÃO (CONSUMIDOS PELA CAMADA 02-RELEASES)
# ============================================================================
output "cluster_id" {
  description = "ID do cluster K3s na Civo"
  value       = civo_kubernetes_cluster.k3s.id
}

output "cluster_name" {
  description = "Nome do cluster K3s provisionado"
  value       = civo_kubernetes_cluster.k3s.name
}

output "kubeconfig_raw" {
  description = "Conteúdo bruto do kubeconfig (usado pela camada 02-releases via remote_state)"
  value       = civo_kubernetes_cluster.k3s.kubeconfig
  sensitive   = true
}

output "kubeconfig_path" {
  description = "Caminho local onde o kubeconfig foi salvo no Mac"
  value       = local_sensitive_file.kubeconfig.filename
}

output "cloudflare_tunnel_token" {
  description = "Token do Cloudflare Tunnel (usado pela camada 02-releases)"
  value       = cloudflare_zero_trust_tunnel_cloudflared.k8s.tunnel_token
  sensitive   = true
}

output "public_endpoints" {
  description = "Endpoints públicos HTTPS provisionados no DNS da Cloudflare"
  value = {
    for k, v in local.tunnel_routes : k => "https://${v.hostname}"
  }
}
