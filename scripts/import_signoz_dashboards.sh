#!/usr/bin/env bash
# ==============================================================================
# SCRIPT: Importar Dashboards Oficiais no SigNoz (v2 Perses API)
# Uso: ./scripts/import_signoz_dashboards.sh [SIGNOZ_URL] [SIGNOZ_TOKEN]
# Exemplo: ./scripts/import_signoz_dashboards.sh https://signoz.bsuit.app <TOKEN>
# ==============================================================================

set -euo pipefail

SIGNOZ_URL="${1:-https://signoz.bsuit.app}"
AUTH_TOKEN="${2:-xolv6frw0gu7n85a7w29ni5qki7heqpl}"
DASHBOARDS_DIR="infra/charts/slack-suite/files/dashboards"

echo "=========================================================="
echo " Importador de Dashboards Oficiais SigNoz - Slack Suite"
echo " Alvo: ${SIGNOZ_URL}"
echo " Diretório: ${DASHBOARDS_DIR}"
echo "=========================================================="

if [ -z "$AUTH_TOKEN" ]; then
  echo "❌ Erro: Token de autenticação é obrigatório para a API v2 do SigNoz."
  exit 1
fi

for DASHBOARD_FILE in "${DASHBOARDS_DIR}"/*.json; do
  [ -f "$DASHBOARD_FILE" ] || continue
  DASH_NAME=$(basename "$DASHBOARD_FILE")
  echo "➡️ Importando ${DASH_NAME}..."

  RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "${SIGNOZ_URL}/api/v2/dashboards" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${AUTH_TOKEN}" \
    --data @"${DASHBOARD_FILE}")

  HTTP_STATUS=$(echo "$RESPONSE" | tail -n1)
  BODY=$(echo "$RESPONSE" | sed '$d')

  if [ "$HTTP_STATUS" -eq 200 ] || [ "$HTTP_STATUS" -eq 201 ]; then
    echo "  ✅ ${DASH_NAME} importado com sucesso! (Status: ${HTTP_STATUS})"
  else
    echo "  ⚠️ Resposta da API para ${DASH_NAME} (Status: ${HTTP_STATUS}):"
    echo "     $BODY"
  fi
done

echo ""
echo "🎉 Todos os dashboards processados!"
echo "Acesse https://signoz.bsuit.app/dashboard para visualizá-los."
