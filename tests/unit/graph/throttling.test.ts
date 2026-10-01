import { createRetryOptions } from "../../../src/graph/throttling";

describe("createRetryOptions", () => {
  it("caps retries below the Graph SDK's hard maximum", () => {
    const options = createRetryOptions();

    expect(options.maxRetries).toBe(3);
    expect(options.maxRetries).toBeLessThanOrEqual(10);
  });

  it("sets a base delay used when Graph omits Retry-After", () => {
    const options = createRetryOptions();

    expect(options.delay).toBe(3);
  });
});
