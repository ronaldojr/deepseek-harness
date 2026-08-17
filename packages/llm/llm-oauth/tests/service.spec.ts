/**
 * LlmOauthService behavior suite over in-memory seams and a scripted flow:
 * login lifecycle and device-code events, credential-seam publication,
 * settings profile recording, refresh scanning, disconnect, and store
 * round-trips.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { ModelAuth, OAuthCredential } from '@earendil-works/pi-ai'
import { LlmOauthService } from '../src/index.ts'
import type { Config, OauthFlow, OauthLoginEvent } from '../src/index.ts'
import type { OauthConnectionView } from '../src/types.ts'
import { MemoryCredentials, MemorySettings } from './memory.ts'

/** Provider route key the scripted flow serves. */
const PROVIDER = 'fake'

/** Minimal llm-pi-ai profile shape the service records into. */
const LLM_PI_AI_SCHEMA = s.object({
  providers: s.dict(s.object({
    apiKeyEnv: s.string(),
    baseURL: s.string(),
  })),
})

/** Scripted OAuth flow: device-code emit, manual finish, counted refresh. */
class FakeFlow implements OauthFlow {
  provider = PROVIDER
  loginCalls = 0
  refreshCalls = 0
  refreshError: Error | undefined
  expiresInMs: number

  private resolveLogin: (() => void) | undefined

  constructor(options: { expiresInMs?: number } = {}) {
    this.expiresInMs = options.expiresInMs ?? 3600_000
  }

  login(notify: (event: OauthLoginEvent) => void, signal: AbortSignal): Promise<OAuthCredential> {
    this.loginCalls++
    notify({ type: 'device-code', verificationUri: 'https://github.com/login/device', userCode: 'ABCD-1234' })
    return new Promise((resolve, reject) => {
      const finish = (): void => { resolve(this.credentialOf('access-login')) }
      signal.addEventListener('abort', () => { reject(new Error('cancelled')) })
      this.resolveLogin = finish
    })
  }

  /** Complete the pending login. */
  finishLogin(): void {
    this.resolveLogin?.()
  }

  async refresh(_credential: OAuthCredential): Promise<OAuthCredential> {
    this.refreshCalls++
    if (this.refreshError !== undefined) throw this.refreshError
    return this.credentialOf('access-refresh')
  }

  async toAuth(credential: OAuthCredential): Promise<ModelAuth> {
    return { apiKey: credential.access, baseUrl: 'https://api.example.com' }
  }

  private credentialOf(access: string): OAuthCredential {
    return { type: 'oauth', refresh: 'refresh-token', access, expires: Date.now() + this.expiresInMs }
  }
}

interface Booted {
  ctx: Context
  service: LlmOauthService
  /** The service's plugin fiber: disposing it runs the interval teardown. */
  serviceFiber: { dispose: () => Promise<void> }
  flow: FakeFlow
  settings: MemorySettings
  events: OauthConnectionView[]
  storePath: string
}

/** Service fibers to dispose after each test. */
const active: Array<{ dispose: () => Promise<void> }> = []

/** Boot one service over memory seams with a scripted flow registered. */
async function boot(options: {
  config?: Partial<Config>
  seedSettings?: Record<string, unknown>
  flowOptions?: { expiresInMs?: number }
  storePath?: string
} = {}): Promise<Booted> {
  const storePath = options.storePath ?? join(mkdtempSync(join(tmpdir(), 'llm-oauth-')), 'oauth-credentials.json')
  const ctx = new Context()
  await ctx.plugin(MemoryCredentials)
  await ctx.plugin(MemorySettings, { ...(options.seedSettings === undefined ? {} : { doc: options.seedSettings }) })
  const settings = ctx.settings as MemorySettings
  ctx.settings.register(settingsNamespace('llm-pi-ai'), LLM_PI_AI_SCHEMA)
  const serviceFiber = await ctx.plugin(LlmOauthService, {
    storePath,
    providers: [],
    refreshIntervalMs: 60_000,
    ...options.config,
  }) as { dispose: () => Promise<void> }
  active.push(serviceFiber)
  const events: OauthConnectionView[] = []
  ctx.on('oauth/state', (view) => { events.push(view) })
  const flow = new FakeFlow(options.flowOptions)
  ctx.oauth.registerFlow(flow)
  return { ctx, service: ctx.oauth, serviceFiber, flow, settings, events, storePath }
}

afterEach(async () => {
  for (const entry of active.splice(0)) await entry.dispose()
})

/** Read the durable store document. */
function storeDocument(storePath: string): Record<string, OAuthCredential> {
  return JSON.parse(readFileSync(storePath, 'utf8')) as Record<string, OAuthCredential>
}

/** Wait until one event with the given phase was emitted. */
async function waitForPhase(events: readonly OauthConnectionView[], phase: string): Promise<void> {
  await vi.waitFor(() => {
    expect(events.some(event => event.phase === phase)).toBe(true)
  })
}

describe('llm-oauth service', () => {
  it('rejects a provider no flow serves', async () => {
    const { service } = await boot()
    await expect(service.status({ provider: 'unknown' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'provider-unknown' },
    })
    await expect(service.login({ provider: 'unknown' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'provider-unknown' },
    })
  })

  it('reports disconnected with the derived credential reference', async () => {
    const { service } = await boot()
    const result = await service.status({ provider: PROVIDER })
    expect(result).toEqual({
      ok: true,
      value: {
        provider: PROVIDER,
        phase: 'disconnected',
        credentialRef: 'FAKE_API_KEY',
        autoRefresh: false,
      },
    })
  })

  it('runs the login lifecycle and commits every artifact', async () => {
    const { ctx, service, flow, settings, events, storePath } = await boot()
    await expect(service.login({ provider: PROVIDER })).resolves.toEqual({ ok: true, value: { accepted: true } })
    // The login emits `connecting` first, then the device-code report.
    expect(events.at(-1)).toMatchObject({
      provider: PROVIDER,
      phase: 'device-code',
      device: { verificationUri: 'https://github.com/login/device', userCode: 'ABCD-1234' },
    })
    flow.finishLogin()
    await waitForPhase(events, 'connected')
    // The committed view carries the expiry and the refresher fact.
    const connected = events.find(event => event.phase === 'connected')
    expect(connected?.credentialRef).toBe('FAKE_API_KEY')
    expect(connected?.expiresAt).toBeGreaterThan(Date.now())
    // The durable store holds the credential.
    expect(storeDocument(storePath)[PROVIDER]).toMatchObject({ type: 'oauth', access: 'access-login' })
    // The credentials seam holds the minted bearer key under the derived reference.
    const resolved = await ctx.credentials.resolve(credentialRef('FAKE_API_KEY'))
    expect(resolved?.value).toBe('access-login')
    // The settings profile records the reference and the derived base URL.
    expect(settings.doc['llm-pi-ai']).toEqual({
      providers: { [PROVIDER]: { apiKeyEnv: 'FAKE_API_KEY', baseURL: 'https://api.example.com' } },
    })
  })

  it('treats a repeat login on a connected provider as an accepted no-op', async () => {
    const { service, flow, events } = await boot()
    await service.login({ provider: PROVIDER })
    flow.finishLogin()
    await waitForPhase(events, 'connected')
    await expect(service.login({ provider: PROVIDER })).resolves.toEqual({ ok: true, value: { accepted: true } })
    expect(flow.loginCalls).toBe(1)
  })

  it('rejects a login while one is in flight', async () => {
    const { service } = await boot()
    await service.login({ provider: PROVIDER })
    await expect(service.login({ provider: PROVIDER })).resolves.toMatchObject({
      ok: false,
      error: { code: 'login-in-flight' },
    })
  })

  it('cancels an in-flight login into the failed phase', async () => {
    const { service, events } = await boot()
    await service.login({ provider: PROVIDER })
    await expect(service.cancel({ provider: PROVIDER })).resolves.toEqual({ ok: true, value: { accepted: true } })
    await waitForPhase(events, 'failed')
    const failed = events.find(event => event.phase === 'failed')
    expect(failed?.message).toContain('cancelled')
  })

  it('re-mints a due token through the refresh scan', async () => {
    const { ctx, service, flow, events } = await boot({
      config: { refreshAheadMs: 60_000 },
      flowOptions: { expiresInMs: 1000 },
    })
    await service.login({ provider: PROVIDER })
    flow.finishLogin()
    await waitForPhase(events, 'connected')
    service.scanRefresh()
    await vi.waitFor(() => { expect(flow.refreshCalls).toBe(1) })
    await vi.waitFor(async () => {
      const resolved = await ctx.credentials.resolve(credentialRef('FAKE_API_KEY'))
      expect(resolved?.value).toBe('access-refresh')
    })
  })

  it('records a refresh failure and keeps the last token', async () => {
    const { ctx, service, flow, events } = await boot({
      config: { refreshAheadMs: 60_000 },
      flowOptions: { expiresInMs: 1000 },
    })
    await service.login({ provider: PROVIDER })
    flow.finishLogin()
    await waitForPhase(events, 'connected')
    flow.refreshError = new Error('upstream exploded')
    service.scanRefresh()
    await vi.waitFor(() => { expect(flow.refreshCalls).toBe(1) })
    const connected = events.filter(event => event.phase === 'connected').at(-1)
    expect(connected?.message).toContain('upstream exploded')
    const resolved = await ctx.credentials.resolve(credentialRef('FAKE_API_KEY'))
    expect(resolved?.value).toBe('access-login')
  })

  it('disconnects: store entry, credential, and view all reset', async () => {
    const { ctx, service, flow, events, storePath } = await boot()
    await service.login({ provider: PROVIDER })
    flow.finishLogin()
    await waitForPhase(events, 'connected')
    await expect(service.disconnect({ provider: PROVIDER })).resolves.toEqual({ ok: true, value: { accepted: true } })
    expect(storeDocument(storePath)[PROVIDER]).toBeUndefined()
    await expect(ctx.credentials.resolve(credentialRef('FAKE_API_KEY'))).resolves.toBeUndefined()
    const last = events.at(-1)
    expect(last?.phase).toBe('disconnected')
  })

  it('republishes a stored token at boot', async () => {
    const first = await boot()
    await first.service.login({ provider: PROVIDER })
    first.flow.finishLogin()
    await waitForPhase(first.events, 'connected')
    const storePath = first.storePath
    await first.serviceFiber.dispose()
    active.length = 0

    // A fresh service over the same durable store republishes the stored
    // bearer key into the credentials seam once its flow registers — the
    // flow's arrival immediately projects the stored connection.
    const second = await boot({ storePath })
    await vi.waitFor(async () => {
      const resolved = await second.ctx.credentials.resolve(credentialRef('FAKE_API_KEY'))
      expect(resolved?.value).toBe('access-login')
    })
    expect(second.events.some(event => event.phase === 'connected')).toBe(true)
  })

  it('starts disconnected when the store file is invalid', async () => {
    const storePath = join(mkdtempSync(join(tmpdir(), 'llm-oauth-')), 'oauth-credentials.json')
    writeFileSync(storePath, '{not json', 'utf8')
    // The invalid file never throws: the service warns and starts empty.
    const booted = await boot({ storePath })
    await expect(booted.service.status({ provider: PROVIDER })).resolves.toMatchObject({
      ok: true,
      value: { phase: 'disconnected' },
    })
  })
})
