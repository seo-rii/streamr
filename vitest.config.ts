import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Starting several isolated workerd pools can exceed Vitest's 5s default
    // on shared CI hosts even when each request itself completes immediately.
    testTimeout: 15_000,
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // The bundled local workerd currently supports dates through 2026-08-15.
      // Production still uses the specification-mandated date in wrangler.jsonc.
      miniflare: { compatibilityDate: "2026-08-15" },
    }),
  ],
});
