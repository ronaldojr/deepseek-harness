/**
 * The GitHub Copilot OAuth flow: GitHub's device-code login plus the
 * `/copilot_internal/v2/token` exchange. The exchange is implemented here
 * rather than through pi-ai's `login`/`refresh` because those also run
 * pi-ai's "enable every model" policy burst and `/models` availability
 * fetch, whose aggressive rate-limit footprint can reject a login that
 * already obtained its token (observed: `429 Too Many Requests` after the
 * device authorization completed). Base-URL derivation stays upstream:
 * `toAuth` is pi-ai's own, parsed from the token's `proxy-ep` claim.
 *
 * The client id and endpoint set below are GitHub's protocol constants for
 * the Copilot OAuth application pi-ai ships, not deployment tunables.
 * @module @deepseek-ai/dsh-llm-oauth/github-copilot
 */

import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import type { ModelAuth, OAuthCredential, Provider } from '@earendil-works/pi-ai'
import type { OauthFlow, OauthLoginEvent } from './service.ts'

/** OAuth client id of the Copilot application pi-ai's catalog ships. */
const CLIENT_ID = 'Iv1.b507a08c87ecfe98'

/** Request headers the Copilot gateway expects from editor integrations. */
const COPILOT_HEADERS = {
  'User-Agent': 'GitHubCopilotChat/0.35.0',
  'Editor-Version': 'vscode/1.107.0',
  'Editor-Plugin-Version': 'copilot-chat/0.35.0',
  'Copilot-Integration-Id': 'vscode-chat',
}

/** One device-flow start response. */
interface DeviceFlow {
  device_code: string
  user_code: string
  verification_uri: string
  interval?: number
  expires_in?: number
}

/** One Copilot token exchange response. */
interface CopilotTokenResponse {
  token: string
  expires_at: number
}

/** Whether a rejection carries the given HTTP status. */
function hasStatus(error: unknown, status: number): boolean {
  return typeof error === 'object' && error !== null && (error as { status?: unknown }).status === status
}

/** JSON response of an aborted- or failure-aware request. */
async function fetchJson(url: string, init: RequestInit): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(url, init)
  const text = await response.text()
  let json: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null) json = parsed as Record<string, unknown>
  } catch {
    json = { _raw: text }
  }
  if (!response.ok) {
    const error = new Error(`${response.status} ${response.statusText}: ${text.slice(0, 200)}`)
    ;(error as { status?: number }).status = response.status
    throw error
  }
  return { status: response.status, json }
}

/** POST a form body to GitHub's OAuth endpoints. */
async function postForm(url: string, body: Record<string, string>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  return (await fetchJson(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': COPILOT_HEADERS['User-Agent'],
    },
    body: new URLSearchParams(body),
    ...(signal === undefined ? {} : { signal }),
  })).json
}

/** Start the device flow and surface the URL + code through `notify`. */
async function startDeviceFlow(signal: AbortSignal): Promise<DeviceFlow> {
  const raw = await postForm('https://github.com/login/device/code', {
    client_id: CLIENT_ID,
    scope: 'read:user',
  }, signal)
  const flow: DeviceFlow = {
    device_code: typeof raw.device_code === 'string' ? raw.device_code : '',
    user_code: typeof raw.user_code === 'string' ? raw.user_code : '',
    verification_uri: typeof raw.verification_uri === 'string' ? raw.verification_uri : '',
  }
  if (flow.device_code.length === 0 || flow.user_code.length === 0 || flow.verification_uri.length === 0) {
    throw new Error(`github-copilot: invalid device-code response: ${JSON.stringify(raw)}`)
  }
  if (typeof raw.interval === 'number') flow.interval = raw.interval
  if (typeof raw.expires_in === 'number') flow.expires_in = raw.expires_in
  return flow
}

/** Poll GitHub for the OAuth access token until the user authorizes or the grant expires. */
async function pollAccessToken(flow: DeviceFlow, signal: AbortSignal): Promise<string> {
  const intervalMs = Math.max(flow.interval ?? 5, 1) * 1000
  const deadline = Date.now() + (flow.expires_in ?? 900) * 1000
  for (;;) {
    if (signal.aborted) throw new Error('github-copilot: device flow cancelled')
    if (Date.now() >= deadline) throw new Error('github-copilot: device flow timed out waiting for authorization')
    const raw = await postForm('https://github.com/login/oauth/access_token', {
      client_id: CLIENT_ID,
      device_code: flow.device_code,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }, signal)
    if (typeof raw.access_token === 'string' && raw.access_token.length > 0) return raw.access_token
    const error = typeof raw.error === 'string' ? raw.error : undefined
    if (error === 'authorization_pending' || error === 'slow_down' || error === undefined) {
      await new Promise(resolve => setTimeout(resolve, intervalMs))
      continue
    }
    const description = typeof raw.error_description === 'string' ? `: ${raw.error_description}` : ''
    throw new Error(`github-copilot: device flow failed: ${error}${description}`)
  }
}

/** Exchange a GitHub OAuth access token for the short-lived Copilot token. */
async function exchangeCopilotToken(githubAccessToken: string, signal?: AbortSignal): Promise<CopilotTokenResponse> {
  const { json } = await fetchJson('https://api.github.com/copilot_internal/v2/token', {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${githubAccessToken}`,
      ...COPILOT_HEADERS,
    },
    ...(signal === undefined ? {} : { signal }),
  })
  if (typeof json.token !== 'string' || typeof json.expires_at !== 'number') {
    throw new Error(`github-copilot: invalid Copilot token response: ${JSON.stringify(json)}`)
  }
  return { token: json.token, expires_at: json.expires_at }
}

/** Build one stored credential from the exchange result. */
function credentialOf(githubAccessToken: string, exchanged: CopilotTokenResponse): OAuthCredential {
  return {
    type: 'oauth',
    refresh: githubAccessToken,
    access: exchanged.token,
    expires: exchanged.expires_at * 1000,
  }
}

/** The catalog provider's `toAuth`, which derives the request base URL from the token itself. */
function copilotToAuth(): (credential: OAuthCredential) => Promise<ModelAuth> {
  const provider = builtinProviders().find((candidate: Provider) => candidate.id === 'github-copilot')
  const oauth = provider?.auth.oauth
  if (oauth === undefined) {
    throw new Error('github-copilot: the installed pi-ai catalog ships no OAuth method for github-copilot')
  }
  return credential => oauth.toAuth(credential)
}

const toAuth = copilotToAuth()

/** The built-in GitHub Copilot flow: public github.com, no enterprise domain. */
export const githubCopilotFlow: OauthFlow = {
  provider: 'github-copilot',
  async login(notify: (event: OauthLoginEvent) => void, signal: AbortSignal): Promise<OAuthCredential> {
    const flow = await startDeviceFlow(signal)
    notify({ type: 'device-code', verificationUri: flow.verification_uri, userCode: flow.user_code })
    const githubAccessToken = await pollAccessToken(flow, signal)
    notify({ type: 'connecting', message: 'Exchanging authorization for a Copilot token' })
    return credentialOf(githubAccessToken, await exchangeCopilotToken(githubAccessToken, signal))
  },
  async refresh(credential: OAuthCredential, signal?: AbortSignal): Promise<OAuthCredential> {
    return credentialOf(credential.refresh, await exchangeCopilotToken(credential.refresh, signal))
  },
  toAuth,
}

/**
 * Whether a rejection is the "refresh material no longer accepted" failure.
 * @param error - the refresh rejection this predicate classifies.
 * @returns true when the status is 401 or 403, so the caller can surface the failed phase.
 */
export function isOauthRefreshRejected(error: unknown): boolean {
  return hasStatus(error, 401) || hasStatus(error, 403)
}
