// =============================================================================
// Entra IAM Review MCP — remote hosting infrastructure (Azure Container Apps)
// =============================================================================
//
// UNVALIDATED: this template has never been run through `az bicep build` or
// `az deployment group what-if` — the Azure CLI is not installed on the
// machine this was authored on. Run `az bicep build --file main.bicep`
// (compile-only, no Azure calls needed) before the first real deployment.
// See infra/README.md for the full manual-first, then-Bicep bring-up order.
//
// Deploys one resource group's worth of always-on hosting for the MCP
// server: a Log Analytics workspace (audit trail + container logs), a
// Container Apps Consumption environment, the container app itself, and a
// user-assigned managed identity wired up for both ACR pull and Key Vault
// secret access. The container registry and Key Vault themselves are NOT
// created here — see the `existing` resource declarations below for why.
//
// targetScope is left at the default (resourceGroup). ACR and Key Vault must
// live in the SAME resource group this template deploys into - see the
// `existing` declarations below for why that is a hard requirement here and
// not just a convention.

@description('Azure region for every resource this template creates. ACR/Key Vault (existing, referenced only) keep whatever region they already have.')
param location string = 'eastus2'

// -----------------------------------------------------------------------
// Existing resources: Azure Container Registry and Key Vault
// -----------------------------------------------------------------------
// Both are declared `existing`, never created here, on purpose: they hold
// state a template mistake must never be able to destroy — ACR holds every
// previously pushed image (including whatever the currently-live revision
// is running), and Key Vault holds the one production secret this app
// depends on to start at all. A `bicep` resource block with no `existing`
// flag is create-or-update; if this template were ever re-run against the
// wrong parameter (or a name typo), an owning declaration could recreate or
// overwrite either one. Referencing them as `existing` means this template
// can only ever read their properties (login server, vault URI) and grant
// role assignments scoped to them — never create, delete, or reconfigure
// them. Provision both by hand first (see infra/README.md step 2).

// Both must be in the SAME resource group as this deployment. That is not a
// stylistic preference - it is what the two role assignments below require.
// A role assignment is an *extension* resource, and Azure only allows an
// extension resource to target something inside the deployment's own resource
// group; reaching a resource in another group needs a separate module
// deployed at that group's scope. An earlier draft of this template exposed
// acrResourceGroupName / keyVaultResourceGroupName parameters for that, which
// worked at their defaults (the current resource group) and broke the moment
// anyone actually set them to something else - a latent trap rather than a
// feature. Removed rather than papered over: the documented bring-up
// (infra/README.md step 2) puts everything in one resource group anyway.
//
// If a shared/platform ACR in another group is ever genuinely needed, that is
// a deliberate refactor into a module - not a parameter change.

@description('Name of the existing Azure Container Registry to pull the container image from. Must be in this deployment\'s resource group.')
param acrName string

@description('Name of the existing Key Vault holding the "azure-client-secret" secret. Must be in this deployment\'s resource group.')
param keyVaultName string

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: acrName
}

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

// -----------------------------------------------------------------------
// Container image
// -----------------------------------------------------------------------
@description('Repository name inside the ACR, e.g. "iam-mcp".')
param imageRepository string = 'iam-mcp'

@description('The image tag to deploy. CI (.github/workflows/deploy.yml) deploys by short git SHA via `az containerapp update --image`, bypassing this template entirely for day-to-day deploys. This parameter matters when the *Bicep itself* is re-run (e.g. to change replica counts or probe settings) — passing a stale/default tag here would silently roll the running app back to that image. Read the live tag first: `az containerapp show -n ca-iam-mcp -g <rg> --query "properties.template.containers[0].image" -o tsv` (see infra/README.md, "image-tag drift trap").')
param imageTag string

// -----------------------------------------------------------------------
// Replicas
// -----------------------------------------------------------------------
@description('Minimum replica count. Defaults to 1, not 0: scale-to-zero\'s cold start on this app lands on the MCP `initialize` handshake and the first tool call, so a scaled-to-zero replica reads to a user as "the connector is broken", not "it is warming up". Keeping one replica always warm trades a small always-on cost for that failure mode never happening.')
param minReplicas int = 1

@description('Maximum replica count. Defaults to 1 for beta simplicity and cost, NOT because scaling out is unsafe: the MCP transport is deliberately stateless (sessionIdGenerator is undefined, one McpServer and transport constructed per POST), so no session state is held in-process and there is nothing for a second replica to be missing. The caches the tools use are module-global and tenant-keyed, so a cold replica just re-fetches - independent cold starts, never wrong answers. Raising this needs no code change and no session affinity; it is a cost and blast-radius decision, and a crude natural rate limit while the endpoint is new.')
param maxReplicas int = 1

// -----------------------------------------------------------------------
// Log Analytics retention
// -----------------------------------------------------------------------
@description('Log Analytics retention in days. Defaults to 90, not the Log Analytics default of 30 — this project logs structured audit entries (actor, tool, arguments, result) per CLAUDE.md\'s non-negotiable "structured audit logging" constraint, and 90 days is a deliberate retention policy for that audit trail, not an arbitrary number.')
param logRetentionDays int = 90

// -----------------------------------------------------------------------
// App configuration — non-secret environment variables
// -----------------------------------------------------------------------
@description('Primary Entra tenant GUID (AZURE_TENANT_ID). Not a secret, but still a real tenant identifier — keep the real value out of source control (see main.parameters.example.json).')
param azureTenantId string

@description('The multi-tenant app registration\'s client ID (AZURE_CLIENT_ID). Not a secret.')
param azureClientId string

@description('Optional second tenant GUID (AZURE_TENANT_ID_2). Leave blank to run single-tenant. Must be set together with azureTenantDisplayName2.')
param azureTenantId2 string = ''

@description('Optional second tenant display name (AZURE_TENANT_DISPLAYNAME_2). Must be set together with azureTenantId2.')
param azureTenantDisplayName2 string = ''

@description('Optional inbound caller-auth config: expected tenant ID for inbound MCP callers.')
param mcpInboundTenantId string = ''

@description('Optional inbound caller-auth config: accepted audiences (comma-separated, per the app\'s own parsing).')
param mcpInboundAudiences string = ''

@description('Optional inbound caller-auth config: required scope/role claim.')
param mcpRequiredScope string = ''

@description('Optional inbound caller-auth config: canonical resource identifier the app presents itself as.')
param mcpCanonicalResource string = ''

// -----------------------------------------------------------------------
// Fixed names and role definition GUIDs (not parameterized — these are
// design decisions, not per-environment knobs; see CLAUDE.md / the approved
// plan for why each is fixed rather than a parameter)
// -----------------------------------------------------------------------
var logAnalyticsWorkspaceName = 'log-iam-mcp-prod'
var containerAppsEnvironmentName = 'cae-iam-mcp-prod'
var containerAppName = 'ca-iam-mcp'
var managedIdentityName = 'id-iam-mcp'

// Built-in Azure RBAC role definition GUIDs (these are the same GUID in
// every Azure tenant — built-in roles are tenant-agnostic — so hardcoding
// them here is correct, not a shortcut).
var acrPullRoleDefinitionId = '7f951dda-4ed3-4680-a7ca-43fe172d538d' // AcrPull
var keyVaultSecretsUserRoleDefinitionId = '4633458b-17de-408a-b874-0445c86b69e6' // Key Vault Secrets User

// The Key Vault secret name is fixed by the application code
// (src/config/keyVault.ts's hardcoded CLIENT_SECRET_NAME = "azure-client-secret"),
// not something this template should be free to rename — a mismatch here
// would make the app fail to read its own secret at startup with no
// obviously-related error.
var clientSecretName = 'azure-client-secret'

// =============================================================================
// User-assigned managed identity
// =============================================================================
// User-assigned, not system-assigned, deliberately. A system-assigned
// identity does not exist until *after* the container app resource is
// created, so it cannot be referenced by the app's own `registries[].identity`
// (ACR pull) or `secrets[].identity` (Key Vault reference) at creation time —
// both need an identity resource ID to already exist. A user-assigned
// identity is created independently, up front, and its role assignments
// (below) are durable: deleting and recreating the container app (e.g. to
// change an immutable property) does not lose the ACR/Key Vault grants,
// because they belong to this identity resource, not to the app.
resource managedIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: managedIdentityName
  location: location
}

// -----------------------------------------------------------------------
// Role assignments — exactly two, each scoped to the specific resource,
// never to the resource group. Narrower scope means a compromised or
// misconfigured identity can't reach anything in the resource group beyond
// these two resources.
//
// NOTE: creating a role assignment requires the deploying principal to hold
// Owner or User Access Administrator at the target scope (ACR / Key Vault).
// If the principal running this deployment lacks that (common for a
// least-privilege CI identity), remove these two `roleAssignment` resource
// blocks and instead run the equivalent `az role assignment create`
// commands out-of-band, once, as someone who does hold that role (see
// infra/README.md step 2). Everything else in this template deploys fine
// without Owner/UAA.
// -----------------------------------------------------------------------

// AcrPull, scoped to the registry only: lets the managed identity pull
// images from this ACR and nothing else it might contain in a shared
// subscription.
resource acrPullRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, managedIdentity.id, acrPullRoleDefinitionId)
  scope: acr
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleDefinitionId)
    principalId: managedIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// Key Vault Secrets User, scoped to the vault only: read-only access to
// secret *values*. Deliberately not `Reader` (a control-plane role that
// grants zero data-plane access to secret values under RBAC authorization —
// it would let the identity see that a secret exists, never read it) and
// not `Key Vault Secrets Officer` (which additionally grants write/delete on
// secrets — this identity only ever needs to read one).
resource kvSecretsUserRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, managedIdentity.id, keyVaultSecretsUserRoleDefinitionId)
  scope: keyVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleDefinitionId)
    principalId: managedIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// =============================================================================
// Log Analytics workspace
// =============================================================================
resource logAnalyticsWorkspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: logAnalyticsWorkspaceName
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    // 90 days, not Log Analytics' own 30-day default — see the
    // logRetentionDays parameter description above for why.
    retentionInDays: logRetentionDays
  }
}

// =============================================================================
// Container Apps environment
// =============================================================================
// Deliberately Consumption-only: this template never sets `workloadProfiles`
// on the environment. Setting that property is what turns an environment
// into a "workload profiles" environment capable of Dedicated plans (which
// carry their own management fee, billed whether or not anything is
// running); omitting it entirely keeps this environment on the plain
// Consumption model, matching a single always-on replica's actual usage
// pattern.
resource containerAppsEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: containerAppsEnvironmentName
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalyticsWorkspace.properties.customerId
        sharedKey: logAnalyticsWorkspace.listKeys().primarySharedKey
      }
    }
  }
}

// =============================================================================
// Container app
// =============================================================================
resource containerApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: containerAppName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${managedIdentity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: containerAppsEnvironment.id

    // Role-assignment propagation into ACR/Key Vault can lag 1-2 minutes
    // behind the roleAssignment resources actually existing in ARM (see
    // infra/README.md's gotchas section). Making the dependency explicit
    // here at least guarantees ARM *creates* the role assignments before
    // attempting to create the app; it does not guarantee the *permission
    // has propagated* by the time the app's first pull/secret-read happens
    // — that's still a "wait and restart the revision" situation on a
    // first deploy, not something Bicep ordering alone can fix.
    dependsOn: [
      acrPullRoleAssignment
      kvSecretsUserRoleAssignment
    ]

    configuration: {
      // Multiple, not Single: the rollback procedure in infra/README.md
      // (`az containerapp ingress traffic set --revision-weight
      // <good-revision>=100`) only works if the previous revision is still
      // provisioned and reachable. In Single revision mode, creating a new
      // revision deprovisions the old one immediately, so there would be
      // nothing left to roll back *to*. The ingress traffic rule below
      // still sends 100% of traffic to whatever the latest revision is by
      // default — Multiple mode only changes what's possible during an
      // incident, not day-to-day behavior.
      activeRevisionsMode: 'Multiple'

      ingress: {
        external: true
        targetPort: 8080
        transport: 'auto'
        allowInsecure: false
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
        // stickySessions is deliberately omitted, and nothing here needs it.
        // Two independent reasons:
        //
        // 1. It would not work anyway. Container Apps' session affinity is
        //    cookie-based, and MCP HTTP clients issue plain fetch calls
        //    without persisting a cookie jar - the MCP spec does not require
        //    them to. So affinity could not reliably pin a client to a
        //    replica even if we wanted it to. It must never be treated as a
        //    correctness mechanism.
        //
        // 2. There is nothing to pin. The transport is deliberately stateless
        //    (sessionIdGenerator undefined; one McpServer + transport per
        //    POST), so no request depends on landing on the same replica as
        //    any earlier one. That is what makes raising maxReplicas, scaling
        //    to zero, and revision rollovers all invisible to clients - no
        //    code change and no affinity story required.
        //
        // The only shared state is module-global, tenant-keyed caches, where a
        // cold replica just re-fetches: independent cold starts, never wrong
        // answers.
      }

      registries: [
        {
          server: acr.properties.loginServer
          identity: managedIdentity.id
        }
      ]

      // Secret delivery: a Container Apps Key Vault secret *reference*, not
      // the app's own loadClientSecretFromKeyVault code path (src/config/
      // keyVault.ts). That code path exists for local dev (via `az login` /
      // DefaultAzureCredential) but is intentionally NOT exercised in this
      // hosted deployment — see the AZURE_KEY_VAULT_URL comment below for
      // why leaving it unset here is load-bearing, not an oversight.
      secrets: [
        {
          name: clientSecretName
          // Deliberately no secret *version* segment in this URL
          // (`.../secrets/azure-client-secret`, not
          // `.../secrets/azure-client-secret/<version>`). Omitting the
          // version is what lets Container Apps re-resolve the secret to
          // whatever the latest version is roughly every 30 minutes, and
          // any revision that references it as an env var is automatically
          // restarted when a newer version appears — so rotating the
          // secret (infra/README.md's rotation runbook) doesn't require a
          // template change or manual restart. Pinning a version would
          // trade that away for no benefit here.
          keyVaultUrl: '${keyVault.properties.vaultUri}secrets/${clientSecretName}'
          identity: managedIdentity.id
        }
      ]
    }

    template: {
      // terminationGracePeriodSeconds set explicitly (rather than left to
      // whatever Container Apps' own default is) so the number is visible
      // in source rather than implicit. The app must register a SIGTERM
      // handler (see the Dockerfile's comment on this — src/index.ts is
      // responsible for it) because `node dist/index.js` runs as PID 1
      // inside the container, and Linux does not deliver SIGTERM to PID 1
      // unless the process explicitly opts in with its own handler; without
      // one, every revision swap/scale-down would wait out the full grace
      // period and then SIGKILL, dropping in-flight requests instead of
      // finishing them.
      terminationGracePeriodSeconds: 30

      containers: [
        {
          name: 'iam-mcp'
          image: '${acr.properties.loginServer}/${imageRepository}:${imageTag}'
          resources: {
            // json('0.5') rather than a bare 0.5: Container Apps' resources
            // schema types cpu as a number, but Bicep/ARM's JSON number
            // handling for fractional CPU values needs this explicit
            // json()-wrapped literal to deploy the intended fractional
            // value reliably rather than being coerced.
            cpu: json('0.5')
            // Consumption plan requires memory roughly 2x vCPU in Gi, so
            // 0.5 vCPU pairs with 1.0Gi (not, say, 0.5Gi).
            memory: '1.0Gi'
          }
          env: concat(
            [
              {
                name: 'AZURE_TENANT_ID'
                value: azureTenantId
              }
              {
                name: 'AZURE_CLIENT_ID'
                value: azureClientId
              }
              {
                name: 'AZURE_CLIENT_SECRET'
                // secretRef, not value: the actual secret content never
                // appears in this template, in a deployment history entry,
                // or in `az containerapp show` output — only the reference
                // name does. The Key Vault secret block above is what
                // resolves this to a real value at runtime.
                secretRef: clientSecretName
              }
              {
                name: 'MCP_TRANSPORT'
                value: 'http'
              }
              {
                name: 'PORT'
                value: '8080'
              }
              {
                // Must be 0.0.0.0, not the app's 127.0.0.1 default. This is
                // the single most common first-deploy failure: if the app
                // only binds loopback, the Container Apps startup probe
                // (which connects from outside the container's network
                // namespace) can never reach it, and the revision never
                // goes healthy, no matter how correct every other setting
                // is.
                name: 'MCP_HTTP_HOST'
                value: '0.0.0.0'
              }
              // AZURE_KEY_VAULT_URL is deliberately ABSENT from this list,
              // and that absence is load-bearing, not an oversight.
              //
              // If it were set here alongside AZURE_CLIENT_SECRET (via
              // secretRef above), the app's loadClientSecretFromKeyVault
              // (src/config/keyVault.ts) would run at startup and
              // authenticate to Key Vault using DefaultAzureCredential.
              // DefaultAzureCredential tries EnvironmentCredential FIRST in
              // its fallback chain — and because AZURE_CLIENT_ID and
              // AZURE_TENANT_ID are ALWAYS set in this container (they're
              // the Graph app registration's identifiers, needed for every
              // Graph/ARM call this app makes), EnvironmentCredential would
              // successfully construct a credential... for the Graph app
              // registration, which holds no Key Vault role at all. The
              // result is a 403 from Key Vault that looks bafflingly wrong
              // because every individual env var is "correct" — the app
              // just authenticated as the wrong identity for that one call.
              // Leaving AZURE_KEY_VAULT_URL unset means
              // loadClientSecretFromKeyVault's code path never runs in this
              // deployment at all; the Container Apps secret reference
              // above is the only mechanism that ever touches Key Vault
              // here, and it authenticates as the managed identity by
              // construction (see the `identity:` field on the secret
              // block), not via DefaultAzureCredential's fallback chain.
            ],
            // Each conditional arm below is a separate concat() argument —
            // commas between them are required (BCP237 without them).
            !empty(azureTenantId2) ? [
              {
                name: 'AZURE_TENANT_ID_2'
                value: azureTenantId2
              }
            ] : [],
            !empty(azureTenantDisplayName2) ? [
              {
                name: 'AZURE_TENANT_DISPLAYNAME_2'
                value: azureTenantDisplayName2
              }
            ] : [],
            !empty(mcpInboundTenantId) ? [
              {
                name: 'MCP_INBOUND_TENANT_ID'
                value: mcpInboundTenantId
              }
            ] : [],
            !empty(mcpInboundAudiences) ? [
              {
                name: 'MCP_INBOUND_AUDIENCES'
                value: mcpInboundAudiences
              }
            ] : [],
            !empty(mcpRequiredScope) ? [
              {
                name: 'MCP_REQUIRED_SCOPE'
                value: mcpRequiredScope
              }
            ] : [],
            !empty(mcpCanonicalResource) ? [
              {
                name: 'MCP_CANONICAL_RESOURCE'
                value: mcpCanonicalResource
              }
            ] : []
          )

          // Probe roles matter here, and swapping Liveness and Readiness
          // would silently recreate the exact crash-loop this whole design
          // is meant to avoid:
          probes: [
            {
              // Startup: gates when Container Apps starts running the
              // Liveness/Readiness probes at all. Generous
              // failureThreshold x periodSeconds gives the app plenty of
              // room for cold start (module loads, credential setup) before
              // anything is judged unhealthy.
              type: 'Startup'
              httpGet: {
                path: '/healthz'
                port: 8080
              }
              initialDelaySeconds: 5
              periodSeconds: 5
              failureThreshold: 30 // up to ~150s to come up before considered failed
              timeoutSeconds: 5
            }
            {
              // Liveness -> /healthz, NEVER /readyz. /healthz never touches
              // Graph/ARM/Key Vault and is always 200 while the process is
              // alive; /readyz is 503 until the client secret finishes
              // loading. If Liveness pointed at /readyz, a container that
              // is merely still warming up credentials would be judged
              // "dead" and restarted — which resets the warm-up clock and
              // can loop forever without ever becoming ready.
              type: 'Liveness'
              httpGet: {
                path: '/healthz'
                port: 8080
              }
              initialDelaySeconds: 10
              periodSeconds: 30
              failureThreshold: 3
              timeoutSeconds: 5
            }
            {
              // Readiness -> /readyz. This is the probe that's supposed to
              // reflect "not ready yet" — it's what keeps a replica out of
              // ingress rotation until the secret is loaded, without that
              // state ever being mistaken for "the container is broken"
              // (which is what Liveness pointing here would do).
              type: 'Readiness'
              httpGet: {
                path: '/readyz'
                port: 8080
              }
              initialDelaySeconds: 5
              periodSeconds: 10
              failureThreshold: 3
              timeoutSeconds: 5
            }
          ]
        }
      ]

      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
      }
    }
  }
}

// =============================================================================
// Outputs
// =============================================================================
@description('The public FQDN of the container app ingress (https://<this>/mcp is the MCP endpoint, https://<this>/healthz the liveness check).')
output containerAppFqdn string = containerApp.properties.configuration.ingress.fqdn

@description('The client ID of the user-assigned managed identity, for reference when auditing role assignments or debugging Key Vault/ACR access.')
output managedIdentityClientId string = managedIdentity.properties.clientId
