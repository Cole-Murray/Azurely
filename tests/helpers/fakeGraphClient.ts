import type { Client } from "@microsoft/microsoft-graph-client";
import { getGraphClient } from "../../src/graph/client";

/**
 * Records everything a tool's Graph call chained onto a given `.api(path)`
 * request, so tests can assert on things like "the search request set
 * ConsistencyLevel: eventual" without a real HTTP layer.
 */
export interface RecordedRequest {
  path: string;
  filters: string[];
  headers: Record<string, string>;
  selects: string[];
  expands: string[];
  top?: number;
  orderby?: string[];
  count?: boolean;
  version?: string;
  search?: string;
}

export interface QueuedResponse {
  data?: unknown;
  error?: unknown;
}

/**
 * A minimal stand-in for @microsoft/microsoft-graph-client's Client, since
 * nothing in this repo mocked a real Graph HTTP call before these tools
 * existed. Each call to `.api(path)` starts a new recorded request; queued
 * responses are consumed in call order, so a tool that issues multiple
 * sequential or parallel Graph calls (e.g. get_user_directory_roles'
 * PIM active + eligible lookups) queues one entry per call.
 */
export function createFakeGraphClient(queue: QueuedResponse[]): { client: Client; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  let cursor = 0;

  function api(path: string) {
    const recorded: RecordedRequest = { path, filters: [], headers: {}, selects: [], expands: [] };
    requests.push(recorded);

    const chain = {
      header(key: string, value: string) {
        recorded.headers[key] = value;
        return chain;
      },
      filter(value: string) {
        recorded.filters.push(value);
        return chain;
      },
      search(value: string) {
        recorded.search = value;
        return chain;
      },
      select(fields: string | string[]) {
        recorded.selects.push(...(Array.isArray(fields) ? fields : [fields]));
        return chain;
      },
      expand(fields: string | string[]) {
        recorded.expands.push(...(Array.isArray(fields) ? fields : [fields]));
        return chain;
      },
      top(n: number) {
        recorded.top = n;
        return chain;
      },
      orderby(fields: string | string[]) {
        recorded.orderby = Array.isArray(fields) ? fields : [fields];
        return chain;
      },
      count(isCount = true) {
        recorded.count = isCount;
        return chain;
      },
      version(v: string) {
        recorded.version = v;
        return chain;
      },
      async get() {
        const next = queue[cursor];
        cursor += 1;
        if (!next) {
          throw new Error(`fakeGraphClient: no queued response for call #${cursor} (path: ${path})`);
        }
        if (next.error) {
          throw next.error;
        }
        return next.data;
      },
    };

    return chain;
  }

  return { client: { api } as unknown as Client, requests };
}

/**
 * Every tool test mocks `../../../src/graph/client` and then wires
 * getGraphClient's mock return value to a fresh fake client for that test -
 * this wraps that pair so test files don't each redefine the same two-line
 * helper. Requires the caller's test file to have already called
 * `jest.mock(".../graph/client")` (Jest mocks by resolved module path, so it
 * doesn't matter that this file imports getGraphClient via a different
 * relative path than the test file does).
 */
export function queueGraphResponses(queue: QueuedResponse[]): { client: Client; requests: RecordedRequest[] } {
  const fake = createFakeGraphClient(queue);
  (getGraphClient as jest.Mock).mockReturnValue(fake.client);
  return fake;
}
