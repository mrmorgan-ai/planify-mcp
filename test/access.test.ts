import { beforeAll, describe, expect, it } from 'vitest'
import { generateKeyPair, SignJWT, type CryptoKey, type JWTPayload } from 'jose'
import { authorize, type AccessEnv } from '../src/access'

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

describe('authorize', () => {
  it('lets through a person signed in by Access', async () => {
    expect(await authorize(request(DEPLOYED, await token()), ENV, keys)).toBeNull()
  })

  it('lets through a service token, which carries a client id instead of an email', async () => {
    const jwt = await token({ common_name: 'client-id.access' })
    expect(await authorize(request(DEPLOYED, jwt), ENV, keys)).toBeNull()
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
    const response = await authorize(request(DEPLOYED, await make()), ENV, keys)
    expect(response?.status).toBe(401)
  })

  it('fails closed when the deployment does not say which Access application to trust', async () => {
    const response = await authorize(request(DEPLOYED, await token()), {}, keys)
    expect(response?.status).toBe(500)
  })

  it('trusts the development identity on a loopback host', async () => {
    const local = { ...ENV, DEV_IDENTITY: 'dev@localhost' }
    expect(await authorize(request('http://127.0.0.1:8787/mcp'), local, keys)).toBeNull()
    expect(await authorize(request('http://localhost:8787/mcp'), local, keys)).toBeNull()
  })

  it('ignores the development identity anywhere else', async () => {
    const leaked = { ...ENV, DEV_IDENTITY: 'dev@localhost' }
    const response = await authorize(request(DEPLOYED), leaked, keys)
    expect(response?.status).toBe(401)
  })
})
