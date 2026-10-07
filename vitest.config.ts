import { randomBytes } from "node:crypto";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration files replace the Worker-global fetch implementation. The
    // Cloudflare pool can share an isolate across files, so serialize files to
    // prevent one fixture from consuming another fixture's subrequests.
    fileParallelism: false,
    testTimeout: 30_000,
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // The bundled local workerd currently supports dates through 2026-08-15.
      // Production still uses the specification-mandated date in wrangler.jsonc.
      miniflare: {
        compatibilityDate: "2026-08-15",
        // Integration requests read these same test-only bindings through
        // cloudflare:workers. Never require a developer's .dev.vars credentials.
        bindings: {
          MCP_API_TOKEN: randomBytes(32).toString("base64url"),
          URL_SIGNING_SECRET: randomBytes(32).toString("base64url"),
          MCP_AUTH_MODE: "token",
        },
      },
    }),
  ],
});
