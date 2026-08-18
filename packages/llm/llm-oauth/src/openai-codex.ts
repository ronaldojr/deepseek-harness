/**
 * The OpenAI Codex (ChatGPT Plus/Pro) OAuth flow: OpenAI's device-code login
 * plus the `auth.openai.com` token exchange and refresh.
 *
 * OpenAI's device stage does not return tokens: authorizing the device code
 * yields an authorization code plus PKCE verifier, which this flow then
 * exchanges through the ordinary `authorization_code` grant against
 * `/oauth/token`. Refresh uses the same endpoint's `refresh_token` grant.
 * Base-URL derivation stays upstream: `toAuth` is the catalog provider's own,
 * which derives `https://chatgpt.com/backend-api`.
 *
 * The client id, endpoints, and redirect URI are OpenAI's protocol constants
 * for the ChatGPT OAuth application pi-ai's catalog ships, not deployment
 * tunables.
 *
 * @module @deepseek-ai/dsh-llm-oauth/openai-codex
 */
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import type { ModelAuth, OAuthCredential, Provider } from '@earendil-works/pi-ai'
import type { OauthFlow, OauthLoginEvent } from './service.ts'

/** OAuth client id of the ChatGPT application pi-ai's catalog ships. */
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'

const AUTH_BASE_URL = 'https://auth.openai.com'
const DEVICE_USER_CODE_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/usercode`
const DEVICE_TOKEN_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/token`
const DEVICE_VERIFICATION_URI = `${AUTH_BASE_URL}/codex/device`
const DEVICE_REDIRECT_URI = `${AUTH_BASE_URL}/deviceauth/callback`
const TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`

/** Total device-authorization window before the grant expires. */
const DEVICE_CODE_TIMEOUT_SECONDS = 900

/** One device-auth start response. */
interface DeviceAuth {
  deviceAuthId: string
  userCode: string
  intervalSeconds: number
}

/** One completed device authorization: an authorization code plus its verifier. */
interface DeviceAuthorization {
  authorizationCode: string
  codeVerifier: string
}

/** One token-endpoint response. */
interface TokenSet {
  access: string
  refresh: string
  expires: number
}

/** POST a JSON body to OpenAI's device endpoints. */
async function postJson(url: string, body: Record<string, string>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  })
  const text = await response.text()
  let json: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null) json = parsed as Record<string, unknown>
  } catch {
    json = { _raw: text }
  }
  if (!response.ok) {
    const error = new Error(`openai-codex: ${response.status} ${response.statusText}: ${text.slice(0, 200)}`)
    ;(error as { status?: number }).status = response.status
    throw error
  }
  return json
}

/** POST a form body to OpenAI's OAuth token endpoint. */
async function postForm(url: string, body: Record<string, string>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
    ...(signal === undefined ? {} : { signal }),
  })
  const text = await response.text()
  let json: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null) json = parsed as Record<string, unknown>
  } catch {
    json = { _raw: text }
  }
  if (!response.ok) {
    const error = new Error(`openai-codex: ${response.status} ${response.statusText}: ${text.slice(0, 200)}`)
    ;(error as { status?: number }).status = response.status
    throw error
  }
  return json
}

/** Start the device flow and surface the URL + code through `notify`. */
async function startDeviceAuth(signal: AbortSignal): Promise<DeviceAuth> {
  const raw = await postJson(DEVICE_USER_CODE_URL, { client_id: CLIENT_ID }, signal)
  const interval = typeof raw.interval === 'string' ? Number(raw.interval.trim()) : raw.interval
  if (
    typeof raw.device_auth_id !== 'string' || raw.device_auth_id.length === 0 ||
    typeof raw.user_code !== 'string' || raw.user_code.length === 0 ||
    typeof interval !== 'number' || !Number.isFinite(interval) || interval < 0
  ) {
    throw new Error(`openai-codex: invalid device-code response: ${JSON.stringify(raw)}`)
  }
  return { deviceAuthId: raw.device_auth_id, userCode: raw.user_code, intervalSeconds: interval }
}

/** Poll OpenAI until the user authorizes the device or the grant expires. */
async function pollDeviceAuth(device: DeviceAuth, signal: AbortSignal): Promise<DeviceAuthorization> {
  const deadline = Date.now() + DEVICE_CODE_TIMEOUT_SECONDS * 1000
  let intervalMs = Math.max(device.intervalSeconds, 1) * 1000
  for (;;) {
    if (signal.aborted) throw new Error('openai-codex: device flow cancelled')
    if (Date.now() >= deadline) throw new Error('openai-codex: device flow timed out waiting for authorization')
    const raw = await postJson(DEVICE_TOKEN_URL, {
      device_auth_id: device.deviceAuthId,
      user_code: device.userCode,
    }, signal).catch((error: unknown): Record<string, unknown> => {
      // 403/404 mean the authorization is still pending (the reference flow
      // treats both as "poll again"); any other rejection is fatal.
      const status = (error as { status?: unknown }).status
      if (status === 403 || status === 404) return {}
      throw error
    })
    if (typeof raw.authorization_code === 'string' && typeof raw.code_verifier === 'string') {
      return { authorizationCode: raw.authorization_code, codeVerifier: raw.code_verifier }
    }
    const error = (raw.error as { code?: unknown } | undefined)?.code
    if (error === 'deviceauth_authorization_pending' || error === undefined) {
      await new Promise(resolve => setTimeout(resolve, intervalMs))
      continue
    }
    if (error === 'slow_down') {
      intervalMs += 5_000
      await new Promise(resolve => setTimeout(resolve, intervalMs))
      continue
    }
    throw new Error(`openai-codex: device flow failed: ${JSON.stringify(raw).slice(0, 200)}`)
  }
}

/** Parse one token-endpoint response into a token set. */
function tokenSetOf(raw: Record<string, unknown>): TokenSet {
  if (typeof raw.access_token !== 'string' || typeof raw.refresh_token !== 'string' || typeof raw.expires_in !== 'number') {
    throw new Error(`openai-codex: token response missing fields: ${JSON.stringify(raw).slice(0, 200)}`)
  }
  return { access: raw.access_token, refresh: raw.refresh_token, expires: Date.now() + raw.expires_in * 1000 }
}

/** Exchange one authorization code (plus verifier) for the first token set. */
async function exchangeAuthorizationCode(code: string, verifier: string, signal: AbortSignal): Promise<TokenSet> {
  return tokenSetOf(await postForm(TOKEN_URL, {
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    code,
    code_verifier: verifier,
    redirect_uri: DEVICE_REDIRECT_URI,
  }, signal))
}

/** Mint a fresh token set from the credential's refresh material. */
async function refreshAccessToken(refreshToken: string, signal?: AbortSignal): Promise<TokenSet> {
  return tokenSetOf(await postForm(TOKEN_URL, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  }, signal))
}

/** Build one stored credential from a token set. */
function credentialOf(tokens: TokenSet): OAuthCredential {
  return {
    type: 'oauth',
    refresh: tokens.refresh,
    access: tokens.access,
    expires: tokens.expires,
  }
}

/** The catalog provider's `toAuth`, which derives the request base URL. */
function codexToAuth(): (credential: OAuthCredential) => Promise<ModelAuth> {
  const provider = builtinProviders().find((candidate: Provider) => candidate.id === 'openai-codex')
  const oauth = provider?.auth.oauth
  if (oauth === undefined) {
    throw new Error('openai-codex: the installed pi-ai catalog ships no OAuth method for openai-codex')
  }
  return credential => oauth.toAuth(credential)
}

const toAuth = codexToAuth()

/** The built-in OpenAI Codex flow: ChatGPT Plus/Pro subscription login. */
export const openAiCodexFlow: OauthFlow = {
  provider: 'openai-codex',
  async login(notify: (event: OauthLoginEvent) => void, signal: AbortSignal): Promise<OAuthCredential> {
    const device = await startDeviceAuth(signal)
    notify({ type: 'device-code', verificationUri: DEVICE_VERIFICATION_URI, userCode: device.userCode })
    const code = await pollDeviceAuth(device, signal)
    notify({ type: 'connecting', message: 'Exchanging authorization for an OpenAI Codex token' })
    return credentialOf(await exchangeAuthorizationCode(code.authorizationCode, code.codeVerifier, signal))
  },
  async refresh(credential: OAuthCredential, signal?: AbortSignal): Promise<OAuthCredential> {
    return credentialOf(await refreshAccessToken(credential.refresh, signal))
  },
  toAuth,
}
