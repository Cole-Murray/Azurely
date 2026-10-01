import { getAuthorizationClient, getSubscriptionClient } from "../../src/arm/client";

/**
 * The ARM (@azure/arm-*) analog of fakeGraphClient.ts. ARM's SDK clients
 * aren't a fluent request builder like the Graph client - each operation is
 * a plain method returning a PagedAsyncIterableIterator, so the fake here is
 * a plain object exposing exactly the operations this project's code calls,
 * rather than a chainable request recorder.
 */

/** Wraps a plain array as the async iterable every `for await (const x of client.foo.listForScope(...))` call in this project expects - real PagedAsyncIterableIterator also exposes byPage(), but nothing here calls that. */
export function asyncIterableOf<T>(items: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) {
        yield item;
      }
    },
  };
}

/** An async iterable whose first iteration throws - simulates a 403/other failure surfacing partway through a `for await` loop, the same way the real SDK would surface a RestError. */
export function asyncIterableThatThrows(error: unknown): AsyncIterable<never> {
  return {
    // eslint-disable-next-line require-yield -- deliberately never yields; throws immediately on the first `next()`.
    async *[Symbol.asyncIterator]() {
      throw error;
    },
  };
}

export interface FakeAuthorizationClient {
  roleAssignments: { listForScope: jest.Mock };
  roleAssignmentScheduleInstances: { listForScope: jest.Mock };
  roleEligibilityScheduleInstances: { listForScope: jest.Mock };
  roleAssignmentScheduleRequests: { listForScope: jest.Mock };
  roleDefinitions: { list: jest.Mock };
}

/** A fresh fake AuthorizationManagementClient with every operation this project calls stubbed as a jest.fn() the test configures per-case via mockReturnValue/mockImplementation. */
export function createFakeAuthorizationClient(): FakeAuthorizationClient {
  return {
    roleAssignments: { listForScope: jest.fn() },
    roleAssignmentScheduleInstances: { listForScope: jest.fn() },
    roleEligibilityScheduleInstances: { listForScope: jest.fn() },
    roleAssignmentScheduleRequests: { listForScope: jest.fn() },
    roleDefinitions: { list: jest.fn() },
  };
}

/** Requires the caller's test file to have already called jest.mock("../../../src/arm/client") - same contract as queueGraphResponses. */
export function mockGetAuthorizationClient(client: FakeAuthorizationClient): void {
  (getAuthorizationClient as jest.Mock).mockReturnValue(client);
}

/** Stubs getSubscriptionClient to report the given subscription ids as discovered. */
export function mockDiscoveredSubscriptions(subscriptionIds: string[]): void {
  (getSubscriptionClient as jest.Mock).mockReturnValue({
    subscriptions: {
      list: () => asyncIterableOf(subscriptionIds.map((id) => ({ subscriptionId: id, displayName: `Subscription ${id}` }))),
    },
  });
}
