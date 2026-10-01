import { GraphError } from "@microsoft/microsoft-graph-client";
import { classifyGraphError } from "../../../../src/tools/shared/graphErrors";

function makeGraphError(statusCode: number, message: string, code: string | null = null): GraphError {
  const err = new GraphError(statusCode, message);
  err.code = code;
  return err;
}

describe("classifyGraphError", () => {
  it("maps 403 to a permission-denied message", () => {
    expect(classifyGraphError(makeGraphError(403, "Forbidden"))).toEqual({
      message: "Graph denied this request - the app registration may be missing a required permission for this query.",
    });
  });

  it("maps 404 to a not-found message", () => {
    expect(classifyGraphError(makeGraphError(404, "Not Found"))).toEqual({
      message: "Graph returned not found for this request.",
    });
  });

  it("maps 429 to a throttling message", () => {
    expect(classifyGraphError(makeGraphError(429, "Too Many Requests"))).toEqual({
      message: "Graph throttled this request and retries were exhausted - try again shortly.",
    });
  });

  // Regression test: directoryAudits' actual error body for a date filter
  // past the tenant's retention window (confirmed live: days>30 400s on a
  // tenant with 30-day retention) came back with a generic code
  // ("UnknownError") that's indistinguishable from any other 400 without
  // inspecting err.message - this is what previously surfaced to Claude as
  // an opaque "Graph request failed (status 400, code UnknownError)",
  // which led to a wrong guess about retention being ~2 weeks instead of
  // the real, confirmed 30-day window.
  it("maps a directoryAudits retention-window 400 to a specific, actionable message", () => {
    const err = makeGraphError(
      400,
      "Specified argument was out of the range of valid values. (Parameter 'Minimum allowed time for activityDateTime is 6/12/2026 12:00:00 AM')",
      "UnknownError",
    );

    const result = classifyGraphError(err);

    expect(result.message).toMatch(/retention window/i);
    expect(result.message).not.toMatch(/UnknownError/);
  });

  it("falls back to a generic status/code message for an unrelated 400", () => {
    const err = makeGraphError(400, "The filter clause is invalid.", "BadRequest");

    expect(classifyGraphError(err)).toEqual({
      message: "Graph request failed (status 400, code BadRequest).",
    });
  });

  it("falls back to a generic caller-facing message for a non-GraphError Error, keeping the real message in `detail`", () => {
    // A bare Error here can carry internal config detail (e.g. an env var
    // name) that's fine for the audit log but must not reach the caller
    // verbatim - see ClassifiedError.detail's docblock.
    expect(classifyGraphError(new Error("boom"))).toEqual({
      message: "An internal error occurred while handling this request.",
      detail: "boom",
    });
  });

  it("falls back to a generic message for a non-Error throw", () => {
    expect(classifyGraphError("not an error")).toEqual({ message: "An unknown error occurred." });
  });
});
