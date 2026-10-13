# ============================================================================
# ESCOPO: NAMESPACE KUBERNETES
# ============================================================================
resource "kubernetes_namespace" "slack_suite" {
  metadata {
    name = local.namespace
    labels = {
      "app.kubernetes.io/name"       = "slack-suite"
      "app.kubernetes.io/managed-by" = "terraform-02-releases"
    }
  }
}
