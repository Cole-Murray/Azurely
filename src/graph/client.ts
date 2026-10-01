import { Client, MiddlewareFactory, RetryHandler, type Middleware } from "@microsoft/microsoft-graph-client";
import { TokenCredentialAuthenticationProvider } from "@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials";
import { getCredential } from "../auth/credential";
import { createRetryOptions } from "./throttling";

// App-only (client credentials) auth against Graph always uses this fixed
// scope - Graph resolves actual permissions from the app registration's
// granted application permissions, not from the scope string itself.
const GRAPH_SCOPE = "https://graph.microsoft.com/.default";

const clientCache = new Map<string, Client>();

export function getGraphClient(tenantId: string): Client {
  const cached = clientCache.get(tenantId);
  if (cached) {
    return cached;
  }

  const credential = getCredential(tenantId);
  const authProvider = new TokenCredentialAuthenticationProvider(credential, {
    scopes: [GRAPH_SCOPE],
  });

  // Build the default middleware chain explicitly (rather than the opaque
  // Client.init helper) so we can swap in our own RetryHandlerOptions -
  // this is what makes the throttling policy in throttling.ts actually
  // take effect instead of the SDK's unconfigured default.
  const middleware: Middleware[] = MiddlewareFactory.getDefaultMiddlewareChain(authProvider);
  const retryIndex = middleware.findIndex((handler) => handler instanceof RetryHandler);
  middleware[retryIndex] = new RetryHandler(createRetryOptions());

  const client = Client.initWithMiddleware({ middleware });
  clientCache.set(tenantId, client);
  return client;
}

/** Test-only escape hatch - clears the cache between test cases. */
export function resetGraphClientCacheForTests(): void {
  clientCache.clear();
}
