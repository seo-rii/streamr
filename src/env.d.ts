import type { McpAuthEnvironment } from "./oauth";

// Deployment-specific secrets are not discoverable from the public Wrangler
// configuration. Keep their type contract independent of local .dev.vars files.
interface StreamrEnvironment extends McpAuthEnvironment {
  MCP_API_TOKEN: string;
  URL_SIGNING_SECRET: string;
}

declare global {
  interface Env extends StreamrEnvironment {}

  namespace Cloudflare {
    interface GlobalProps {
      mainModule: typeof import("./index");
    }
    interface Env extends StreamrEnvironment {}
  }

  namespace NodeJS {
    interface ProcessEnv extends StreamrEnvironment {}
  }
}
