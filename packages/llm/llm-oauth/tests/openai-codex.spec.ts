import { afterEach, describe, expect, it, vi } from 'vitest'
import { openAiCodexFlow } from '../src/openai-codex.ts'

/** A minimal fetch-response stand-in carrying status plus a JSON or text body. */
function mockResponse(ok: boolean, status: number, body: unknown) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    text: async () => text,
  } as unknown as Response
}

const fetchMock = vi.fn()

function stubFetch() {
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('openai-codex flow', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    fetchMock.mockReset()
  })

  it('logs in through the device flow and exchanges the authorization code', async () => {
    const fetch = stubFetch()
    fetch
      // Device start.
      .mockResolvedValueOnce(mockResponse(true, 200, { device_auth_id: 'da1', user_code: 'ABCD-1234', interval: 1 }))
      // Poll: still pending, then authorized.
      .mockResolvedValueOnce(mockResponse(true, 200, { error: { code: 'deviceauth_authorization_pending' } }))
      .mockResolvedValueOnce(mockResponse(true, 200, { authorization_code: 'ac1', code_verifier: 'cv1' }))
      // Authorization-code exchange.
      .mockResolvedValueOnce(mockResponse(true, 200, { access_token: 'at1', refresh_token: 'rt1', expires_in: 3600 }))

    const events: unknown[] = []
    const credential = await openAiCodexFlow.login(event => events.push(event), new AbortController().signal)

    expect(events).toEqual([
      { type: 'device-code', verificationUri: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234' },
      { type: 'connecting', message: 'Exchanging authorization for an OpenAI Codex token' },
    ])
    expect(credential).toMatchObject({ type: 'oauth', refresh: 'rt1', access: 'at1' })
    expect(credential.expires).toBeGreaterThan(Date.now())

    // The device start names the ChatGPT application.
    const startCall = fetch.mock.calls[0]
    if (startCall === undefined) throw new Error('expected a device-start call')
    const startInit = startCall[1] as RequestInit | undefined
    if (startInit === undefined) throw new Error('expected a device-start request init')
    expect(JSON.parse(startInit.body as string)).toEqual({ client_id: 'app_EMoamEEZ73f0CkXaXp7hrann' })
    // The exchange runs the authorization_code grant with the PKCE verifier.
    const exchangeCall = fetch.mock.calls[3]
    if (exchangeCall === undefined) throw new Error('expected an exchange call')
    const exchangeInit = exchangeCall[1] as RequestInit | undefined
    if (exchangeInit === undefined) throw new Error('expected an exchange request init')
    const exchangeBody = new URLSearchParams(exchangeInit.body as string)
    expect(exchangeBody.get('grant_type')).toBe('authorization_code')
    expect(exchangeBody.get('code')).toBe('ac1')
    expect(exchangeBody.get('code_verifier')).toBe('cv1')
    expect(exchangeBody.get('redirect_uri')).toBe('https://auth.openai.com/deviceauth/callback')
  })

  it('treats a 403 device poll as still pending and keeps polling', async () => {
    const fetch = stubFetch()
    fetch
      .mockResolvedValueOnce(mockResponse(true, 200, { device_auth_id: 'da1', user_code: 'ABCD-1234', interval: 0 }))
      .mockResolvedValueOnce(mockResponse(false, 403, '{}'))
      .mockResolvedValueOnce(mockResponse(true, 200, { authorization_code: 'ac1', code_verifier: 'cv1' }))
      .mockResolvedValueOnce(mockResponse(true, 200, { access_token: 'at1', refresh_token: 'rt1', expires_in: 3600 }))

    const credential = await openAiCodexFlow.login(() => {}, new AbortController().signal)
    expect(credential.access).toBe('at1')
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it('refreshes through the token endpoint', async () => {
    const fetch = stubFetch()
    fetch.mockResolvedValueOnce(mockResponse(true, 200, { access_token: 'at2', refresh_token: 'rt2', expires_in: 3600 }))

    const credential = await openAiCodexFlow.refresh(
      { type: 'oauth', refresh: 'rt1', access: 'at1', expires: Date.now() + 60_000 },
    )

    expect(credential).toMatchObject({ type: 'oauth', refresh: 'rt2', access: 'at2' })
    const call = fetch.mock.calls[0]
    if (call === undefined) throw new Error('expected a refresh call')
    const init = call[1] as RequestInit | undefined
    if (init === undefined) throw new Error('expected a refresh request init')
    const body = new URLSearchParams(init.body as string)
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe('rt1')
    expect(body.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann')
  })

  it('fails on an invalid device-code response', async () => {
    stubFetch().mockResolvedValueOnce(mockResponse(true, 200, { device_auth_id: 'da1' }))

    await expect(openAiCodexFlow.login(() => {}, new AbortController().signal))
      .rejects.toThrow('invalid device-code response')
  })

  it('fails when the token response lacks required fields', async () => {
    const fetch = stubFetch()
    fetch
      .mockResolvedValueOnce(mockResponse(true, 200, { device_auth_id: 'da1', user_code: 'ABCD-1234', interval: 1 }))
      .mockResolvedValueOnce(mockResponse(true, 200, { authorization_code: 'ac1', code_verifier: 'cv1' }))
      .mockResolvedValueOnce(mockResponse(true, 200, { access_token: 'at1' }))

    await expect(openAiCodexFlow.login(() => {}, new AbortController().signal))
      .rejects.toThrow('token response missing fields')
  })
})
