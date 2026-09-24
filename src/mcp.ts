import { PlanifyError, type Planify } from './planify'
import { TOOLS, ToolError } from './tools'

// The Model Context Protocol over plain HTTP: one JSON-RPC message per POST,
// one JSON answer. No session, no event stream, nothing held open between
// requests — the Worker does its work and ends, so an agent connected all day
// costs nothing while it is quiet.
//
// Written by hand rather than with the SDK: the part of the protocol a
// stateless tool server needs is this file, and the Worker stays small.

/** Newest first. An agent asking for another is answered with the newest. */
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

/**
 * Tool calls a day, across every agent. Each reads the roadmap in planify's
 * database, and an agent stuck in a loop would otherwise spend the database's
 * daily reads — the app's too.
 */
export const MCP_DAILY_CALLS = 2000

const INSTRUCTIONS = `Planify is a study roadmap: items with planned dates in phases, dependencies, pauses and a weekly hours capacity. Dates are recomputed from the plan and from progress.
Read with get_roadmap first, then list_items. Every write takes the revision the last read answered and is refused if the roadmap changed since: read again and retry.
Dry-run every write first (dryRun: true) and check introducedErrors: a write that brings in an error is refused. Warnings never block.
For a change of several steps, start_draft, make them with draft: true, then publish_draft — dry run first, then with the live revision it answers.
Progress (ticking items off, hours) is the person's, and is not changed here.`

type Message = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown }

/** Answers one MCP request. Access has already let it through. */
export async function handleMcp(
  request: Request,
  db: D1Database,
  planify: Planify,
  now: Date = new Date(),
): Promise<Response> {
  if (request.method !== 'POST') {
    // No event stream to open, and no session to end.
    return Response.json(
      { error: 'This MCP server answers POST only' },
      { status: 405, headers: { Allow: 'POST' } },
    )
  }
  const origin = request.headers.get('Origin')
  if (origin !== null && !sameHost(origin, request.url)) {
    return Response.json({ error: 'Cross-origin requests are refused' }, { status: 403 })
  }

  let message: Message
  try {
    message = (await request.json()) as Message
  } catch {
    return rpcError(null, -32700, 'The body is not JSON', 400)
  }
  if (Array.isArray(message)) {
    return rpcError(null, -32600, 'Batches are not supported; send one message per request', 400)
  }
  if (typeof message !== 'object' || message === null || message.jsonrpc !== '2.0') {
    return rpcError(null, -32600, 'Not a JSON-RPC 2.0 message', 400)
  }

  // A notification, or an answer to a request this server never sends: nothing to say back.
  if (message.id === undefined || typeof message.method !== 'string') {
    return new Response(null, { status: 202 })
  }
  const id = message.id
  if (typeof id !== 'string' && typeof id !== 'number') {
    return rpcError(null, -32600, 'The id must be a string or a number', 400)
  }
  const params = (
    typeof message.params === 'object' && message.params !== null ? message.params : {}
  ) as Record<string, unknown>

  switch (message.method) {
    case 'initialize': {
      const asked = params.protocolVersion
      return result(id, {
        protocolVersion:
          typeof asked === 'string' && PROTOCOL_VERSIONS.includes(asked)
            ? asked
            : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'planify', title: 'Planify', version: '0.1.0' },
        instructions: INSTRUCTIONS,
      })
    }
    case 'ping':
      return result(id, {})
    case 'tools/list':
      return result(id, { tools: TOOLS.map(({ run: _run, ...tool }) => tool) })
    case 'tools/call':
      return callTool(id, params, db, planify, now)
    default:
      return rpcError(id, -32601, `No such method: ${message.method}`)
  }
}

async function callTool(
  id: string | number,
  params: Record<string, unknown>,
  db: D1Database,
  planify: Planify,
  now: Date,
): Promise<Response> {
  const tool = TOOLS.find((each) => each.name === params.name)
  if (!tool) return rpcError(id, -32602, `No such tool: ${String(params.name)}`)
  const args = params.arguments ?? {}
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return rpcError(id, -32602, 'arguments must be an object')
  }

  const calls = await countCall(db, now)
  if (calls > MCP_DAILY_CALLS) {
    return toolResult(
      id,
      `The roadmap takes ${MCP_DAILY_CALLS} tool calls a day, and today's are used up. It starts again at 00:00 UTC.`,
      true,
    )
  }

  try {
    return toolResult(id, JSON.stringify(await tool.run(args as Record<string, unknown>, planify)))
  } catch (error) {
    return toolResult(id, refusalOf(error), true)
  }
}

/** Counts a call against today's, and answers how many there have been. */
async function countCall(db: D1Database, now: Date): Promise<number> {
  const day = now.toISOString().slice(0, 10)
  const row = await db
    .prepare(
      `INSERT INTO mcp_usage (id, day, calls) VALUES (1, ?, 1)
       ON CONFLICT(id) DO UPDATE SET
         calls = CASE WHEN day = excluded.day THEN calls + 1 ELSE 1 END,
         day = excluded.day
       RETURNING calls`,
    )
    .bind(day)
    .first<{ calls: number }>()
  return row?.calls ?? 1
}

/**
 * What the agent reads when a call is refused. A refusal is part of the
 * conversation — the agent reads it and tries again — so it is a result flagged
 * as an error, not a protocol error.
 */
function refusalOf(error: unknown): string {
  if (error instanceof ToolError) return error.message
  if (!(error instanceof PlanifyError)) {
    return `It failed: ${error instanceof Error ? error.message : String(error)}`
  }
  const { status, body, message } = error
  if (status === 409) {
    // planify's wording tells a person the screen reloaded; an agent needs the revision.
    const revision = (body.state as { revision?: unknown } | undefined)?.revision
    return message.startsWith('The roadmap changed since this copy') && typeof revision === 'number'
      ? `It was made from an old revision; it is now at revision ${revision}. Read it again and retry.`
      : message
  }
  if (status === 422 && Array.isArray(body.issues)) {
    return JSON.stringify({
      refused: 'It would bring in errors the roadmap does not have',
      errors: (body.issues as Array<{ rule: string; message: string }>).map((issue) => ({
        rule: issue.rule,
        message: issue.message,
      })),
    })
  }
  if (status === 400 || status === 404) return message
  return `planify could not do it (HTTP ${status}): ${message}`
}

function toolResult(id: string | number, text: string, isError = false): Response {
  return result(id, { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) })
}

function result(id: string | number, value: unknown): Response {
  return Response.json({ jsonrpc: '2.0', id, result: value })
}

function rpcError(
  id: string | number | null,
  code: number,
  message: string,
  status = 200,
): Response {
  return Response.json({ jsonrpc: '2.0', id, error: { code, message } }, { status })
}

function sameHost(origin: string, url: string): boolean {
  try {
    return new URL(origin).host === new URL(url).host
  } catch {
    return false
  }
}
