# ============================================================================
# ESCOPO: LEITURA DO STATE DA FUNDAÇÃO (01-FOUNDATION)
# Conecta automaticamente ao cluster K3s e recupera o token do Cloudflare Tunnel
# sem misturar os states de infraestrutura de nuvem com os releases de aplicação!
# ============================================================================
data "terraform_remote_state" "foundation" {
  backend = "local"

  config = {
    path = "${path.module}/../01-foundation/terraform.tfstate"
  }
}
