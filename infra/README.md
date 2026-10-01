# Remote hosting infrastructure

This directory holds the Bicep template (`main.bicep`) and an example
parameters file (`main.parameters.example.json`) for hosting the Entra IAM
Review MCP server on Azure Container Apps. This README is a runbook for
someone doing this for the first time — it assumes familiarity with the app
itself but not with Azure hosting specifics.

**Status: the Bicep template has not been validated against a real Azure CLI
or subscription.** It was authored on a machine without the Azure CLI
installed, so `az bicep build` and `az deployment group what-if` have never
been run against it. Treat every command below as documented intent, and run
`az bicep build --file main.bicep` (a pure compile step, needs no Azure
login) as the first sanity check before anything else in this file.

## 1. Prerequisites

- **Azure CLI installed.** It is *not* currently installed on the dev
  machine this template was written on — if you're reading this to do the
  first real deployment, install it first (`https://aka.ms/installazurecliwindows`
  or your platform's equivalent) and confirm with `az version`.
- **`az login`** — an interactive login with an account that has at least
  Contributor on the target subscription, and ideally Owner/User Access
  Administrator (see the next bullet).
- **The `containerapp` CLI extension:**
  ```
  az extension add --name containerapp --upgrade
  ```
- **Two resource providers registered** on the subscription (a one-time
  per-subscription setup, not per-deployment):
  ```
  az provider register --namespace Microsoft.App
  az provider register --namespace Microsoft.OperationalInsights
  ```
  Check registration state with `az provider show --namespace Microsoft.App
  --query registrationState -o tsv` (want `Registered`).
- **Owner or User Access Administrator** on the subscription (or at least on
  the resource groups holding the ACR and Key Vault) — creating the two role
  assignments in `main.bicep` (AcrPull, Key Vault Secrets User) requires this.
  If the account doing the deploy doesn't have it, see the comment in
  `main.bicep` above the `roleAssignment` resources: remove those two blocks
  from the template and run the equivalent `az role assignment create`
  commands separately, as someone who does hold that role.

## 2. First manual bring-up (do this before running the Bicep)

Do this once, by hand, one command at a time, **before** trusting the Bicep
template end-to-end. Each of these has its own failure mode, and they're far
easier to diagnose individually than inside one large `az deployment group
create` that fails partway through.

```bash
# Pick names/values once and reuse them through this whole section.
RG=rg-iam-mcp-prod
LOCATION=eastus2
ACR_NAME=youracrname          # must be globally unique
KV_NAME=your-kv-name          # must be globally unique
IDENTITY_NAME=id-iam-mcp
YOUR_UPN=you@yourtenant.onmicrosoft.com

# 1. Resource group
az group create --name $RG --location $LOCATION

# 2. Log Analytics workspace (90-day retention - see main.bicep's
#    logRetentionDays parameter comment for why 90, not the 30-day default)
az monitor log-analytics workspace create \
  --resource-group $RG \
  --workspace-name log-iam-mcp-prod \
  --location $LOCATION \
  --retention-time 90

# 3. Container Apps environment (Consumption - no --enable-workload-profiles
#    flag, which is what keeps this off the Dedicated-plan billing model)
az containerapp env create \
  --name cae-iam-mcp-prod \
  --resource-group $RG \
  --location $LOCATION \
  --logs-workspace-id $(az monitor log-analytics workspace show -g $RG -n log-iam-mcp-prod --query customerId -o tsv) \
  --logs-workspace-key $(az monitor log-analytics workspace get-shared-keys -g $RG -n log-iam-mcp-prod --query primarySharedKey -o tsv)

# 4. ACR - admin user explicitly disabled; auth is via managed identity only
az acr create \
  --name $ACR_NAME \
  --resource-group $RG \
  --sku Basic \
  --admin-enabled false

# 5. User-assigned managed identity
az identity create --name $IDENTITY_NAME --resource-group $RG
IDENTITY_ID=$(az identity show -g $RG -n $IDENTITY_NAME --query id -o tsv)
IDENTITY_PRINCIPAL_ID=$(az identity show -g $RG -n $IDENTITY_NAME --query principalId -o tsv)
IDENTITY_CLIENT_ID=$(az identity show -g $RG -n $IDENTITY_NAME --query clientId -o tsv)

# 6. Key Vault - RBAC authorization (not access policies) and purge
#    protection on. RBAC authorization is what makes "Key Vault Secrets
#    User" a meaningful, narrow grant later; purge protection means a
#    deleted vault/secret can't be permanently destroyed inside its
#    retention window, protecting against an accidental `az keyvault delete`.
az keyvault create \
  --name $KV_NAME \
  --resource-group $RG \
  --location $LOCATION \
  --enable-rbac-authorization true \
  --enable-purge-protection true

# 7. The two role assignments the managed identity needs
ACR_ID=$(az acr show -n $ACR_NAME -g $RG --query id -o tsv)
KV_ID=$(az keyvault show -n $KV_NAME -g $RG --query id -o tsv)

az role assignment create \
  --assignee-object-id $IDENTITY_PRINCIPAL_ID \
  --assignee-principal-type ServicePrincipal \
  --role "AcrPull" \
  --scope $ACR_ID

az role assignment create \
  --assignee-object-id $IDENTITY_PRINCIPAL_ID \
  --assignee-principal-type ServicePrincipal \
  --role "Key Vault Secrets User" \
  --scope $KV_ID

# 8. Grant YOURSELF Key Vault Secrets Officer so you can set the secret
#    value in the next step. Subscription Owner does NOT grant you
#    data-plane secret access under RBAC authorization - Owner is a
#    control-plane role; reading/writing secret *values* is a data-plane
#    operation gated by its own RBAC roles.
az role assignment create \
  --assignee $YOUR_UPN \
  --role "Key Vault Secrets Officer" \
  --scope $KV_ID

# 9. Set the actual secret. The name is fixed by src/config/keyVault.ts's
#    hardcoded CLIENT_SECRET_NAME - it must be exactly this string.
az keyvault secret set \
  --vault-name $KV_NAME \
  --name azure-client-secret \
  --value "<the app registration's client secret value>"

# 10. Build and push the FIRST image - the container app cannot be created
#     pointing at an image that doesn't exist yet in the registry.
az acr login --name $ACR_NAME
docker build --build-arg GIT_SHA=$(git rev-parse --short HEAD) -t $ACR_NAME.azurecr.io/iam-mcp:bootstrap .
docker push $ACR_NAME.azurecr.io/iam-mcp:bootstrap

# 11. ACR needs managed-identity pull explicitly enabled (see gotcha below)
az acr config authentication-as-arm update --registry $ACR_NAME --status enabled

# 12. Create the container app itself, referencing the identity, image,
#     and Key Vault secret. (Probe configuration is NOT settable via
#     `az containerapp create` flags - see the gotcha below. This first
#     manual create will come up with Container Apps' own default probes;
#     apply main.bicep afterwards, or `az containerapp update` by hand, to
#     get the Startup/Liveness/Readiness probes this project actually wants.)
az containerapp create \
  --name ca-iam-mcp \
  --resource-group $RG \
  --environment cae-iam-mcp-prod \
  --image $ACR_NAME.azurecr.io/iam-mcp:bootstrap \
  --registry-server $ACR_NAME.azurecr.io \
  --registry-identity $IDENTITY_ID \
  --user-assigned $IDENTITY_ID \
  --ingress external \
  --target-port 8080 \
  --min-replicas 1 --max-replicas 1 \
  --cpu 0.5 --memory 1.0Gi \
  --secrets "azure-client-secret=keyvaultref:https://$KV_NAME.vault.azure.net/secrets/azure-client-secret,identityref:$IDENTITY_ID" \
  --env-vars \
    AZURE_TENANT_ID=<primary-tenant-guid> \
    AZURE_CLIENT_ID=<app-registration-client-id> \
    AZURE_CLIENT_SECRET=secretref:azure-client-secret \
    MCP_TRANSPORT=http \
    PORT=8080 \
    MCP_HTTP_HOST=0.0.0.0
```

Once this manual bring-up works end-to-end (revision goes healthy, `/healthz`
and `/readyz` both respond correctly), everything above is exactly what
`main.bicep` automates for repeatable future deploys — see section 4.

## 3. Gotchas, roughly in the order they'll bite

1. **Role-assignment propagation can lag 1-2 minutes.** If the container app
   comes up unable to pull the image or read the Key Vault secret
   immediately after step 7 above (or after `main.bicep`'s role assignments),
   wait a couple of minutes and restart the revision (`az containerapp
   revision restart`) before assuming the role assignment itself is wrong.
   This is the single most common false alarm in a first deploy.
2. **The image must exist before the app is created.** `az containerapp
   create` (and the Bicep's `containerApps` resource) will fail outright if
   the referenced image tag isn't already in the registry - hence step 10
   above happening before step 12.
3. **ACR needs an explicit opt-in for managed-identity pull**:
   `az acr config authentication-as-arm update --registry <name> --status
   enabled`. Without it, `AcrPull` role assignment alone is not sufficient
   for a Container Apps managed-identity pull to work.
4. **Probes aren't settable via `az containerapp create` flags at all** -
   there's no `--startup-probe`/`--liveness-probe` flag on that command. The
   only ways to set the Startup/Liveness/Readiness probes this project
   depends on (see `main.bicep`'s probes comment) are the Bicep template, a
   raw YAML spec passed to `az containerapp create --yaml`, or `az
   containerapp update` with a full ARM-shaped patch. Don't go looking for a
   `create`-time flag that doesn't exist.

## 4. Deploying the Bicep

```bash
cp main.parameters.example.json main.parameters.json
# edit main.parameters.json with real values - then, per infra/README.md's
# own advice, make sure it's gitignored (add "infra/main.parameters.json" to
# .gitignore if it isn't already; the repo intentionally ships only the
# .example.json so a real one is never committed by accident).

# Always what-if first - see exactly what would change before it changes.
az deployment group what-if \
  --resource-group $RG \
  --template-file main.bicep \
  --parameters main.parameters.json

# Then apply for real.
az deployment group create \
  --resource-group $RG \
  --template-file main.bicep \
  --parameters main.parameters.json
```

## 5. The image-tag drift trap

`.github/workflows/deploy.yml` deploys day-to-day by running `az
containerapp update --image <acr>/iam-mcp:<short-sha>` directly - it never
re-runs this Bicep template. But `main.bicep` itself takes an `imageTag`
parameter, and if you re-run the Bicep later (say, to bump `maxReplicas` or
change a probe setting) with `main.parameters.json` still holding whatever
tag was in it from the last time you edited that file, **the app rolls back**
to that stale image - silently, because from the Bicep's point of view it's
just applying the parameters it was given.

Before touching the Bicep for any reason, read the currently-live tag and put
it in your parameters file first:

```bash
az containerapp show \
  --name ca-iam-mcp \
  --resource-group $RG \
  --query "properties.template.containers[0].image" -o tsv
```

## 6. Rollback

Keep this section easy to find - it's the one you'll want under pressure.

```bash
# List revisions, newest first, to find the last known-good one.
az containerapp revision list \
  --name ca-iam-mcp --resource-group $RG \
  --query "[].{name:name, active:properties.active, created:properties.createdTime, healthState:properties.healthState}" \
  -o table

# Shift 100% of traffic back to it. This only works because
# activeRevisionsMode is "Multiple" (see main.bicep's comment on that
# setting) - the old revision has to still be provisioned to receive traffic.
az containerapp ingress traffic set \
  --name ca-iam-mcp --resource-group $RG \
  --revision-weight <good-revision-name>=100
```

This changes traffic routing immediately without needing a new image build
or a new deploy run - it's the fastest lever available during an incident.
Follow up afterwards by fixing forward and letting a normal deploy replace
it, rather than leaving traffic pinned to an old revision long-term.

> **Trap: re-running the Bicep silently undoes a rollback.**
> `main.bicep` declares `traffic: [{ latestRevision: true, weight: 100 }]`,
> which is what makes a normal deploy's new revision receive traffic
> automatically. The rollback command above overrides that, pinning traffic
> to one named revision. Those two are in direct conflict: the next
> `az deployment group create` resets traffic back to "whatever is latest"
> and puts the bad revision straight back into service - with no error and
> nothing in the deploy output to suggest anything happened.
>
> So while traffic is pinned, treat the Bicep as frozen. Either fix forward
> and let a normal deploy supersede the bad revision (preferred), or, if you
> genuinely must run the Bicep while pinned, re-apply the traffic weight
> immediately afterwards and verify with:
>
> ```bash
> az containerapp show --name ca-iam-mcp --resource-group $RG \
>   --query "properties.configuration.ingress.traffic" -o json
> ```
>
> This is the same class of problem as the image-tag drift in section 5:
> two writers (CI/the portal and this template) disagreeing about desired
> state, where the template wins the moment it runs.

## 7. Secret rotation runbook

**The single most dangerous command in this whole file:** `az ad app
credential reset` on the app registration **deletes every existing client
secret unless you pass `--append`**. Running it without `--append` causes an
immediate, total outage - every tenant this app talks to starts failing auth
at the same moment, because the *one* secret the app was using no longer
exists anywhere.

Rotate like this instead:

1. **Add a new credential without removing the old one:**
   ```bash
   az ad app credential reset --id <app-id> --append --display-name "rotation-$(date +%Y%m%d)"
   ```
   Both the old and new secret values are valid at this point - this
   overlap is what makes the rest of this procedure safe.
2. **Add the new value as a new *version* of the same Key Vault secret**
   (not a new secret name - `azure-client-secret` must stay the name, since
   that's what `src/config/keyVault.ts` hardcodes):
   ```bash
   az keyvault secret set --vault-name $KV_NAME --name azure-client-secret --value "<new secret value>"
   ```
   Container Apps re-resolves the unversioned `keyVaultUrl` reference to
   whatever the latest version is roughly every 30 minutes, and
   automatically restarts revisions that reference it as an env var when a
   newer version appears (see `main.bicep`'s comment on why the
   `keyVaultUrl` deliberately omits a version segment) - no manual restart
   *should* be needed, but confirm the next step regardless.
3. **Verify** the app is healthy and successfully authenticating (check
   `/readyz`, and the "token acquired: yes" log line - see the observability
   section below) before proceeding.
4. **Only then**, remove the old credential from the app registration:
   ```bash
   az ad app credential list --id <app-id> -o table   # find the old key ID
   az ad app credential delete --id <app-id> --key-id <old-key-id>
   ```

## 8. CI/CD setup

`.github/workflows/deploy.yml` authenticates via OIDC federation - there is
no stored Azure credential in GitHub at all. This needs a **second** managed
identity (distinct from `id-iam-mcp`, which is the *app's* identity for
ACR pull / Key Vault reads at runtime) dedicated to CI deploys:

```bash
DEPLOY_IDENTITY_NAME=id-iam-mcp-deploy
az identity create --name $DEPLOY_IDENTITY_NAME --resource-group $RG
DEPLOY_IDENTITY_CLIENT_ID=$(az identity show -g $RG -n $DEPLOY_IDENTITY_NAME --query clientId -o tsv)
DEPLOY_IDENTITY_PRINCIPAL_ID=$(az identity show -g $RG -n $DEPLOY_IDENTITY_NAME --query principalId -o tsv)

# Federated credential: trust GitHub Actions runs from main on this exact repo.
# The "subject" string below is compared EXACTLY, case-sensitively, by Azure
# AD - "MyOrg" vs "myorg", or "ref:refs/heads/main" vs "ref:refs/heads/Main",
# is a hard failure, not a warning. A mismatch here produces
# AADSTS70021: No matching federated identity record found - if you hit that
# error, this subject string is the first thing to re-check character by
# character against the actual repo owner/name and branch.
az identity federated-credential create \
  --name deploy-from-main \
  --identity-name $DEPLOY_IDENTITY_NAME \
  --resource-group $RG \
  --issuer "https://token.actions.githubusercontent.com" \
  --subject "repo:<github-org>/<repo>:ref:refs/heads/main" \
  --audiences "api://AzureADTokenExchange"

# Scope: AcrPush on the registry (to push new images) and Contributor on
# THIS ONE container app resource (to update it) - never anything broader,
# and critically, NEVER any Key Vault role. The deploy identity has no
# business reading the secret; only the app's own runtime identity
# (id-iam-mcp) does.
az role assignment create \
  --assignee-object-id $DEPLOY_IDENTITY_PRINCIPAL_ID --assignee-principal-type ServicePrincipal \
  --role "AcrPush" --scope $(az acr show -n $ACR_NAME -g $RG --query id -o tsv)

az role assignment create \
  --assignee-object-id $DEPLOY_IDENTITY_PRINCIPAL_ID --assignee-principal-type ServicePrincipal \
  --role "Contributor" --scope $(az containerapp show -n ca-iam-mcp -g $RG --query id -o tsv)
```

Then set these as GitHub **Variables** (not Secrets - see `deploy.yml`'s
comment on why identifiers don't need Secret-level protection when OIDC
removes the credential entirely) under the repo's `production` Environment:

| Variable | Value |
|---|---|
| `AZURE_CLIENT_ID` | `$DEPLOY_IDENTITY_CLIENT_ID` above |
| `AZURE_TENANT_ID` | the tenant GUID hosting this subscription |
| `AZURE_SUBSCRIPTION_ID` | the subscription GUID |
| `ACR_NAME` | e.g. `youracrname` |
| `RESOURCE_GROUP` | e.g. `rg-iam-mcp-prod` |
| `CONTAINER_APP_NAME` | `ca-iam-mcp` |

## 9. Observability

The app writes structured audit log lines as `console.error("[audit] " +
JSON.stringify(entry))` - note `"[audit] "` (with the trailing space) is
exactly 8 characters, which the KQL below relies on to strip the prefix
before parsing JSON.

```kusto
ContainerAppConsoleLogs_CL
| where ContainerAppName_s == "ca-iam-mcp" and Log_s startswith "[audit] "
| extend e = parse_json(substring(Log_s, 8))
| project TimeGenerated, actor=tostring(e.actor), actorSource=tostring(e.actorSource), tool=tostring(e.tool), status=tostring(e.status)
| order by TimeGenerated desc
```

Two more things worth knowing when debugging in Log Analytics:

- **`ContainerAppSystemLogs_CL`**, not `ContainerAppConsoleLogs_CL`, is where
  image-pull failures and Key Vault secret-reference failures surface -
  those are platform-level events about the revision, not something the
  app's own code ever logs. If a revision won't come up and the app's own
  console logs show nothing at all, check this table first.
- **Alert suggestion:** an alert rule on `Log_s has "token acquired: no"` is
  a good expired/revoked-secret canary - the app logs exactly that string
  (never the token or secret itself, per this project's "never log
  secrets" constraint) whenever a credential acquisition fails, which is
  usually the first visible symptom of a secret that's expired or been
  revoked out from under the app.

## 10. A privacy note

Tool arguments are logged as part of every audit entry, and only
secret-*looking keys* are redacted - values are not blanket-redacted. In
practice this means UPNs, user search strings, object GUIDs, and Azure scope
paths (subscription/resource-group IDs) that colleagues pass as tool
arguments now sit at rest in this Log Analytics workspace for the full
90-day retention window. Restrict workspace read access (`Log Analytics
Reader` / `Monitoring Reader` at the workspace scope) to a small, named list
of people rather than leaving it open to everyone with subscription Reader -
this is real, if low-sensitivity, directory data about real people, not
synthetic test data.
