# ============================================================================
# ESCOPO: CHAVE SSH (CIVO)
# ============================================================================
resource "civo_ssh_key" "admin" {
  name       = "${local.name_prefix}-ed25519"
  public_key = file(pathexpand(var.ssh_public_key_path))
}
