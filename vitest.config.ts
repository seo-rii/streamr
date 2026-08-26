import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // The bundled local workerd currently supports dates through 2026-08-15.
      // Production still uses the specification-mandated date in wrangler.jsonc.
      miniflare: { compatibilityDate: "2026-08-15" },
    }),
  ],
});
