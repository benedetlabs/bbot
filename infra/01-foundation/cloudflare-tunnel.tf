# ============================================================================
# ESCOPO: CLOUDFLARE ZERO TRUST TUNNEL & REGRAS DE ROTEAMENTO
# ============================================================================
resource "random_id" "tunnel_secret" {
  byte_length = 32
}

resource "cloudflare_zero_trust_tunnel_cloudflared" "k8s" {
  account_id = var.cloudflare_account_id
  name       = "${local.cluster_name}-tunnel"
  secret     = random_id.tunnel_secret.b64_std
}

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "k8s" {
  account_id = var.cloudflare_account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.k8s.id

  config {
    # Gera dinamicamente as rotas de ingress a partir de local.tunnel_routes
    dynamic "ingress_rule" {
      for_each = local.tunnel_routes
      content {
        hostname = ingress_rule.value.hostname
        service  = ingress_rule.value.service
      }
    }

    # Regra obrigatória de fallback (Catch-all)
    ingress_rule {
      service = "http_status:404"
    }
  }
}
