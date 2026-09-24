import { authorize, type AccessEnv } from './access'
import { handleMcp } from './mcp'
import { planifyClient, type PlanifyEnv } from './planify'

export type Env = AccessEnv & PlanifyEnv & { DB: D1Database }

/**
 * Planify's roadmap as an MCP server, at /mcp. Signed in by Cloudflare Access
 * — a person, or a service token — and speaking to planify with a service token
 * of its own.
 */
export default {
  async fetch(request, env): Promise<Response> {
    if (new URL(request.url).pathname !== '/mcp') {
      return Response.json({ error: 'The MCP server is at /mcp' }, { status: 404 })
    }
    return (await authorize(request, env)) ?? handleMcp(request, env.DB, planifyClient(env))
  },
} satisfies ExportedHandler<Env>
