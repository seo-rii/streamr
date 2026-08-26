import { routeRequest } from "./routes";

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    return routeRequest(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
