/** Where planify is, and how this Worker signs in to it. */
export type PlanifyEnv = {
  PLANIFY_URL?: string
  PLANIFY_CLIENT_ID?: string
  PLANIFY_CLIENT_SECRET?: string
}

/**
 * The header naming the person this server acts for. planify honours it only
 * from a principal it lists as a delegate — this server's service token — and
 * answers with that person's roadmap.
 */
export const ON_BEHALF_OF = 'X-Planify-On-Behalf-Of'

/** A request planify refused, with what it said. */
export class PlanifyError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message)
  }
}

/** planify's API, as this server calls it: JSON in, JSON out. */
export type Planify = (method: string, path: string, body?: unknown) => Promise<unknown>

/**
 * Calls planify with the Access service token, the way a signed-in person's
 * browser would with its cookie, on behalf of the person who called this
 * server: planify answers with their roadmap and no one else's. Access answers
 * a request it refuses with a redirect to its sign-in page, not an error, so
 * redirects are not followed: one means the token was not accepted.
 */
export function planifyClient(
  env: PlanifyEnv,
  onBehalfOf: string,
  fetcher: typeof fetch = fetch,
): Planify {
  return async (method, path, body) => {
    if (!env.PLANIFY_URL) {
      throw new PlanifyError('PLANIFY_URL is not set on this Worker', 500)
    }
    const headers: Record<string, string> = {
      accept: 'application/json',
      [ON_BEHALF_OF]: onBehalfOf,
    }
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (env.PLANIFY_CLIENT_ID && env.PLANIFY_CLIENT_SECRET) {
      headers['CF-Access-Client-Id'] = env.PLANIFY_CLIENT_ID
      headers['CF-Access-Client-Secret'] = env.PLANIFY_CLIENT_SECRET
    }

    const response = await fetcher(new URL(path, env.PLANIFY_URL), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    })
    if (response.status >= 300 && response.status < 400) {
      throw new PlanifyError(
        'planify’s Access refused this server’s service token: check PLANIFY_CLIENT_ID, PLANIFY_CLIENT_SECRET and the Service Auth policy',
        response.status,
      )
    }

    const answer: unknown = await response.json().catch(() => undefined)
    if (answer === undefined) {
      throw new PlanifyError(
        `planify did not answer with JSON (HTTP ${response.status}); check PLANIFY_URL`,
        response.status,
      )
    }
    if (!response.ok) {
      const refused = answer as Record<string, unknown>
      const message = typeof refused.error === 'string' ? refused.error : `HTTP ${response.status}`
      throw new PlanifyError(message, response.status, refused)
    }
    return answer
  }
}
