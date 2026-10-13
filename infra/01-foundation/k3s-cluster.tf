# ============================================================================
# ESCOPO: CLUSTER K3S & NODE POOLS DEDICADOS (CIVO)
# ============================================================================
resource "civo_kubernetes_cluster" "k3s" {
  name        = local.cluster_name
  network_id  = civo_network.k3s.id
  firewall_id = civo_firewall.k3s.id

  # Pool primário do cluster: app-pool (Apps Deno + Worker + Cloudflared)
  pools {
    label      = "app-pool"
    size       = var.node_pools["app-pool"].size
    node_count = var.node_pools["app-pool"].node_count
    labels = {
      "workload-tier" = var.node_pools["app-pool"].workload_tier
    }
  }
}

# Node Pools adicionais isolados (db-pool, cache-pool, obs-pool) com labels nativas K8s
resource "civo_kubernetes_node_pool" "dedicated" {
  for_each = {
    for k, v in var.node_pools : k => v if k != "app-pool"
  }

  cluster_id = civo_kubernetes_cluster.k3s.id
  label      = each.key
  size       = each.value.size
  node_count = each.value.node_count
  labels = {
    "workload-tier" = each.value.workload_tier
  }
}

# Consulta o cluster após todos os pools estarem ativos para garantir que o kubeconfig venha preenchido
data "civo_kubernetes_cluster" "ready" {
  name       = civo_kubernetes_cluster.k3s.name
  depends_on = [civo_kubernetes_node_pool.dedicated]
}

# Exporta o kubeconfig para a máquina local (Mac)
resource "local_sensitive_file" "kubeconfig" {
  content         = data.civo_kubernetes_cluster.ready.kubeconfig
  filename        = pathexpand(var.kubeconfig_output_path)
  file_permission = "0600"
}
