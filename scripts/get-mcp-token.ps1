# Emits JSON headers for Claude Code's headersHelper (Windows).
# Requires $env:MCP_API_CLIENT_ID (the client ID of the MCP API app
# registration) and a prior: az login --scope "api://$env:MCP_API_CLIENT_ID/.default"
$ErrorActionPreference = "Stop"
if (-not $env:MCP_API_CLIENT_ID) { throw "Set MCP_API_CLIENT_ID to the MCP API app registration's client ID" }
$token = az account get-access-token `
  --scope "api://$($env:MCP_API_CLIENT_ID)/.default" `
  --query accessToken -o tsv
if (-not $token) { throw "Failed to acquire MCP access token via Azure CLI" }
Write-Output ("{`"Authorization`":`"Bearer {0}`"}" -f $token.Trim())
