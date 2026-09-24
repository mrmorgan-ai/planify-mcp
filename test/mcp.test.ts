import { describe, expect, it } from 'vitest'
import { MCP_DAILY_CALLS, MCP_DAILY_CALLS_EACH, PROTOCOL_VERSIONS, handleMcp } from '../src/mcp'
import { PlanifyError, type Planify } from '../src/planify'
import type { AppState, Item } from '../src/types'
import { sqliteD1 } from './sqliteD1'

const NOW = new Date('2030-01-10T09:00:00Z')
const PERSON = 'someone@example.com'

function item(id: string, phase: number, sortOrder: number, extra: Partial<Item> = {}): Item {
  return {
    id,
    name: id,
    type: 'Course',
    phase,
    skills: ['A skill'],
    workItemId: null,
    baselineStartDate: '2030-01-07',
    baselineEndDate: '2030-01-09',
    projectedStartDate: '2030-01-07',
    projectedEndDate: '2030-01-09',
    dependsOn: [],
    price: '',
    link: null,
    resources: [],
    duration: '~3h',
    notes: 'What it is',
    doneWhen: '',
    state: 'pending',
    completedAt: null,
    hoursDone: 0,
    sortOrder,
    ...extra,
  }
}

const WORLD: AppState = {
  today: '2030-01-08',
  revision: 7,
  draft: null,
  roadmap: {
    timeZone: 'UTC',
    startDate: '2030-01-07',
    weeklyHours: { normal: 15 },
    phases: [
      { number: 1, name: 'First', closingMilestoneId: 'b' },
      { number: 2, name: 'Second', closingMilestoneId: null },
    ],
    blackouts: [],
    dimensions: ['An axis'],
    skillDimension: { 'A skill': 'An axis' },
  },
  workItems: [],
  items: [
    item('b', 1, 2, { baselineStartDate: '2030-01-10', baselineEndDate: '2030-01-12' }),
    item('a', 1, 1, { state: 'done' }),
    item('c', 2, 1, { projectedStartDate: '2030-01-14', projectedEndDate: '2030-01-16' }),
  ],
}

const PREVIEW = {
  revision: 7,
  changes: {
    items: { added: [], removed: [], changed: [{ id: 'a', fields: ['name'] }] },
    workItems: { added: [], removed: [], changed: [] },
    settings: [],
  },
  introduced: [],
  issues: [{ severity: 'warning', rule: 'too-long', message: 'a is long', itemId: 'a' }],
}

type Call = { method: string; path: string; body?: unknown }

/** planify, answering from a script, and noting what it was asked. */
function fakePlanify(answer: (call: Call) => unknown = () => WORLD) {
  const calls: Call[] = []
  const planify: Planify = async (method, path, body) => {
    const call = { method, path, body }
    calls.push(call)
    const answered = answer(call)
    if (answered instanceof Error) throw answered
    return answered
  }
  return { planify, calls }
}

let next = 0
function server(planify: Planify = fakePlanify().planify, principal = PERSON) {
  const { db, sqlite } = sqliteD1()
  const post = (body: unknown, headers: Record<string, string> = {}, now = NOW) =>
    handleMcp(
      new Request('https://planify-mcp.example.workers.dev/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
      db,
      planify,
      principal,
      now,
    )
  const rpc = async (method: string, params?: unknown, now = NOW) =>
    (await (await post({ jsonrpc: '2.0', id: ++next, method, params }, {}, now)).json()) as {
      result?: Record<string, unknown>
      error?: { code: number; message: string }
    }
  /** A tool's answer: the JSON it wrote, or its refusal. */
  const call = async (name: string, args: Record<string, unknown> = {}, now = NOW) => {
    const { result, error } = await rpc('tools/call', { name, arguments: args }, now)
    if (error) throw new Error(error.message)
    const text = (result!.content as Array<{ text: string }>)[0]!.text
    return result!.isError ? { refused: text } : (JSON.parse(text) as Record<string, unknown>)
  }
  return { db, sqlite, post, rpc, call }
}

describe('the protocol', () => {
  it('introduces itself in the version asked for, or the newest it has', async () => {
    const { rpc } = server()
    const asked = await rpc('initialize', { protocolVersion: '2025-03-26' })
    expect(asked.result).toMatchObject({
      protocolVersion: '2025-03-26',
      capabilities: { tools: {}, prompts: {} },
      serverInfo: { name: 'planify' },
    })
    expect(
      (await rpc('initialize', { protocolVersion: '1999-01-01' })).result?.protocolVersion,
    ).toBe(PROTOCOL_VERSIONS[0])
  })

  it('lists its tools, each with a schema and without its code', async () => {
    const { rpc } = server()
    const tools = (await rpc('tools/list')).result!.tools as Array<Record<string, unknown>>
    expect(tools.map((tool) => tool.name)).toEqual([
      'get_roadmap',
      'list_items',
      'export_roadmap',
      'validate',
      'apply_edits',
      'move_item',
      'generate',
      'import_roadmap',
      'start_draft',
      'publish_draft',
      'discard_draft',
    ])
    for (const tool of tools) {
      expect(tool.inputSchema).toMatchObject({ type: 'object' })
      expect(tool.run).toBeUndefined()
    }
  })

  it('takes a notification without answering it', async () => {
    const response = await server().post({ jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(response.status).toBe(202)
    expect(await response.text()).toBe('')
  })

  it('answers what it cannot do with the JSON-RPC error for it', async () => {
    const { rpc, post } = server()
    const code = async (response: Promise<Response>) =>
      ((await (await response).json()) as { error: { code: number } }).error.code
    expect((await rpc('resources/list')).error?.code).toBe(-32601)
    expect((await rpc('tools/call', { name: 'nothing' })).error?.code).toBe(-32602)
    expect(await code(post('{not json'))).toBe(-32700)
    expect(await code(post([{ jsonrpc: '2.0', id: 1, method: 'ping' }]))).toBe(-32600)
  })

  it('opens no stream and refuses another site', async () => {
    const { db, post } = server()
    const get = await handleMcp(
      new Request('https://planify-mcp.example.workers.dev/mcp'),
      db,
      fakePlanify().planify,
      PERSON,
    )
    expect(get.status).toBe(405)
    const ping = { jsonrpc: '2.0', id: 1, method: 'ping' }
    expect((await post(ping, { Origin: 'https://evil.example' })).status).toBe(403)
    expect((await post(ping, { Origin: 'https://planify-mcp.example.workers.dev' })).status).toBe(
      200,
    )
  })
})

describe('the tools', () => {
  it('reads the roadmap small: an overview, then the items asked for, in plan order', async () => {
    const { planify, calls } = fakePlanify()
    const { call } = server(planify)

    const overview = await call('get_roadmap')
    expect(overview).toMatchObject({ target: 'live', revision: 7, weeklyHours: 15 })
    expect(overview.phases).toEqual([
      expect.objectContaining({ number: 1, items: 2, done: 1, plannedEnd: '2030-01-12' }),
      expect.objectContaining({ number: 2, items: 1, done: 0 }),
    ])

    const phase1 = (await call('list_items', { phase: 1 })).items as Array<Record<string, unknown>>
    expect(phase1.map((each) => each.id)).toEqual(['a', 'b'])
    expect(phase1[0]).not.toHaveProperty('notes')
    expect(phase1[0]).not.toHaveProperty('projectedStart')
    const moved = (await call('list_items', { phase: 2, full: true })).items as Array<
      Record<string, unknown>
    >
    expect(moved[0]).toMatchObject({ notes: 'What it is', projectedStart: '2030-01-14' })

    await call('get_roadmap', { draft: true })
    expect(calls.map((each) => each.path)).toEqual([
      '/api/state',
      '/api/state',
      '/api/state',
      '/api/draft',
    ])
  })

  it('sends a write with its revision, target and dry run, and compacts the preview', async () => {
    const { planify, calls } = fakePlanify(({ body }) =>
      (body as { dryRun: boolean }).dryRun ? PREVIEW : { ...WORLD, revision: 8 },
    )
    const { call } = server(planify)
    const edits = [{ op: 'updateItem', id: 'a', fields: { name: 'A' } }]

    const dry = await call('apply_edits', { revision: 7, edits, dryRun: true, draft: true })
    expect(dry).toEqual({
      dryRun: true,
      revision: 7,
      changes: PREVIEW.changes,
      introducedErrors: [],
      errors: 0,
      warnings: 1,
    })
    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/api/edits',
      body: { edits, revision: 7, draft: true, dryRun: true },
    })

    expect(await call('apply_edits', { revision: 7, edits })).toEqual({
      applied: true,
      revision: 8,
      target: 'live',
    })
  })

  it('moves an item’s dates through the item’s own route', async () => {
    const { planify, calls } = fakePlanify(() => ({ ...WORLD, revision: 8 }))
    await server(planify).call('move_item', {
      revision: 7,
      id: 'a b',
      start: '2030-02-01',
      end: '2030-02-03',
    })
    expect(calls[0]).toEqual({
      method: 'PATCH',
      path: '/api/items/a%20b/dates',
      body: {
        baselineStartDate: '2030-02-01',
        baselineEndDate: '2030-02-03',
        revision: 7,
        draft: false,
        dryRun: false,
      },
    })
  })

  it('passes on where a generator would place each item', async () => {
    const placed = [{ id: 'x', name: 'X', start: '2030-02-01', end: '2030-02-01', hours: 2 }]
    const { planify } = fakePlanify(() => ({ ...PREVIEW, placed }))
    const dry = await server(planify).call('generate', { revision: 7, generator: {}, dryRun: true })
    expect(dry.placed).toEqual(placed)
  })

  it('imports the file as exported, without the revision it names', async () => {
    const { planify, calls } = fakePlanify(() => PREVIEW)
    await server(planify).call('import_roadmap', {
      revision: 7,
      roadmap: { revision: 5, timeZone: 'UTC' },
      dryRun: true,
    })
    expect(calls[0]!.body).toEqual({
      roadmap: { timeZone: 'UTC' },
      revision: 7,
      draft: false,
      dryRun: true,
    })
  })

  it('stages and publishes a draft', async () => {
    const { planify, calls } = fakePlanify(({ path, body }) =>
      path === '/api/draft'
        ? { ...WORLD, revision: 1, draft: { startedAt: 'x', updatedAt: 'x' } }
        : (body as { dryRun?: boolean }).dryRun
          ? { ...PREVIEW, liveChanged: true }
          : { ...WORLD, revision: 8 },
    )
    const { call } = server(planify)
    expect(await call('start_draft')).toMatchObject({ target: 'draft', revision: 1 })
    expect(await call('publish_draft', { draftRevision: 3, dryRun: true })).toMatchObject({
      revision: 7,
      liveChanged: true,
    })
    expect(await call('publish_draft', { draftRevision: 3, revision: 7 })).toEqual({
      published: true,
      revision: 8,
      target: 'live',
    })
    expect(calls.at(-1)).toEqual({
      method: 'POST',
      path: '/api/draft/publish',
      body: { draftRevision: 3, revision: 7 },
    })
  })

  it('lists what the plan breaks, counted', async () => {
    const { planify, calls } = fakePlanify(() => ({ revision: 3, issues: PREVIEW.issues }))
    const checked = await server(planify).call('validate', { draft: true })
    expect(checked).toMatchObject({ revision: 3, errors: 0, warnings: 1 })
    expect(calls[0]!.path).toBe('/api/issues?draft=1')
  })
})

describe('refusals', () => {
  const refusedWith = async (error: Error) => {
    const { planify } = fakePlanify(() => error)
    return (await server(planify).call('apply_edits', { revision: 7, edits: [{}] })).refused
  }

  it('turns a stale revision into the revision to read again from', async () => {
    const stale = new PlanifyError(
      'The roadmap changed since this copy was loaded (it is now at revision 9). It has been reloaded; make the change again.',
      409,
      { state: { revision: 9 } },
    )
    expect(await refusedWith(stale)).toBe(
      'It was made from an old revision; it is now at revision 9. Read it again and retry.',
    )
  })

  it('names the errors a write would bring in', async () => {
    const broken = new PlanifyError('It would break the roadmap', 422, {
      issues: [{ severity: 'error', rule: 'cycle', message: 'a → b → a', itemId: 'a' }],
    })
    expect(JSON.parse((await refusedWith(broken)) as string)).toEqual({
      refused: 'It would bring in errors the roadmap does not have',
      errors: [{ rule: 'cycle', message: 'a → b → a' }],
    })
  })

  it('passes on what planify said about an edit it cannot apply', async () => {
    expect(await refusedWith(new PlanifyError('No item with id z', 400))).toBe('No item with id z')
  })

  it('refuses bad arguments before calling planify', async () => {
    const { planify, calls } = fakePlanify()
    const { call } = server(planify)
    expect((await call('apply_edits', { revision: 'seven', edits: [{}] })).refused).toBe(
      'revision must be a whole number',
    )
    expect((await call('apply_edits', { revision: 7, edits: [] })).refused).toBe(
      'edits must be a non-empty array',
    )
    expect(calls).toEqual([])
  })
})

describe('the daily caps', () => {
  const count = (sqlite: ReturnType<typeof server>['sqlite'], principal: string) =>
    sqlite.prepare('SELECT day, calls FROM mcp_usage WHERE principal = ?').get(principal)

  it(`stops one person at ${MCP_DAILY_CALLS_EACH} calls a day, and not the others`, async () => {
    const { planify, calls } = fakePlanify()
    const { sqlite, db, call } = server(planify)
    sqlite.exec(
      `INSERT INTO mcp_usage (principal, day, calls) VALUES ('${PERSON}', '2030-01-10', ${MCP_DAILY_CALLS_EACH})`,
    )

    expect((await call('get_roadmap')).refused).toMatch(/1000 tool calls a day, and yours/)
    expect(calls).toEqual([])

    const someoneElse = await handleMcp(
      new Request('https://planify-mcp.example.workers.dev/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_roadmap' } }),
      }),
      db,
      planify,
      'other@example.com',
      NOW,
    )
    const answer = (await someoneElse.json()) as { result: { isError?: boolean } }
    expect(answer.result.isError).toBeUndefined()
  })

  it(`stops everyone at ${MCP_DAILY_CALLS} calls a day in all`, async () => {
    const { planify, calls } = fakePlanify()
    const { sqlite, call } = server(planify)
    sqlite.exec(
      `INSERT INTO mcp_usage (principal, day, calls) VALUES ('*', '2030-01-10', ${MCP_DAILY_CALLS})`,
    )
    expect((await call('get_roadmap')).refused).toMatch(/2000 tool calls a day in all/)
    expect(calls).toEqual([])
  })

  it('starts both counts again the next day', async () => {
    const { planify } = fakePlanify()
    const { sqlite, call } = server(planify)
    sqlite.exec(
      `INSERT INTO mcp_usage (principal, day, calls) VALUES
         ('${PERSON}', '2030-01-10', ${MCP_DAILY_CALLS_EACH}), ('*', '2030-01-10', ${MCP_DAILY_CALLS})`,
    )
    expect(await call('get_roadmap', {}, new Date('2030-01-11T00:00:01Z'))).toMatchObject({
      revision: 7,
    })
    expect(count(sqlite, PERSON)).toEqual({ day: '2030-01-11', calls: 1 })
    expect(count(sqlite, '*')).toEqual({ day: '2030-01-11', calls: 1 })
  })

  it('counts tool calls only, for the caller and in all', async () => {
    const { sqlite, rpc, call } = server()
    await rpc('tools/list')
    await rpc('prompts/list')
    await call('get_roadmap')
    await call('get_roadmap')
    expect(count(sqlite, PERSON)).toEqual({ day: '2030-01-10', calls: 2 })
    expect(count(sqlite, '*')).toEqual({ day: '2030-01-10', calls: 2 })
  })
})

describe('the prompts', () => {
  it('lists plan_from_spec with its arguments and without its code', async () => {
    const { rpc } = server()
    const prompts = (await rpc('prompts/list')).result!.prompts as Array<Record<string, unknown>>
    expect(prompts.map((prompt) => prompt.name)).toEqual(['plan_from_spec'])
    expect(prompts[0]!.arguments).toEqual([
      expect.objectContaining({ name: 'goal', required: true }),
      expect.objectContaining({ name: 'constraints', required: false }),
    ])
    expect(prompts[0]!.render).toBeUndefined()
  })

  it('writes the goal and the constraints into the method', async () => {
    const { rpc } = server()
    const got = await rpc('prompts/get', {
      name: 'plan_from_spec',
      arguments: { goal: 'Ship a small compiler', constraints: '6 hours a week from March' },
    })
    const [message] = got.result!.messages as Array<{ role: string; content: { text: string } }>
    expect(message!.role).toBe('user')
    expect(message!.content.text).toContain('<goal>\nShip a small compiler\n</goal>')
    expect(message!.content.text).toContain('6 hours a week from March')
    expect(message!.content.text).toContain('start_draft')

    const bare = await rpc('prompts/get', { name: 'plan_from_spec', arguments: { goal: 'X' } })
    const text = (bare.result!.messages as Array<{ content: { text: string } }>)[0]!.content.text
    expect(text).not.toContain('<constraints>')
  })

  it('refuses a prompt it does not have, or one without its goal', async () => {
    const { rpc } = server()
    expect((await rpc('prompts/get', { name: 'nothing' })).error?.code).toBe(-32602)
    expect((await rpc('prompts/get', { name: 'plan_from_spec' })).error).toMatchObject({
      code: -32602,
      message: 'goal is required',
    })
    expect(
      (await rpc('prompts/get', { name: 'plan_from_spec', arguments: { goal: 3 } })).error?.message,
    ).toBe('goal must be a string')
  })
})
