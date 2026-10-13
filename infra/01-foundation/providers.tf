provider "civo" {
  token  = var.civo_token
  region = var.civo_region
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}
