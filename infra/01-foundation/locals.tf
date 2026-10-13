locals {
  name_prefix  = "${var.project_name}-${var.environment}"
  cluster_name = "${local.name_prefix}-k3s"
  namespace    = "slack-suite"

  # Mapa declarativo de rotas públicas expostas pelo Cloudflare Tunnel -> Kubernetes Services
  tunnel_routes = {
    secret = {
      hostname = "secret.${var.domain_name}"
      service  = "http://secret-app-svc.${local.namespace}.svc.cluster.local:80"
    }
    queue = {
      hostname = "queue.${var.domain_name}"
      service  = "http://queue-app-svc.${local.namespace}.svc.cluster.local:80"
    }
    todo = {
      hostname = "todo.${var.domain_name}"
      service  = "http://todo-app-svc.${local.namespace}.svc.cluster.local:80"
    }
    signoz = {
      hostname = "signoz.${var.domain_name}"
      service  = "http://signoz.${local.namespace}.svc.cluster.local:8080"
    }
  }
}
