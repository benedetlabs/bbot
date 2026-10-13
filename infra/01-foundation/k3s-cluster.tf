# ============================================================================
# ESCOPO: CLUSTER K3S MULTI-POOL & ROTULAGEM DE NÓS (CIVO)
# ============================================================================
resource "civo_kubernetes_cluster" "k3s" {
  name        = local.cluster_name
  network_id  = data.civo_network.default.id
  firewall_id = civo_firewall.k3s.id

  # Gera dinamicamente os 4 Node Pools dedicados a partir de var.node_pools
  dynamic "pools" {
    for_each = var.node_pools
    content {
      label      = pools.key
      size       = pools.value.size
      node_count = pools.value.node_count
    }
  }
}

# Exporta o kubeconfig para a máquina local (Mac)
resource "local_sensitive_file" "kubeconfig" {
  content         = civo_kubernetes_cluster.k3s.kubeconfig
  filename        = pathexpand(var.kubeconfig_output_path)
  file_permission = "0600"
}

# Aplica automaticamente a label `workload-tier` em cada nó de acordo com o seu pool
resource "null_resource" "label_node_pools" {
  depends_on = [local_sensitive_file.kubeconfig]

  triggers = {
    cluster_id = civo_kubernetes_cluster.k3s.id
    pools_hash = sha256(jsonencode(var.node_pools))
  }

  provisioner "local-exec" {
    command = <<-EOT
      export KUBECONFIG="${pathexpand(var.kubeconfig_output_path)}"
      for node in $(kubectl get nodes -o jsonpath='{.items[*].metadata.name}'); do
        case "$node" in
          *db-pool*)    kubectl label node "$node" workload-tier=database --overwrite ;;
          *cache-pool*) kubectl label node "$node" workload-tier=cache --overwrite ;;
          *app-pool*)   kubectl label node "$node" workload-tier=apps --overwrite ;;
          *obs-pool*)   kubectl label node "$node" workload-tier=observability --overwrite ;;
        esac
      done
    EOT
  }
}
