provider "civo" {
  credentials_file = pathexpand("~/.civo.json")
  region           = var.civo_region
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}
