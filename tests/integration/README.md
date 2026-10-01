# Integration tests

These tests hit your real tenant(s) over Microsoft Graph.
They never run as part of `npm test` - only via `npm run test:integration`,
and only once `.env` is populated with real credentials.

Convention: gate every test file in this folder behind an explicit env
flag, e.g.:

```ts
const runIfEnabled = process.env.RUN_INTEGRATION_TESTS === "true" ? describe : describe.skip;

runIfEnabled("get_role_assignments (integration)", () => {
  // ...
});
```

No test file here should run unconditionally.
