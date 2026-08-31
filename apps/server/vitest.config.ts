import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Scoped to this project's own tests, rather than vitest's default project-wide glob.
    // Without this, anything matching *.spec.js/*.test.ts anywhere under the package -- notably
    // data/usage-profile/ (a real Chrome profile, holding whatever extensions' own bundled
    // test files happen to ship inside their installed source, once the live-usage-tracking
    // browser profile lives there) -- gets picked up as if it were part of this suite.
    include: ["test/**/*.test.ts"],
  },
});
