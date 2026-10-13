provider "kubernetes" {
  host                   = local.k8s_host
  cluster_ca_certificate = local.k8s_ca
  client_certificate     = local.k8s_cert
  client_key             = local.k8s_key
  token                  = local.k8s_token
}

provider "helm" {
  kubernetes {
    host                   = local.k8s_host
    cluster_ca_certificate = local.k8s_ca
    client_certificate     = local.k8s_cert
    client_key             = local.k8s_key
    token                  = local.k8s_token
  }
}
