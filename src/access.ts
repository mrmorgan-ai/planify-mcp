import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'

/**
 * Cloudflare Access signs in at the edge, but only on the hostnames its
 * application lists. Any other name that reaches the same Worker — a preview
 * URL, a hostname left out of the application — goes straight to the code. So
 * every request proves it passed through Access by carrying the token Access
 * signed, and anything else is refused. The same check planify makes.
 */
/** Who a request comes from, as Access signed it. */
export type Caller = {
  /** An email for a person, a client id for a service token. */
  principal: string
  /** Local development, where the development identity stands in for a person. */
  local: boolean
}

export type AccessEnv = {
  ACCESS_TEAM_DOMAIN?: string
  ACCESS_AUD?: string
  /** Local development only: `wrangler pages dev` has no Access in front of it. */
  DEV_IDENTITY?: string
}

const TOKEN_HEADER = 'Cf-Access-Jwt-Assertion'
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1'])

const keySets = new Map<string, JWTVerifyGetKey>()

function accessKeys(teamDomain: string): JWTVerifyGetKey {
  let keys = keySets.get(teamDomain)
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`))
    keySets.set(teamDomain, keys)
  }
  return keys
}

/** Who the request comes from, or the response that refuses it. */
export async function authenticate(
  request: Request,
  env: AccessEnv,
  keys?: JWTVerifyGetKey,
): Promise<Caller | Response> {
  // Honoured only on a loopback host, so the variable leaking into a deployed
  // environment still opens nothing.
  if (env.DEV_IDENTITY && LOCAL_HOSTS.has(new URL(request.url).hostname)) {
    return { principal: env.DEV_IDENTITY, local: true }
  }

  const teamDomain = env.ACCESS_TEAM_DOMAIN
  const audience = env.ACCESS_AUD
  if (!teamDomain || !audience) {
    return Response.json({ error: 'Sign-in is not configured on this deployment' }, { status: 500 })
  }

  const token = request.headers.get(TOKEN_HEADER)
  if (!token) return unauthorized()

  try {
    const { payload } = await jwtVerify(token, keys ?? accessKeys(teamDomain), {
      issuer: `https://${teamDomain}`,
      audience,
      algorithms: ['RS256'],
    })
    // A person carries an email; a service token carries its client id instead.
    const who = payload.email ?? payload.common_name
    return typeof who === 'string' && who !== '' ? { principal: who, local: false } : unauthorized()
  } catch {
    return unauthorized()
  }
}

function unauthorized(): Response {
  return Response.json({ error: 'Sign in through Cloudflare Access' }, { status: 401 })
}
