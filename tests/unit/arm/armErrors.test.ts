import { RestError } from "@azure/core-rest-pipeline";
import { classifyArmError } from "../../../src/arm/armErrors";

describe("classifyArmError", () => {
  it("maps 403 to an actionable Reader-grant message and flags isAccessDenied", () => {
    const result = classifyArmError(new RestError("Forbidden", { statusCode: 403, code: "AuthorizationFailed" }));

    expect(result.isAccessDenied).toBe(true);
    expect(result.message).toMatch(/Reader/);
    expect(result.message).toMatch(/root management group/);
  });

  it("maps 400/InsufficientPermissions to an actionable message and flags isAccessDenied", () => {
    const result = classifyArmError(
      new RestError("Bad Request", {
        statusCode: 400,
        code: "InsufficientPermissions",
      }),
    );

    expect(result.isAccessDenied).toBe(true);
    expect(result.message).toMatch(/insufficient/i);
  });

  it("maps 404 to a not-found message", () => {
    const result = classifyArmError(new RestError("Not Found", { statusCode: 404 }));

    expect(result).toEqual({ message: "Azure Resource Manager returned not found for this request.", isAccessDenied: false });
  });

  it("maps 429 to a throttling message", () => {
    const result = classifyArmError(new RestError("Too Many Requests", { statusCode: 429 }));

    expect(result).toEqual({
      message: "Azure Resource Manager throttled this request and retries were exhausted - try again shortly.",
      isAccessDenied: false,
    });
  });

  it("falls back to a generic status/code message for an unrelated RestError", () => {
    const result = classifyArmError(new RestError("Bad request", { statusCode: 400, code: "InvalidParameter" }));

    expect(result).toEqual({
      message: "Azure Resource Manager request failed (status 400, code InvalidParameter).",
      isAccessDenied: false,
    });
  });

  it("falls back to a generic caller-facing message for a non-RestError Error, keeping the real message in `detail`", () => {
    // A bare Error here can carry internal config detail (e.g. an env var
    // name) that's fine for the audit log but must not reach the caller
    // verbatim - see ClassifiedArmError.detail's docblock.
    expect(classifyArmError(new Error("boom"))).toEqual({
      message: "An internal error occurred while handling this request.",
      detail: "boom",
      isAccessDenied: false,
    });
  });

  it("falls back to a generic message for a non-Error throw", () => {
    expect(classifyArmError("not an error")).toEqual({
      message: "An unknown error occurred while querying Azure Resource Manager.",
      isAccessDenied: false,
    });
  });
});
