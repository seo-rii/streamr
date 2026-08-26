export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/healthz") {
      return Response.json({ ok: true, service: "streamr", version: "0.2.0" });
    }

    return Response.json(
      {
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: "Route not found.",
          stage: "route",
          retryable: false,
        },
      },
      { status: 404 },
    );
  },
} satisfies ExportedHandler<Env>;

