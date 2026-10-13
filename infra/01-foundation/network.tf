# ============================================================================
# ESCOPO: REDE DEDICADA & FIREWALL ZERO-TRUST (CIVO)
# ============================================================================
resource "civo_network" "k3s" {
  label = "${local.cluster_name}-net"
}

resource "civo_firewall" "k3s" {
  name                 = "${local.cluster_name}-fw"
  network_id           = civo_network.k3s.id
  create_default_rules = false

  # Permite apenas acesso à API do Kubernetes (6443) para gerenciamento via Terraform/kubectl.
  # Zero portas HTTP/HTTPS/5432/5080 abertas (todo tráfego de entrada entra via Cloudflare Tunnel).
  ingress_rule {
    label      = "kubernetes-api"
    protocol   = "tcp"
    port_range = "6443"
    cidr       = ["0.0.0.0/0"]
    action     = "allow"
  }

  egress_rule {
    label      = "all-outbound-tcp"
    protocol   = "tcp"
    port_range = "1-65535"
    cidr       = ["0.0.0.0/0"]
    action     = "allow"
  }

  egress_rule {
    label      = "all-outbound-udp"
    protocol   = "udp"
    port_range = "1-65535"
    cidr       = ["0.0.0.0/0"]
    action     = "allow"
  }
}
