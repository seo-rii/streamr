# streamr

`streamr` is a stateless, bounded-memory HTTP stream gateway and MCP server for Cloudflare Workers. It downloads one HTTP/HTTPS source per operation, optionally scans an archive in source order, applies predefined streaming transforms, and either returns the result or uploads entries to HTTP targets.

Version 0.2 intentionally has no R2, KV, D1, Durable Objects, Queues, Containers, cache, job state, or cross-request session state.

## Development

Requirements: Node.js 24 or newer and a Cloudflare Workers account.

```sh
npm install
cp .dev.vars.example .dev.vars
npm test
npm run dev
```

Set production secrets without adding them to configuration or source control:

```sh
npx wrangler secret put MCP_API_TOKEN
npx wrangler secret put URL_SIGNING_SECRET
```

The public liveness endpoint is `GET /healthz`. Authenticated API and MCP routes are documented as they are implemented.

