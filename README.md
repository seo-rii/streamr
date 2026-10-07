# streamr

`streamr` is an open-source, stateless, bounded-memory HTTP stream gateway and MCP server for Cloudflare Workers. Version 0.2 downloads one HTTP/HTTPS source per operation, optionally scans an archive in source order, applies predefined streaming transforms, and either streams the result to the caller or uploads selected entries to HTTP targets.

Streamr's original code is [MIT-licensed](LICENSE). Bundled components and dependency patches retain their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md).

The Worker has no R2, KV, D1, Durable Objects, Queues, Containers, cache, jobs, or cross-request session state. Every `probe`, `list`, `stream`, `transfer`, or `distribute` request starts a new source download and discards all request state when it ends.

## Streaming model

- Source archives and extracted entries are never buffered in full. Payload memory consists of decoder state, bounded input batches, and bounded output queues; metadata grows with the number of listed or selected entries.
- ZIP and TAR-family archives are scanned once, in archive order. Request order never reorders the output.
- Only one archive entry and, for distribution, one target upload are active at a time. A slow client or target propagates backpressure to the entry decoder and source fetch.
- Each discovered entry is opened or skipped before the next entry advances. Once every requested entry is complete, the remaining source may be cancelled early.
- A source URL is fetched again for every operation. Calling `list_archive` and then `distribute_archive` therefore performs two independent downloads.

This is deliberately an SSRF-capable personal gateway: there is no hostname allowlist. Only trusted callers should receive the API token or a signed URL.

## Routes and authentication

| Method | Path | Authentication | Purpose |
| --- | --- | --- | --- |
| `POST` | `/mcp` | Configurable Bearer token or OAuth authorization code + PKCE | Stateless MCP Streamable HTTP endpoint |
| `POST` | `/v1/probe` | Bearer token | Fetch a bounded prefix and detect the source format |
| `POST` | `/v1/list` | Bearer token | List archive entries in archive order |
| `POST` | `/v1/stream` | Bearer token | Stream a raw source, one entry, or `multipart/mixed` |
| `GET` | `/v1/stream?p=...&e=...&s=...` | HMAC capability URL | Run a small public-source stream pipeline |
| `POST` | `/v1/transfer` | Bearer token | Send one source or one entry to one target |
| `POST` | `/v1/distribute` | Bearer token | Send archive entries sequentially to independent targets |
| `GET` | `/.well-known/oauth-protected-resource` | None | OAuth protected-resource metadata in OAuth mode |
| `GET` | `/.well-known/oauth-protected-resource/mcp` | None | Path-derived alias for OAuth metadata in OAuth mode |
| `GET` | `/.well-known/oauth-authorization-server` | None | Built-in authorization-server metadata in OAuth mode |
| `POST` | `/register` | None | Stateless dynamic OAuth client registration in OAuth mode |
| `GET`, `POST` | `/authorize` | Owner login | Authorization and consent with PKCE in OAuth mode |
| `POST` | `/token` | OAuth grant | Authorization-code exchange in OAuth mode |
| `GET` | `/healthz` | None | Liveness and version check |

`/v1/*` authentication always uses the static API token:

```http
Authorization: Bearer <MCP_API_TOKEN>
```

The MCP endpoint has two explicit authentication modes selected by `MCP_AUTH_MODE`:

- `token` is the default and compares the Bearer credential with `MCP_API_TOKEN`. It is suitable for MCP clients that can set a private custom header.
- `oauth` enables the Worker's built-in, single-owner authorization server. It publishes protected-resource and authorization-server metadata, performs dynamic client registration, requires authorization-code flow with PKCE S256, issues purpose-separated encrypted tokens, and advertises and enforces `streamr.read` or `streamr.write` per tool.

There is intentionally no unauthenticated mode. Streamr can fetch arbitrary public URLs and send bytes to arbitrary HTTP targets, so exposing its tools anonymously would create an unsafe public relay. Changing `MCP_AUTH_MODE` affects only `/mcp`; the REST control routes continue to require `MCP_API_TOKEN`, and signed `GET /v1/stream` URLs continue to use `URL_SIGNING_SECRET`.

OAuth mode does not require an external identity provider. The same Worker exposes `/register`, `/authorize`, and `/token`; the owner credentials and token-encryption secret come only from Worker environment variables. Dynamic registrations, authorization requests, codes, and access tokens are signed or encrypted self-contained artifacts, so the Worker still stores no sessions or client records.

| Variable | Required | Meaning |
| --- | --- | --- |
| `MCP_AUTH_MODE` | No | `token` (default) or `oauth` |
| `MCP_API_TOKEN` | Yes | Static Bearer token for `/v1/*`, and for `/mcp` in token mode |
| `URL_SIGNING_SECRET` | Yes | HMAC secret for signed stream URLs |
| `MCP_OAUTH_RESOURCE` | OAuth mode | Canonical public MCP URL, including `/mcp` |
| `MCP_OAUTH_SIGNING_SECRET` | OAuth mode | At least 32 random bytes used to derive purpose-separated token keys |
| `MCP_OAUTH_LOGIN_USERNAME` | OAuth mode | Single owner username shown only to the authorization form |
| `MCP_OAUTH_LOGIN_PASSWORD` | OAuth mode | Strong owner password of at least 16 UTF-8 bytes |
| `MCP_OAUTH_ALLOWED_REDIRECT_URIS` | OAuth mode | Comma-separated exact redirect URIs; use the URI shown by ChatGPT, normally `https://chatgpt.com/connector_platform_oauth_redirect` when issuer identification is enabled |
| `MCP_OAUTH_READ_SCOPES` | No | Space-separated scopes for `probe_url`, `list_archive`, and `create_stream_url`; defaults to `streamr.read` |
| `MCP_OAUTH_WRITE_SCOPES` | No | Space-separated scopes for `transfer` and `distribute_archive`; defaults to `streamr.write` |
| `MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS` | No | Access-token lifetime, 300–2592000 seconds; defaults to 43200 (12 hours) |

In OAuth mode, `MCP_OAUTH_RESOURCE` must exactly match the public request origin plus `/mcp`. The Worker uses that origin as its issuer and includes the exact issuer in authorization responses. Redirect URIs are matched exactly, including path and query. Rotate `MCP_OAUTH_SIGNING_SECRET` to invalidate every outstanding client registration, code, and access token.

### Stateless OAuth limitation

Strict OAuth authorization servers record when an authorization code is redeemed. Streamr deliberately has no database or cross-request session state, so it cannot maintain that record. A code is encrypted, bound to the exact client, redirect URI, resource, and PKCE challenge, and expires after 60 seconds, but the same client holding the verifier can redeem it again during that window.

The built-in server does not issue refresh tokens because a stateless public-client flow cannot rotate them with replay detection. ChatGPT must run authorization again after the access token expires. Use the built-in OAuth mode for a private, single-owner deployment with strong random credentials and an exact redirect-URI allowlist. If policy requires provably single-use authorization codes, long-lived refresh sessions, per-token revocation, account lifecycle, MFA, or audit history, use a stateful external authorization server instead of the built-in mode.

Access tokens can be configured for up to 30 days for private deployments that prefer fewer reauthorization prompts. A longer lifetime increases the exposure window if a token is copied; rotating `MCP_OAUTH_SIGNING_SECRET` remains the only way to invalidate issued access tokens before expiry.

Only `http:` and `https:` URLs with DNS hostnames are accepted. URL credentials, IP literals, `file:`, `data:`, FTP, and WebSocket URLs are rejected. User-supplied header names and values are checked for CR/LF injection; hop-by-hop headers and caller-supplied `Content-Length` are forbidden.

Source redirects are followed manually, up to five by default. `Authorization`, `Cookie`, and `Proxy-Authorization` are removed when the origin changes unless `forwardSensitiveHeadersAcrossHosts` is explicitly enabled. Target redirects are never followed.

## HTTP API examples

For local examples, start `npm run dev` and set:

```sh
export STREAMR_URL=http://127.0.0.1:8787
export STREAMR_TOKEN='the-value-from-.dev.vars'
```

### Probe and list

```sh
curl --fail-with-body --silent --show-error \
  -X POST "$STREAMR_URL/v1/probe" \
  -H "Authorization: Bearer $STREAMR_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"source":{"url":"https://files.example/tests.tar.xz"}}'
```

```sh
curl --fail-with-body --silent --show-error \
  -X POST "$STREAMR_URL/v1/list" \
  -H "Authorization: Bearer $STREAMR_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{
    "source":{"url":"https://files.example/tests.zip"},
    "options":{"maxEntries":50000}
  }'
```

A typical list response is:

```json
{
  "ok": true,
  "format": "zip",
  "layers": ["zip"],
  "entries": [
    {
      "index": 1,
      "path": "data/01.in",
      "occurrence": 1,
      "unsafePath": false,
      "type": "file",
      "size": 3812
    }
  ],
  "truncated": false,
  "sourceGets": 1
}
```

### Raw or single-entry stream

The following normalizes line endings while streaming one ZIP entry:

```sh
curl --fail-with-body --silent --show-error \
  -X POST "$STREAMR_URL/v1/stream" \
  -H "Authorization: Bearer $STREAMR_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{
    "source":{"url":"https://files.example/tests.zip"},
    "archive":{"entries":[{"path":"data/01.in"}]},
    "entryTransforms":[{"type":"newline","mode":"lf"}],
    "output":{
      "mode":"raw",
      "contentType":"text/plain; charset=utf-8",
      "filename":"01.in"
    }
  }' \
  --output 01.in
```

Omit `archive` to proxy the source body itself. Raw archive output requires exactly one selector; an absent entry returns HTTP 404 with `ENTRY_NOT_FOUND` before response body streaming begins.

### Multiple entries as `multipart/mixed`

```sh
curl --fail-with-body --silent --show-error \
  -X POST "$STREAMR_URL/v1/stream" \
  -H "Authorization: Bearer $STREAMR_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{
    "source":{"url":"https://files.example/tests.zip"},
    "archive":{"entries":[
      {"path":"data/02.ans"},
      {"path":"data/01.in"},
      {"path":"data/01.ans"}
    ]},
    "output":{"mode":"multipart-mixed"}
  }' \
  --output selected.mime
```

Even though `02.ans` was requested first, parts are emitted in the order in which entries occur in the archive.

### Transfer one stream

```sh
curl --fail-with-body --silent --show-error \
  -X POST "$STREAMR_URL/v1/transfer" \
  -H "Authorization: Bearer $STREAMR_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{
    "source":{"url":"https://files.example/tests.zip"},
    "archive":{"entries":[{"path":"data/01.in"}]},
    "entryTransforms":[{"type":"newline","mode":"lf"}],
    "target":{
      "url":"https://upload.example/input/01",
      "method":"PUT",
      "headers":{"Authorization":"Bearer target-token"},
      "contentType":"text/plain"
    }
  }'
```

### Distribute multiple entries

```sh
curl --fail-with-body --silent --show-error \
  -X POST "$STREAMR_URL/v1/distribute" \
  -H "Authorization: Bearer $STREAMR_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{
    "source":{"url":"https://files.example/tests.zip"},
    "routes":[
      {
        "id":"input-01",
        "path":"data/01.in",
        "target":{"url":"https://upload.example/input/01","method":"PUT"}
      },
      {
        "id":"answer-01",
        "path":"data/01.ans",
        "transforms":[{"type":"newline","mode":"lf"}],
        "target":{"url":"https://upload.example/answer/01","method":"POST"}
      }
    ],
    "failurePolicy":"abort"
  }'
```

Inspect the JSON `ok`, every route `status`, `warnings`, and `errors`; HTTP 200 does not imply that every external target succeeded.

## MCP endpoint

`POST /mcp` is a stateless Streamable HTTP endpoint. A fresh MCP server is created for each HTTP request, and MCP cancellation propagates to the active source or target. The control body is bounded at 8 MiB, and JSON-RPC batches are rejected for both modern and legacy-compatible clients so one inbound request can start at most one operation.

The server exposes exactly five tools:

| Tool | Effect |
| --- | --- |
| `probe_url` | Detect a source without retaining its contents |
| `list_archive` | Return archive metadata in archive order |
| `create_stream_url` | Create a ten-minute signed `GET /v1/stream` URL |
| `transfer` | Upload one stream; potentially mutating and non-idempotent |
| `distribute_archive` | Upload multiple entries; potentially mutating and non-idempotent |

In OAuth mode, every tool publishes a canonical `securitySchemes` declaration and the compatibility `_meta.securitySchemes` mirror. Read tools require `MCP_OAUTH_READ_SCOPES`; target-writing tools require `MCP_OAUTH_WRITE_SCOPES`. A token that is otherwise valid but lacks a required scope receives an OAuth challenge instead of starting a source or target request.

### Token-mode MCP client

Configure a non-ChatGPT MCP client with the gateway URL and the same Bearer token used by the HTTP API:

Example with the installed MCP client package:

```ts
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const gateway = process.env.STREAMR_URL!;
const token = process.env.STREAMR_TOKEN!;
const client = new Client({ name: "streamr-example", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(new URL(`${gateway}/mcp`), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});

await client.connect(transport);
const probe = await client.callTool({
  name: "probe_url",
  arguments: { source: { url: "https://files.example/tests.zip" } },
});
console.log(probe.structuredContent);
await client.close();
```

MCP results contain both a JSON text content item and the same object in `structuredContent`. Gateway failures set `isError: true` and use the structured error model.

### OAuth and ChatGPT registration

ChatGPT cannot present a custom API key to an MCP server, so a ChatGPT connection must use `MCP_AUTH_MODE=oauth`. Before registering Streamr, complete all of the following:

1. Deploy Streamr at a stable public HTTPS URL and set `MCP_OAUTH_RESOURCE` to the exact URL including `/mcp`.
2. Generate independent strong values for `MCP_OAUTH_SIGNING_SECRET` and `MCP_OAUTH_LOGIN_PASSWORD`, choose the owner username, and allow only the exact production redirect URI displayed by ChatGPT. With issuer identification enabled, the stable URI is `https://chatgpt.com/connector_platform_oauth_redirect`.
3. Confirm `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server` are publicly reachable.
4. Verify dynamic registration, the owner login form, PKCE token exchange, `tools/list` security metadata, and one read-only tool call with MCP Inspector.

In [ChatGPT Plugins](https://chatgpt.com/plugins), select the plus button and **Add custom MCP server**. Enter a name and description, choose the public endpoint connection, and enter the exact `MCP_OAUTH_RESOURCE` URL. Configure OAuth authentication, review the risk warning, and choose **Create as a plugin**. Streamr supports dynamic client registration (DCR); no manually provisioned client secret is needed. Review the five discovered tools and complete Streamr's owner login and authorization form. Install the resulting plugin and select it in a new conversation. Availability and UI labels depend on the account and workspace policy.

This connects your own deployment; publishing this source repository does not publish your Worker credentials or make its tools unauthenticated. Do not enter the REST `MCP_API_TOKEN` as the OAuth login password. After changing the MCP tool or authentication metadata, refresh the connection in ChatGPT and retest in a new conversation.

See the official OpenAI documentation for the current [MCP authentication contract](https://developers.openai.com/plugins/build/auth) and [ChatGPT connection workflow](https://developers.openai.com/plugins/deploy/connect-chatgpt).

### Create a signed stream URL with MCP

Call `create_stream_url` with a normal stream pipeline:

```json
{
  "source": { "url": "https://public.example/tests.zip" },
  "archive": {
    "entries": [
      { "path": "data/01.in" },
      { "path": "data/01.ans" }
    ]
  },
  "output": { "mode": "multipart-mixed" }
}
```

The structured result has this shape:

```json
{
  "ok": true,
  "url": "https://gateway.example/v1/stream?p=...&e=...&s=...",
  "expiresAt": "2026-08-27T00:10:00.000Z"
}
```

There is intentionally no unauthenticated REST endpoint that signs URLs. Only an authenticated MCP caller can invoke `create_stream_url`.

## Signed `GET /v1/stream` security

A signed URL is a short-lived bearer capability. Anyone who obtains it can execute its embedded pipeline until expiry.

- The signature is HMAC-SHA256 over `e + "." + p`, using `URL_SIGNING_SECRET`.
- `p` is canonical base64url-encoded JSON, `e` is a Unix expiry, and `s` is the canonical base64url signature. Missing, duplicate, or extra query parameters are rejected.
- The decoded JSON payload is limited to 8 KiB and expires after ten minutes. An expiry farther than ten minutes into the future is also rejected.
- Signed pipelines may contain only HTTP/HTTPS URLs without URL credentials or IP literals.
- **All custom `headers` are forbidden in a signed payload**, including nonstandard API-key headers. Use authenticated `POST /v1/stream` whenever a source requires headers.
- Signed stream pipelines cannot perform target uploads; they use the stream request schema only.
- Query strings can appear in browser history, proxy logs, screenshots, and copied links. Successful stream responses set `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, and `Cache-Control: no-store`, but callers must still avoid private source URLs or other secrets in the payload and must not share the capability URL.
- Rotating `URL_SIGNING_SECRET` invalidates all outstanding URLs. Use a separate high-entropy value from `MCP_API_TOKEN`.

The signature authenticates the pipeline, not the bytes returned by the source. Use TLS and an application-level digest when source integrity matters.

## Archive behavior

| Input | Listing and extraction behavior |
| --- | --- |
| Raw file | Proxied directly; it is not an archive |
| ZIP | Streaming local-entry parsing; stored (method 0) and deflate (method 8) |
| TAR | USTAR, PAX paths, and GNU long paths; sequential 512-byte records |
| GZIP | One decompressed virtual file named `@payload` |
| BZIP2 | One decompressed virtual file named `@payload` |
| XZ | One decompressed virtual file named `@payload` |
| ZSTD | One decompressed virtual file named `@payload` |
| TAR.GZ / TAR.BZ2 / TAR.XZ / TAR.ZST | Outer compression is decoded, then TAR is scanned |
| 7z / RAR | Rejected with `UNSUPPORTED_FORMAT` |
| Encrypted ZIP | Rejected with `ARCHIVE_ENCRYPTED` |

When a ZIP operation reaches EOF, the gateway validates every central-directory record against the EOCD/ZIP64 offset, size, count, and trailer layout without retaining the directory payload. This catches truncated or contradictory directories, including directories larger than the retained 132 KiB validation tail. An intentional early single- or multi-entry stop does not claim that EOF validation ran.

Bare GZIP, BZIP2, XZ, and ZSTD streams are exposed to archive operations as a single entry:

```json
{
  "index": 1,
  "path": "@payload",
  "occurrence": 1,
  "type": "file",
  "size": null
}
```

Its decompressed size is unknown and may be omitted from list metadata. Select `{ "path": "@payload" }` to stream or transfer the decompressed bytes. If `archive` is omitted, the original compressed source body is proxied unchanged. The `decompress` entry transform can also decode one explicitly selected compression layer; it does not recursively browse an archive inside an entry.

Automatic nesting is limited to one compression layer followed by TAR. A ZIP entry containing `tar.gz`, for example, is not recursively opened in the same request.

Paths are normalized (`\` to `/`, leading `./` removed, repeated separators collapsed) and matched by exact full path. There is no basename search, glob, regex, case folding, random access, or request-order sorting. Duplicate paths use one-based `occurrence`; the default is 1. Directories, symlinks, and hardlinks can be listed but not extracted as file bodies. Unsafe absolute, drive, UNC, and parent-relative paths are marked in list metadata; the gateway never writes them to a filesystem.

A raw single-entry response sets `X-Stream-Gateway-Integrity-Scope: selected-entry`. It validates the selected entry as it is decoded, then may cancel the unread archive tail; it therefore does not claim whole-archive integrity. Operations that reach archive EOF perform the format's terminal validation.

## Multipart completion contract

Multiple selected files are returned as `multipart/mixed` with a cryptographically random `sgw_...` boundary. Every file part includes `Content-Type`, RFC 5987 `Content-Disposition`, `X-Archive-Path`, `X-Archive-Index`, and selector path/occurrence/required headers; `X-Stream-Gateway-Selector-Id` is included when the selector supplied an id.

The **last part must be the manifest**:

```http
Content-Type: application/json
Content-Disposition: inline; filename="__stream_gateway_manifest__.json"
X-Stream-Gateway-Control: manifest
```

```json
{
  "ok": false,
  "requested": 4,
  "emitted": 3,
  "missing": ["data/02.ans"],
  "errors": [],
  "selectors": [
    {
      "id": "answer-02",
      "path": "data/02.ans",
      "occurrence": 1,
      "required": true,
      "status": "missing"
    }
  ],
  "archive": {
    "fullyScanned": true,
    "stoppedEarly": false,
    "integrityScope": "full-archive"
  }
}
```

Consumers must parse through the final boundary, locate the part with `X-Stream-Gateway-Control: manifest`, and inspect `ok`, `selectors`, `archive`, `missing`, and `errors` before accepting the result. Selector results preserve request identity and distinguish `emitted`, `failed`, `missing`, and `unresolved`. `archive.integrityScope` distinguishes a validated full archive from an intentional selected-entry early stop and a partial archive failure. `ok: true` means every required selector completed; an optional selector can still appear in `missing`. HTTP 200 alone is not success: a later entry may be missing or the archive may fail after earlier file parts have already been sent. If the connection ends before a valid manifest and closing boundary, treat the multipart result as incomplete. When no selected entry is found, the response contains only a manifest; it fails when any missing selector was required.

## Distribution semantics

`/v1/distribute` downloads the archive once and starts target requests sequentially as matching entries arrive. Route order does not change archive order. The same normalized path and occurrence cannot be routed more than once; v0.2 does not fan one entry out to several targets.

Distribution is **not atomic**:

- A successful target request remains successful if a later target fails.
- The gateway does not roll back, compensate, stage, or commit external writes.
- Target requests are never retried automatically.
- Target redirects use `redirect: "manual"`; every 3xx becomes `TARGET_REDIRECT`.
- The default accepted statuses are 200 through 208. Other statuses become `TARGET_STATUS_REJECTED` unless `successStatus` is overridden.
- `POST`, `PUT`, and `PATCH` are supported. The caller cannot set `Content-Length`; `requireContentLength: true` fails with `CONTENT_LENGTH_UNKNOWN` when streaming transforms make the length unknown.
- Textual target response bodies are captured up to 64 KiB per target by default. Binary bodies are cancelled rather than buffered. A distribution additionally has a bounded aggregate response-capture budget.
- Successful uploads are reported only after both the complete request body and target response have settled. Failure details include `bytesWritten` and `requestBodyState`; these report gateway-side stream progress, not a transactional acknowledgment by the target application.

With `failurePolicy: "abort"` (the default), the source is cancelled after the first failed route and unresolved routes are reported as `not-run`. With `"continue"`, the remainder of the failed entry is drained or discarded before archive scanning proceeds. Required failures or misses make the final `ok` false; optional misses and failures appear in `warnings`. The result's `archiveFullyScanned` and `integrityScope` fields state whether EOF validation ran, all successful selected entries were consumed before an early stop, or only a partial archive was examined.

If all-or-nothing behavior is required, the target service must provide its own transaction, staging, idempotency-key, commit, rollback, or batch-upload API.

## Transforms

Entry transforms run in order and are applied independently to each selected file. Distribution routes can define different transform lists. Final transforms apply after a raw result or the complete multipart envelope has been produced.

| Transform | Notes |
| --- | --- |
| `decompress` | `auto`, `gzip`, `bzip2`, `xz`, or `zstd`; one stream layer |
| `newline` | Strict UTF-8 LF/CRLF normalization across chunk boundaries |
| `replace` | Strict UTF-8 literal replacement across chunk boundaries; no regex |
| `prepend`, `append` | UTF-8 or base64 bytes, up to 64 KiB each |
| `slice` | Byte offset and optional byte length |
| `limit` | Aborts once `maxBytes` is exceeded |
| `gzip` | GZIP-encodes the current entry or final stream |
| `multipart-form-data` | Wraps one target upload; must be the final route/transfer entry transform |

Only `limit` and `gzip` are valid final transforms for a raw result. A `multipart/mixed` result permits only final `gzip`: a caller-supplied final byte limit is rejected before source fetch because it could prevent the mandatory manifest from being emitted. Text transforms are never applied to an already encoded multipart envelope. Invalid UTF-8 is an error; arbitrary JavaScript, regex replacement, ZIP/TAR repackaging, and arbitrary code execution are not supported.

## Default limits and bounded-memory ceilings

| Limit | Default or ceiling |
| --- | --- |
| Source redirects | 5 |
| Source / target timeout | 300 seconds each |
| Automatic archive depth | 2 layers |
| List entries | 50,000 |
| Selected entries / distribution routes | 10,000 each |
| Active archive entries / target uploads | 1 each |
| Archive path | 4,096 UTF-8 bytes |
| Control-plane JSON body | 8 MiB |
| Entry output / total request output | 4 GiB / 16 GiB |
| Entry or final transform list | 16 transforms; multipart common entry + final total is also 16 |
| Prepend / append / replace search | 64 KiB each |
| Target response capture | 64 KiB per target by default; 2 MiB aggregate for distribution |
| Signed payload / lifetime | 8 KiB / 10 minutes |
| Supplied headers | 128 headers; 16 KiB per value |
| List, multipart selector, or distribution metadata | 16 MiB per operation |
| ZIP input batch / callback burst / validation tail | 4 KiB / 8 MiB / 132 KiB |
| BZIP2 input batch / decoder block | 4 KiB / at most 900 KiB |
| ZSTD input batch / callback queue / window | 4 KiB / 8 MiB / 16 MiB |
| XZ decoder memory | 32 MiB |

These are gateway ceilings, not guarantees that every Cloudflare plan or upstream permits a transfer of that size or duration. The Worker config requests 300,000 ms CPU time and 20,000 subrequests and therefore requires a paid Workers Standard usage model; account-level limits and the platform's 128 MiB isolate ceiling still apply.

The bundled streaming ZSTD decoder validates an optional frame content checksum and rejects windows above 16 MiB. A transport- or application-level trusted digest is still recommended when end-to-end source integrity matters.

## Errors and observability

Control-plane failures use a structured body:

```json
{
  "ok": false,
  "requestId": "req_...",
  "error": {
    "code": "ENTRY_NOT_FOUND",
    "message": "Archive entry was not found.",
    "stage": "archive-select",
    "retryable": false,
    "details": { "path": "data/01.in", "occurrence": 1 }
  }
}
```

Typical status classes are 400 for input/transform errors, 401 for Bearer authentication, 403 for signed URLs, 404 for a missing single entry, 413 for limits, 415 for unsupported formats, 422 for corrupt archives, 502 for source/target failures, and 504 for timeouts.

Requests receive a random `requestId` and emit structured logs. Do not add source or target bodies, response bodies, authorization headers, cookies, signed payloads, or complete query strings to logging. Watch a deployment with:

```sh
npx wrangler tail
```

## Local development and tests

Requirements:

- Node.js 24.11 or newer (the locked tooling requires at least 24.11 on Node 24)
- npm
- A Cloudflare account only for deployment

Install dependencies and create local-only secrets:

```sh
npm ci
cp .dev.vars.example .dev.vars
```

Replace both active secret placeholders in `.dev.vars` with different high-entropy random values. The example defaults to token-mode MCP authentication; `.dev.vars` is ignored by Git and must never be committed. Dependency installation applies the checked-in patches and reproducibly extracts the pinned XZ WASM module, so do not disable npm install scripts.

Run the default validation suite (generated types, TypeScript, lint, and Vitest):

```sh
npm run check
```

This command does not run the standalone Chromium OAuth regression or the two opt-in 1 GiB stress cases. Those checks are described separately below.

Worker secret types are maintained in `src/env.d.ts` and `src/oauth.ts`;
`worker-configuration.d.ts` contains only generated Workers runtime types.
Use `npm run types` after updating Wrangler or the compatibility settings.
Type checks do not depend on `.dev.vars`, so they also run in a clean checkout
without deployment credentials.
The Vitest configuration supplies fresh, test-only authentication and signing
bindings for integration requests; tests never require your real API token.

Useful narrower commands are:

```sh
npm run check:types
npm run lint
npm run test:unit
npm run test:integration
npm test
npx wrangler deploy --dry-run
```

OAuth login also needs a real-browser check: HTTP-only tests do not enforce
the login page's CSP on a form's redirect to an external callback. On Linux or
macOS with Python 3.12 or newer, install Python Playwright and Chromium in an isolated environment,
then run the self-contained local check:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install playwright==1.61.0
.venv/bin/python -m playwright install chromium
.venv/bin/python scripts/ci-oauth-browser.py
```

On a minimal Linux machine, Playwright's `install --with-deps chromium` command
also installs the browser's system dependencies and may require administrator
access. The runner starts an isolated HTTPS Worker with random, temporary test
credentials; it does not read the repository's `.dev.vars` or production secrets.
Use `--port 8788` if the runner's default port, 8787, is already in use. Temporary
credentials are removed on exit; private diagnostic logs remain in `~/logs`.

To test an already running OAuth-mode Worker instead, export its
`MCP_OAUTH_RESOURCE`, `MCP_OAUTH_LOGIN_USERNAME`, `MCP_OAUTH_LOGIN_PASSWORD`, and
`MCP_OAUTH_ALLOWED_REDIRECT_URIS`, plus any non-default scope or token-TTL variables,
then run:

```sh
.venv/bin/python test/browser/oauth_login.py
```

This check covers immediate success and a wrong-password retry using native
form submissions, PKCE token exchange, and MCP authentication. It intercepts
the external callback locally, so it does not reconnect the actual ChatGPT
account. Credentials, authorization codes, and tokens are never printed.

Run the opt-in 1 GiB raw and target-transfer backpressure qualification with:

```sh
RUN_STREAMR_STRESS=1 npx vitest run \
  --config test/stress/vitest.config.ts \
  test/stress/bounded-streaming.test.ts
```

The automated suite covers route authentication, signed URLs, stream transforms, ZIP/TAR and compression adapters, multipart manifests, sequential distribution, cancellation, target edge cases, bounded decoder behavior, a default 200-entry/200-target case, and the opt-in synthetic 1 GiB raw/transfer cases. The synthetic tests validate pull/backpressure bounds without allocating a 1 GiB fixture. Before relying on production-scale workloads, also test controlled network source and sink services on the intended Workers plan while observing memory, CPU, wall-time, disconnect, and timeout behavior.

### GitHub Actions

[CI](https://github.com/seo-rii/streamr/actions/workflows/ci.yml) runs on pushes to
`main` and pull requests. It installs the locked dependencies with `npm ci`, runs
`npm run check`, verifies that XZ WASM regeneration leaves the checked-in binary
unchanged, checks Worker packaging with `wrangler deploy --dry-run`, and runs the
isolated Chromium OAuth regression. Actions are pinned to commit hashes and have
read-only repository permissions. No Cloudflare token or production secret is
required, and the workflow never deploys a Worker.

To run the additional 1 GiB tests in GitHub, select **Actions → CI → Run workflow**
and enable the stress-test input. These synthetic checks cover backpressure and
bounded queues; they are not a production Workers load test.

### Local token-mode server

Start a token-mode local Worker over HTTP:

```sh
npm run dev
```

### Local OAuth over HTTPS

OAuth mode requires HTTPS even on localhost. In `.dev.vars`, set `MCP_AUTH_MODE=oauth`, uncomment the OAuth variables, replace the signing-secret and login-password placeholders with independent random values, and use this resource URL:

```dotenv
MCP_OAUTH_RESOURCE=https://localhost:8787/mcp
```

Start the local HTTPS listener explicitly:

```sh
npm run dev -- --local-protocol https --ip localhost --port 8787
```

Use that exact hostname and port for every OAuth request; `127.0.0.1` is a different origin. Wrangler supplies a local development certificate. The browser regression accepts a self-signed certificate only for loopback hosts; do not disable certificate validation against deployed Workers. Export the same OAuth values to the test process without printing or committing them. A local callback used by the regression is intercepted inside Chromium, so the test does not contact or reconnect a real ChatGPT account.

ChatGPT cannot reach this localhost listener directly. Register a deployed public HTTPS endpoint using the [ChatGPT setup](#oauth-and-chatgpt-registration) above.

## Deploy to Cloudflare Workers

The deployment is one Worker named `stateless-stream-gateway-mcp` and has no storage or service bindings.

1. Authenticate Wrangler and verify the account:

   ```sh
   npx wrangler login
   npx wrangler whoami
   ```

2. Validate and deploy the code:

   ```sh
   npm run check
   npx wrangler deploy --dry-run
   npm run deploy
   ```

3. Create two different production secrets interactively. Do not paste them into `wrangler.jsonc`, shell history, source files, or Git:

   ```sh
   npx wrangler secret put MCP_API_TOKEN
   npx wrangler secret put URL_SIGNING_SECRET
   npx wrangler secret list
   ```

   Updating either secret creates a new Worker version; normal later deployments preserve existing secrets.

   Token mode is the default and needs no additional variables. For OAuth mode, store **each** deployment-specific setting as a Worker secret, including non-sensitive settings, so later `wrangler deploy` commands preserve them:

   ```sh
   npx wrangler secret put MCP_AUTH_MODE
   npx wrangler secret put MCP_OAUTH_RESOURCE
   npx wrangler secret put MCP_OAUTH_SIGNING_SECRET
   npx wrangler secret put MCP_OAUTH_LOGIN_USERNAME
   npx wrangler secret put MCP_OAUTH_LOGIN_PASSWORD
   npx wrangler secret put MCP_OAUTH_ALLOWED_REDIRECT_URIS
   ```

   At the prompts, enter `oauth`, the exact deployed HTTPS URL including `/mcp`, an independent random signing secret, your chosen owner username and strong password, and the comma-separated exact callback URI allowlist. Do not reuse the REST API token as an OAuth secret or password. No external identity-provider account is required.

   Optional overrides use the same mechanism:

   ```sh
   npx wrangler secret put MCP_OAUTH_READ_SCOPES
   npx wrangler secret put MCP_OAUTH_WRITE_SCOPES
   npx wrangler secret put MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS
   ```

   Omit these overrides to keep `streamr.read`, `streamr.write`, and the 12-hour lifetime. For a private deployment that intentionally accepts the longer token-exposure window, `2592000` sets a 30-day lifetime. There are no refresh tokens; authorization is required again after expiry.

   These settings are intentionally absent from `wrangler.jsonc`. In the Cloudflare dashboard, use type **Secret**, not a plaintext variable, for the setup above. If you deliberately manage non-sensitive settings as ordinary dashboard variables instead, use `npm run deploy -- --keep-vars` on every deploy or explicitly configure `keep_vars`; Wrangler otherwise replaces dashboard variables from local configuration. Passwords and signing keys must remain secrets. See Cloudflare's [deployment flag documentation](https://developers.cloudflare.com/workers/wrangler/commands/workers/) and [secret configuration](https://developers.cloudflare.com/workers/configuration/secrets/).

4. Record the HTTPS URL printed by Wrangler and run smoke checks:

   ```sh
   export STREAMR_URL='https://stateless-stream-gateway-mcp.<account>.workers.dev'
   export STREAMR_TOKEN='the-production-MCP_API_TOKEN'
   export STREAMR_SOURCE_URL='https://public.example/small-test.zip'

   curl --fail-with-body --silent --show-error "$STREAMR_URL/healthz"

   curl --fail-with-body --silent --show-error \
     -X POST "$STREAMR_URL/v1/probe" \
     -H "Authorization: Bearer $STREAMR_TOKEN" \
     -H 'Content-Type: application/json' \
     --data "{\"source\":{\"url\":\"$STREAMR_SOURCE_URL\"}}"

   curl --fail-with-body --silent --show-error \
     -X POST "$STREAMR_URL/v1/stream" \
     -H "Authorization: Bearer $STREAMR_TOKEN" \
     -H 'Content-Type: application/json' \
     --data "{\"source\":{\"url\":\"$STREAMR_SOURCE_URL\"},\"output\":{\"mode\":\"raw\"}}" \
     --output /dev/null

   curl --silent --output /dev/null --write-out '%{http_code}\n' \
     -X POST "$STREAMR_URL/v1/probe" \
     -H 'Content-Type: application/json' \
     --data "{\"source\":{\"url\":\"$STREAMR_SOURCE_URL\"}}"
   ```

   The final command must print `401`. Confirm from the controlled source or Worker trace that authentication rejection occurred before a source fetch.

5. In token mode, connect an MCP client or MCP Inspector to `$STREAMR_URL/mcp` using Streamable HTTP and the custom header `Authorization: Bearer <token>`. In OAuth mode, use MCP Inspector's OAuth flow and verify metadata discovery, PKCE login, code exchange, and scope enforcement before registering ChatGPT. Invoke `probe_url`, then invoke `create_stream_url` for a small public source and fetch the returned URL before its ten-minute expiry.

For a transfer/distribution smoke test, use a dedicated disposable target endpoint. External writes are non-atomic and are not rolled back or retried by the gateway.

## License

Streamr's original code is available under the [MIT License](LICENSE).
Third-party code, the bundled XZ WASM module, and modified dependencies retain
their respective licenses. Attribution, exact versions, local modifications, and
redistributed license texts are documented in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
and [LICENSES](LICENSES/). The `private: true` package setting prevents accidental
npm publication; it does not restrict use under the license or the visibility
of this GitHub repository.
