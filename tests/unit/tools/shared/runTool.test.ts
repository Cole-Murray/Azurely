import { RestError } from "@azure/core-rest-pipeline";
import { GraphError } from "@microsoft/microsoft-graph-client";

jest.mock("../../../../src/audit/logger", () => ({ logToolCall: jest.fn() }));

import { logToolCall } from "../../../../src/audit/logger";
import { runTool } from "../../../../src/tools/shared/runTool";
import { ToolInputError } from "../../../../src/tools/shared/errors";

const mockLogToolCall = logToolCall as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

describe("runTool", () => {
  it("dispatches a RestError (ARM) to the ARM-specific classifier, not the Graph one", async () => {
    const result = await runTool("some_tool", {}, async () => {
      throw new RestError("Forbidden", { statusCode: 403 });
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/root management group/);
    expect(mockLogToolCall).toHaveBeenCalledWith(expect.objectContaining({ status: "error", errorMessage: expect.stringMatching(/root management group/) }));
  });

  it("still dispatches a GraphError to the Graph classifier, unaffected by the new ARM branch", async () => {
    const result = await runTool("some_tool", {}, async () => {
      throw new GraphError(403, "Forbidden");
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/Graph denied this request/);
  });

  it("still logs a validation_error for ToolInputError, unaffected by the new ARM branch", async () => {
    const result = await runTool("some_tool", {}, async () => {
      throw new ToolInputError("bad input");
    });

    expect(result.isError).toBe(true);
    expect(mockLogToolCall).toHaveBeenCalledWith(expect.objectContaining({ status: "validation_error" }));
  });

  it("logs the internal detail but returns a generic message to the caller for a bare Error", async () => {
    // Regression test for the err.message passthrough fix: a bare Error (not
    // a GraphError/RestError) can carry internal config detail - the caller
    // must only ever see the generic message, while the audit log still
    // gets the real one so a hosted deployment stays diagnosable.
    const result = await runTool("some_tool", {}, async () => {
      throw new Error("Missing env var \"AZURE_CLIENT_SECRET\" for tenant aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toBe("An internal error occurred while handling this request.");
    expect(text).not.toMatch(/AZURE_CLIENT_SECRET/);
    expect(mockLogToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ status: "error", errorMessage: expect.stringMatching(/AZURE_CLIENT_SECRET/) }),
    );
  });

  it("returns a success result and logs status success on the happy path", async () => {
    const result = await runTool("some_tool", {}, async () => ({ ok: true }));

    expect(result.isError).toBeUndefined();
    expect(mockLogToolCall).toHaveBeenCalledWith(expect.objectContaining({ status: "success" }));
  });
});
