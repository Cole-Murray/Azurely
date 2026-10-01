/** @type {import('jest').Config} */
const transform = {
  "^.+\\.tsx?$": ["ts-jest", { tsconfig: "tsconfig.jest.json" }],
};

module.exports = {
  projects: [
    {
      displayName: "unit",
      testEnvironment: "node",
      testMatch: ["<rootDir>/tests/unit/**/*.test.ts"],
      transform,
    },
    {
      // Hits the real tenant - only runs via `npm run test:integration`,
      // never as part of the default `npm test`.
      displayName: "integration",
      testEnvironment: "node",
      testMatch: ["<rootDir>/tests/integration/**/*.test.ts"],
      transform,
    },
  ],
};
