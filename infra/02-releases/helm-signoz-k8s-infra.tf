# ============================================================================
# ESCOPO: HELM RELEASE SIGNOZ K8S-INFRA (signoz/k8s-infra)
# Telemetria profunda de Kubernetes: Kubeletstats (cAdvisor), K8s Cluster,
# K8s Events, Hostmetrics e enriquecimento de atributos de Pods/Containers.
# ============================================================================
resource "helm_release" "signoz_k8s_infra" {
  name             = "k8s-infra"
  repository       = "https://charts.signoz.io"
  chart            = "k8s-infra"
  version          = "0.17.1"
  namespace        = kubernetes_namespace.slack_suite.metadata[0].name
  create_namespace = false
  atomic           = false
  cleanup_on_fail  = false
  wait             = false
  timeout          = 300

  values = [
    yamlencode({
      global = {
        clusterName   = "benedetlabs-prod-k3s"
        clusterDomain = "cluster.local"
      }
      otelCollectorEndpoint = "signoz-otel-collector.slack-suite.svc.cluster.local:4317"
      otelInsecure          = true

      presets = {
        otlpExporter = {
          enabled = true
        }
        otlphttpExporter = {
          enabled = false
        }
        logsCollection = {
          enabled = true
        }
        hostMetrics = {
          enabled = true
        }
        kubeletMetrics = {
          enabled = true
        }
        clusterMetrics = {
          enabled = true
        }
        k8sEvents = {
          enabled = true
        }
        kubernetesAttributes = {
          enabled = true
        }
      }

      otelDeployment = {
        nodeSelector = {
          "kubernetes.civo.com/civo-node-pool" = "obs-pool"
        }
        resources = {
          requests = {
            cpu    = "50m"
            memory = "64Mi"
          }
          limits = {
            cpu    = "200m"
            memory = "256Mi"
          }
        }
      }

      otelAgent = {
        resources = {
          requests = {
            cpu    = "50m"
            memory = "64Mi"
          }
          limits = {
            cpu    = "200m"
            memory = "256Mi"
          }
        }
      }
    })
  ]

  depends_on = [
    helm_release.signoz
  ]
}
