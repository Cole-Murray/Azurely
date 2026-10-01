import { getReadiness, markFailed, markReady, resetReadinessForTests } from "../../../src/http/readiness";

afterEach(() => {
  resetReadinessForTests();
});

describe("readiness", () => {
  it("starts in the 'starting' state", () => {
    expect(getReadiness()).toEqual({ status: "starting" });
  });

  it("markReady() transitions to 'ready'", () => {
    markReady();
    expect(getReadiness()).toEqual({ status: "ready" });
  });

  it("markFailed() transitions to 'failed' with the reason and attempt count", () => {
    markFailed("keyvault: access denied fetching azure-client-secret", 5);
    expect(getReadiness()).toEqual({
      status: "failed",
      reason: "keyvault: access denied fetching azure-client-secret",
      attempts: 5,
    });
  });

  it("resetReadinessForTests() returns to 'starting'", () => {
    markReady();
    resetReadinessForTests();
    expect(getReadiness()).toEqual({ status: "starting" });
  });
});
