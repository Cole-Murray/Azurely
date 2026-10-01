#!/usr/bin/env bash
# Emits JSON headers for Claude Code's headersHelper.
# Requires MCP_API_CLIENT_ID (the client ID of the MCP API app registration)
# and a prior: az login --scope "api://$MCP_API_CLIENT_ID/.default"
set -euo pipefail
: "${MCP_API_CLIENT_ID:?Set MCP_API_CLIENT_ID to the MCP API app registration client ID}"
TOKEN=$(az account get-access-token \
  --scope "api://${MCP_API_CLIENT_ID}/.default" \
  --query accessToken -o tsv)
printf '{"Authorization":"Bearer %s"}\n' "$TOKEN"
