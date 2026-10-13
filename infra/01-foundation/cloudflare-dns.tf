# ============================================================================
# ESCOPO: REGISTROS DNS CNAME (CLOUDFLARE)
# ============================================================================
resource "cloudflare_record" "tunnel_cnames" {
  for_each = local.tunnel_routes

  zone_id = var.cloudflare_zone_id
  name    = each.key
  content = "${cloudflare_zero_trust_tunnel_cloudflared.k8s.id}.cfargotunnel.com"
  type    = "CNAME"
  proxied = true
  ttl     = 1 # Automático quando proxied = true
  comment = "Gerenciado via Terraform (01-foundation) - Rota K3s para ${each.key}"
}
