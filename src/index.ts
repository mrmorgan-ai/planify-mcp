import { authenticate, type AccessEnv } from './access'
import { handleMcp } from './mcp'
import { planifyClient, type PlanifyEnv } from './planify'

export type Env = AccessEnv & PlanifyEnv & { DB: D1Database }

/**
 * Planify's roadmap as an MCP server, at /mcp. Signed in by Cloudflare Access
 * — a person, or a service token — and speaking to planify with a service token
 * of its own, on behalf of whoever signed in: each reaches their own roadmap.
 */
export default {
  async fetch(request, env): Promise<Response> {
    if (new URL(request.url).pathname !== '/mcp') {
      return Response.json({ error: 'The MCP server is at /mcp' }, { status: 404 })
    }
    const caller = await authenticate(request, env)
    if (caller instanceof Response) return caller
    return handleMcp(request, env.DB, planifyClient(env, caller.principal), caller.principal)
  },
} satisfies ExportedHandler<Env>
