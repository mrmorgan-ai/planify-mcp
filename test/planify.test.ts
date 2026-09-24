import { describe, expect, it } from 'vitest'
import { ON_BEHALF_OF, PlanifyError, planifyClient } from '../src/planify'

const PERSON = 'someone@example.com'

const ENV = {
  PLANIFY_URL: 'https://planify.example',
  PLANIFY_CLIENT_ID: 'id.access',
  PLANIFY_CLIENT_SECRET: 'secret',
}

/** A fetch that answers once, and keeps what it was asked. */
function answering(response: Response) {
  const asked: Request[] = []
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    asked.push(new Request(input, init))
    return response
  }) as typeof fetch
  return { fetcher, asked }
}

describe('the planify client', () => {
  it('signs in with the service token and sends JSON', async () => {
    const { fetcher, asked } = answering(Response.json({ revision: 3 }))
    const answer = await planifyClient(ENV, PERSON, fetcher)('POST', '/api/edits', { revision: 2 })

    expect(answer).toEqual({ revision: 3 })
    const [request] = asked
    expect(request!.url).toBe('https://planify.example/api/edits')
    expect(request!.headers.get('CF-Access-Client-Id')).toBe('id.access')
    expect(request!.headers.get('CF-Access-Client-Secret')).toBe('secret')
    expect(request!.headers.get(ON_BEHALF_OF)).toBe(PERSON)
    expect(request!.redirect).toBe('manual')
    expect(await request!.json()).toEqual({ revision: 2 })
  })

  it('sends no token when it has none, as against a local planify', async () => {
    const { fetcher, asked } = answering(Response.json({}))
    await planifyClient({ PLANIFY_URL: 'http://127.0.0.1:8788' }, PERSON, fetcher)('GET', '/api/state')
    expect(asked[0]!.headers.has('CF-Access-Client-Id')).toBe(false)
  })

  it('reads a redirect as Access refusing the token', async () => {
    const { fetcher } = answering(
      new Response(null, { status: 302, headers: { Location: 'https://team/login' } }),
    )
    await expect(planifyClient(ENV, PERSON, fetcher)('GET', '/api/state')).rejects.toThrow(
      /refused this server’s service token/,
    )
  })

  it('keeps what planify said when it refuses', async () => {
    const { fetcher } = answering(
      Response.json({ error: 'Stale', state: { revision: 9 } }, { status: 409 }),
    )
    const refused = planifyClient(ENV, PERSON, fetcher)('POST', '/api/edits', {})
    await expect(refused).rejects.toBeInstanceOf(PlanifyError)
    await expect(refused).rejects.toMatchObject({
      message: 'Stale',
      status: 409,
      body: { state: { revision: 9 } },
    })
  })

  it('says so when planify is not what answered', async () => {
    const { fetcher } = answering(new Response('<html>', { status: 200 }))
    await expect(planifyClient(ENV, PERSON, fetcher)('GET', '/api/state')).rejects.toThrow(
      /did not answer with JSON/,
    )
    await expect(planifyClient({}, PERSON, fetcher)('GET', '/api/state')).rejects.toThrow(
      'PLANIFY_URL is not set',
    )
  })
})
