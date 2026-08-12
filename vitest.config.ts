import { defineConfig } from "vitest/config";

export default defineConfig({
  define: { __SIPJS_REF__: JSON.stringify("test") },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node"
  }
});
