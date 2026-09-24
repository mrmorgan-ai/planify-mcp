import { beforeAll, describe, expect, it } from 'vitest'
import { generateKeyPair, SignJWT, type CryptoKey, type JWTPayload } from 'jose'
import { authenticate, type AccessEnv } from '../src/access'

const TEAM = 'team.cloudflareaccess.com'
const AUD = 'app-audience-tag'
const ENV: AccessEnv = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD }
const DEPLOYED = 'https://planify-mcp.example.workers.dev/mcp'

let signingKey: CryptoKey
let strangerKey: CryptoKey
let keys: () => Promise<CryptoKey>

beforeAll(async () => {
  const pair = await generateKeyPair('RS256')
  signingKey = pair.privateKey
  strangerKey = (await generateKeyPair('RS256')).privateKey
  keys = async () => pair.publicKey
})

function token(
  claims: JWTPayload = { email: 'owner@example.com' },
  { key = signingKey, issuer = `https://${TEAM}`, audience = AUD, expires = '5m' } = {},
) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(expires)
    .sign(key)
}

function request(url: string, jwt?: string): Request {
  return new Request(url, { headers: jwt ? { 'Cf-Access-Jwt-Assertion': jwt } : {} })
}

/** The status a refusal answers with, or the caller when there is none. */
const statusOf = (answer: Awaited<ReturnType<typeof authenticate>>) =>
  answer instanceof Response ? answer.status : answer

describe('authenticate', () => {
  it('names a person signed in by Access by their email', async () => {
    expect(await authenticate(request(DEPLOYED, await token()), ENV, keys)).toEqual({
      principal: 'owner@example.com',
      local: false,
    })
  })

  it('names a service token by its client id, which it carries instead of an email', async () => {
    const jwt = await token({ common_name: 'client-id.access' })
    expect(await authenticate(request(DEPLOYED, jwt), ENV, keys)).toEqual({
      principal: 'client-id.access',
      local: false,
    })
  })

  it.each([
    ['no token at all', () => Promise.resolve(undefined)],
    ['a token signed by another key', () => token(undefined, { key: strangerKey })],
    ['a token for another Access application', () => token(undefined, { audience: 'other-app' })],
    [
      'a token from another team',
      () => token(undefined, { issuer: 'https://evil.cloudflareaccess.com' }),
    ],
    ['an expired token', () => token(undefined, { expires: '-1m' })],
    ['a token that names nobody', () => token({})],
  ])('refuses %s with 401', async (_, make) => {
    expect(statusOf(await authenticate(request(DEPLOYED, await make()), ENV, keys))).toBe(401)
  })

  it('fails closed when the deployment does not say which Access application to trust', async () => {
    expect(statusOf(await authenticate(request(DEPLOYED, await token()), {}, keys))).toBe(500)
  })

  it('trusts the development identity on a loopback host', async () => {
    const local = { ...ENV, DEV_IDENTITY: 'dev@localhost' }
    const dev = { principal: 'dev@localhost', local: true }
    expect(await authenticate(request('http://127.0.0.1:8787/mcp'), local, keys)).toEqual(dev)
    expect(await authenticate(request('http://localhost:8787/mcp'), local, keys)).toEqual(dev)
  })

  it('ignores the development identity anywhere else', async () => {
    const leaked = { ...ENV, DEV_IDENTITY: 'dev@localhost' }
    expect(statusOf(await authenticate(request(DEPLOYED), leaked, keys))).toBe(401)
  })
})
