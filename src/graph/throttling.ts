import { RetryHandlerOptions } from "@microsoft/microsoft-graph-client";

// The Graph SDK's hard ceiling is 10 retries; 3 is plenty for read-only
// directory queries and keeps a throttled request from hanging for minutes.
const MAX_RETRIES = 3;
// Only used when Graph's response omits a Retry-After header.
const BASE_DELAY_SECONDS = 3;

/**
 * Graph throttles with a 429 (occasionally 503) and tells us how long to
 * wait via the Retry-After header. The SDK's built-in RetryHandler already
 * reads that header internally - this function exists so the retry policy
 * is explicit and tunable in our own code instead of an invisible library
 * default that nobody on this project chose on purpose.
 */
export function createRetryOptions(): RetryHandlerOptions {
  return new RetryHandlerOptions(BASE_DELAY_SECONDS, MAX_RETRIES);
}
