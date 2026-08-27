import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  define: {
    RUN_STREAMR_STRESS_FROM_HOST: JSON.stringify(process.env.RUN_STREAMR_STRESS ?? "0"),
  },
  test: {
    testTimeout: 120_000,
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { compatibilityDate: "2026-08-15" },
    }),
  ],
});
