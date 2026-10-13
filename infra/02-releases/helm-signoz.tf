# ============================================================================
# ESCOPO: HELM RELEASE SIGNOZ APM & OBSERVABILITY (signoz/signoz)
# ============================================================================
resource "helm_release" "signoz" {
  name             = "signoz"
  repository       = "https://charts.signoz.io"
  chart            = "signoz"
  version          = "0.145.0"
  namespace        = kubernetes_namespace.slack_suite.metadata[0].name
  create_namespace = false
  atomic           = false
  cleanup_on_fail  = false
  wait             = false
  timeout          = 600

  values = [
    yamlencode({
      global = {
        storageClass = "civo-volume-retain"
        clusterName  = "benedetlabs-prod-k3s"
      }
      clickhouse = {
        nodeSelector = {
          "kubernetes.civo.com/civo-node-pool" = "obs-pool"
        }
        resources = {
          requests = {
            cpu    = "200m"
            memory = "1Gi"
          }
          limits = {
            cpu    = "1500m"
            memory = "2500Mi"
          }
        }
        persistence = {
          enabled      = true
          size         = "20Gi"
          storageClass = "civo-volume-retain"
        }
      }
      signoz = {
        nodeSelector = {
          "kubernetes.civo.com/civo-node-pool" = "obs-pool"
        }
        resources = {
          requests = {
            cpu    = "100m"
            memory = "256Mi"
          }
          limits = {
            cpu    = "500m"
            memory = "512Mi"
          }
        }
        persistence = {
          enabled      = true
          size         = "1Gi"
          storageClass = "civo-volume-retain"
        }
      }
      otelCollector = {
        nodeSelector = {
          "kubernetes.civo.com/civo-node-pool" = "obs-pool"
        }
        resources = {
          requests = {
            cpu    = "100m"
            memory = "200Mi"
          }
          limits = {
            cpu    = "500m"
            memory = "512Mi"
          }
        }
      }
    })
  ]

  depends_on = [
    kubernetes_namespace.slack_suite,
    helm_release.slack_suite
  ]
}
