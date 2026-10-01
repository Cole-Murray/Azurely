import { withCallerContext, getCallerContext, CallerContext } from "../../../src/audit/callerContext";

function makeContext(overrides: Partial<CallerContext> = {}): CallerContext {
  return {
    actor: "user-oid-1",
    actorSource: "oauth:oid",
    requestId: "req-1",
    ...overrides,
  };
}

describe("callerContext", () => {
  it("returns undefined outside any withCallerContext call", () => {
    expect(getCallerContext()).toBeUndefined();
  });

  it("makes the context available synchronously inside withCallerContext", () => {
    const ctx = makeContext();
    withCallerContext(ctx, () => {
      expect(getCallerContext()).toEqual(ctx);
    });
  });

  it("exposes actor/actorSource/actorUpn/requestId set on the context", () => {
    const ctx = makeContext({
      actor: "abc-123-oid",
      actorSource: "oauth:oid",
      actorUpn: "alex@example.com",
      requestId: "req-42",
    });

    withCallerContext(ctx, () => {
      const found = getCallerContext();
      expect(found?.actor).toBe("abc-123-oid");
      expect(found?.actorSource).toBe("oauth:oid");
      expect(found?.actorUpn).toBe("alex@example.com");
      expect(found?.requestId).toBe("req-42");
    });
  });

  it("propagates across await points, matching real async tool-body usage", async () => {
    const ctx = makeContext({ actor: "async-actor", requestId: "req-async" });

    await withCallerContext(ctx, async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const found = getCallerContext();
      expect(found?.actor).toBe("async-actor");
      expect(found?.requestId).toBe("req-async");
    });
  });

  it("returns the value/promise produced by fn so callers can await it", async () => {
    const ctx = makeContext();
    const result = await withCallerContext(ctx, async () => {
      await Promise.resolve();
      return "done";
    });
    expect(result).toBe("done");
  });

  it("does not leak context between two concurrent withCallerContext calls with interleaved awaits", async () => {
    const ctxA = makeContext({ actor: "actor-a", requestId: "req-a" });
    const ctxB = makeContext({ actor: "actor-b", requestId: "req-b" });

    const observedA: string[] = [];
    const observedB: string[] = [];

    async function run(ctx: CallerContext, observed: string[]) {
      await withCallerContext(ctx, async () => {
        observed.push(getCallerContext()?.actor ?? "none");
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 5));
        observed.push(getCallerContext()?.actor ?? "none");
        await Promise.resolve();
        observed.push(getCallerContext()?.actor ?? "none");
      });
    }

    await Promise.all([run(ctxA, observedA), run(ctxB, observedB)]);

    expect(observedA).toEqual(["actor-a", "actor-a", "actor-a"]);
    expect(observedB).toEqual(["actor-b", "actor-b", "actor-b"]);
  });

  it("does not expose any context once withCallerContext has returned", async () => {
    await withCallerContext(makeContext(), async () => {
      await Promise.resolve();
    });
    expect(getCallerContext()).toBeUndefined();
  });
});
