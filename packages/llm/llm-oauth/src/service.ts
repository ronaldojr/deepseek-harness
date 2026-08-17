/**
 * OAuth login, durable credential storage, and background token refresh for
 * LLM providers that authenticate by subscription rather than API key.
 *
 * The service owns the full lifecycle for each provider with a registered
 * flow: a device-flow login driven over the `oauth/state` event, credential
 * persistence under an owner-only store file, a background refresher that
 * re-mints the short-lived access token before expiry and publishes it into
 * the credentials seam (so the request path of a consuming LLM adapter stays
 * unchanged), and a disconnect path that removes both. The GitHub Copilot
 * flow ships built in; other providers register their flow at runtime.
 * @module @deepseek-ai/dsh-llm-oauth
 */

import { readFile } from 'node:fs/promises'
import { Context, Service } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { SettingsNamespace, SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { ModelAuth, OAuthCredential } from '@earendil-works/pi-ai'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { githubCopilotFlow, isOauthRefreshRejected } from './github-copilot.ts'
import type {
  OauthAccepted,
  OauthConnectionView,
  OauthDeviceCode,
  OauthErrorCode,
  OauthFailure,
  OauthProviderRequest,
  OauthResult,
} from './types.ts'

/** One provider's OAuth flow: login, refresh, and per-request auth derivation. */
export interface OauthFlow {
  /** Provider route key this flow serves. */
  provider: string
  /**
   * Run the interactive login and resolve with the stored credential. Reports
   * progress through `notify` — one `device-code` event carries the URL and
   * code the user must authorize. `signal` aborts a pending flow.
   */
  login(notify: (event: OauthLoginEvent) => void, signal: AbortSignal): Promise<OAuthCredential>
  /** Exchange the stored credential's refresh material for a fresh one. */
  refresh(credential: OAuthCredential, signal?: AbortSignal): Promise<OAuthCredential>
  /** Derive per-request auth (bearer key, derived base URL) from a valid credential. */
  toAuth(credential: OAuthCredential): Promise<ModelAuth>
}

/** One login progress report a flow sends through its `notify` callback. */
export type OauthLoginEvent =
  | { type: 'device-code'; verificationUri: string; userCode: string }
  | { type: 'connecting'; message: string }

/** Deploy-time tunables; every field except `storePath` has a schema default. */
export interface Config {
  /** Absolute or harness-home-relative path of the durable credential store file. */
  storePath: string
  /** Provider route keys whose built-in flows activate. */
  providers?: string[]
  /** Credential-reference overrides by provider; absent derives `<PROVIDER>_API_KEY`. */
  credentialRefs?: Record<string, string>
  /** Cadence of the background refresh scan. */
  refreshIntervalMs?: number
  /** How early before expiry a refresh is due. */
  refreshAheadMs?: number
  /** Guard that cancels a login whose browser authorization never arrives. */
  loginTimeoutMs?: number
  /** Settings namespace whose provider profiles record the connection (apiKeyEnv, baseURL). */
  settingsNs?: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    oauth: LlmOauthService
  }
}

/** The flows this package ships; keyed by provider route id. */
const BUILTIN_FLOWS = new Map<string, OauthFlow>([[githubCopilotFlow.provider, githubCopilotFlow]])

/** One in-flight login's surface state. */
type OauthLoginState =
  | { phase: 'connecting'; message?: string }
  | { phase: 'device-code'; device: OauthDeviceCode }
  | { phase: 'failed'; message: string }

/**
 * OAuth service. Remote methods `status`/`login`/`cancel`/`disconnect` form
 * the `oauth` namespace the Typert gateway serves to browser clients.
 */
export class LlmOauthService extends TypertRemoteService {
  static inject = ['credentials', 'settings']

  static Config: s<Config> = s.object({
    storePath: s.string().required(),
    providers: s.array(s.string()).default(['github-copilot']),
    credentialRefs: s.dict(s.string()).default({}),
    refreshIntervalMs: s.number().min(1000).default(60_000),
    refreshAheadMs: s.number().min(1000).default(5 * 60_000),
    loginTimeoutMs: s.number().min(1000).default(15 * 60_000),
    settingsNs: s.string().default('llm-pi-ai'),
  })

  private readonly flows = new Map<string, OauthFlow>()
  private readonly storePath: string
  private readonly credentialRefs: Record<string, string>
  private readonly refreshIntervalMs: number
  private readonly refreshAheadMs: number
  private readonly loginTimeoutMs: number
  private readonly settingsNs: SettingsNamespace

  private store: Record<string, OAuthCredential> = {}
  private readonly loginStates = new Map<string, OauthLoginState>()
  private readonly failures = new Map<string, string>()
  private readonly logins = new Map<string, AbortController>()
  private readonly refreshTails = new Map<string, Promise<void>>()
  private timer: ReturnType<typeof setInterval> | undefined
  /** Set by the teardown effect: no projection may emit past this point. */
  private closed = false

  /**
   * @param ctx - Host context carrying the credentials and settings seams.
   * @param config - Store path, provider selection, and refresh policy.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'oauth')
    this.storePath = config.storePath
    if (this.storePath.trim().length === 0) {
      throw new TypeError('llm-oauth: storePath must be a non-blank path')
    }
    this.credentialRefs = { ...config.credentialRefs }
    this.refreshIntervalMs = config.refreshIntervalMs ?? 60_000
    this.refreshAheadMs = config.refreshAheadMs ?? 5 * 60_000
    this.loginTimeoutMs = config.loginTimeoutMs ?? 15 * 60_000
    this.settingsNs = (config.settingsNs ?? 'llm-pi-ai') as SettingsNamespace
    for (const provider of config.providers ?? ['github-copilot']) {
      const flow = BUILTIN_FLOWS.get(provider)
      if (flow === undefined) {
        throw new Error(`llm-oauth: provider "${provider}" has no built-in OAuth flow`)
      }
      this.flows.set(provider, flow)
    }
  }

  /**
   * Load the durable store, republish every stored access token into the
   * credentials seam, and start the background refresh scan.
   */
  protected async [Service.init](): Promise<void> {
    await this.loadStoreUnlocked()
    for (const [provider, credential] of Object.entries(this.store)) {
      const flow = this.flows.get(provider)
      if (flow === undefined) continue
      void this.republishStored(provider, flow, credential)
    }
    this.scanRefresh()
    this.timer = setInterval(() => { this.scanRefresh() }, this.refreshIntervalMs)
    this.ctx.effect(() => () => {
      this.closed = true
      if (this.timer !== undefined) clearInterval(this.timer)
      for (const login of this.logins.values()) login.abort()
    }, 'llm-oauth.teardown')
  }

  /**
   * Register one provider's flow at runtime — the extension point for
   * providers this package does not ship.
   * @param flow - the flow to register.
   * @returns a disposer removing the flow.
   */
  registerFlow(flow: OauthFlow): () => void {
    if (this.flows.has(flow.provider)) {
      throw new Error(`llm-oauth: provider "${flow.provider}" already has a flow`)
    }
    this.flows.set(flow.provider, flow)
    // A flow arriving after boot still owns its stored credential: republish
    // the bearer key so the consuming adapter resolves it without a refresh.
    const credential = this.store[flow.provider]
    if (credential !== undefined) void this.republishStored(flow.provider, flow, credential)
    this.emitView(flow.provider)
    return () => {
      this.flows.delete(flow.provider)
      this.emitView(flow.provider)
    }
  }

  /** Republish one stored credential's bearer key into the credentials seam. */
  private async republishStored(provider: string, flow: OauthFlow, credential: OAuthCredential): Promise<void> {
    try {
      const auth = await flow.toAuth(credential)
      if (auth.apiKey !== undefined) await this.ctx.credentials.set(this.refFor(provider), auth.apiKey)
    } catch (error) {
      this.ctx.logger.warn('llm-oauth: could not republish the stored token for provider "%s"', provider)
      this.ctx.logger.warn(error)
    }
  }

  /**
   * Report one provider's connection state.
   * @param request - provider route key.
   * @returns the provider's current view, or `provider-unknown`.
   */
  @Remote('status')
  status(request: OauthProviderRequest): Promise<OauthResult<OauthConnectionView>> {
    const { provider } = request
    if (!this.flows.has(provider)) {
      return Promise.resolve(this.fail('provider-unknown', `oauth: no flow serves provider "${provider}"`))
    }
    return Promise.resolve({ ok: true, value: this.viewOf(provider) })
  }

  /**
   * Start the provider's device-flow login. Progress flows through the
   * `oauth/state` event; the method itself only acknowledges admission.
   * @param request - provider route key.
   * @returns accepted, or a business rejection.
   */
  @Remote('login')
  login(request: OauthProviderRequest): Promise<OauthResult<OauthAccepted>> {
    const { provider } = request
    const flow = this.flows.get(provider)
    if (flow === undefined) {
      return Promise.resolve(this.fail('provider-unknown', `oauth: no flow serves provider "${provider}"`))
    }
    if (this.logins.has(provider)) {
      return Promise.resolve(this.fail('login-in-flight', `oauth: a login for provider "${provider}" is already running`))
    }
    // A connected provider is already logged in; repeating the call is a no-op.
    if (this.store[provider] === undefined) this.startLogin(provider, flow)
    return Promise.resolve({ ok: true, value: { accepted: true } })
  }

  /**
   * Cancel one in-flight login.
   * @param request - provider route key.
   * @returns accepted.
   */
  @Remote('cancel')
  cancel(request: OauthProviderRequest): Promise<OauthResult<OauthAccepted>> {
    const { provider } = request
    if (!this.flows.has(provider)) {
      return Promise.resolve(this.fail('provider-unknown', `oauth: no flow serves provider "${provider}"`))
    }
    const login = this.logins.get(provider)
    if (login !== undefined) login.abort()
    return Promise.resolve({ ok: true, value: { accepted: true } })
  }

  /**
   * Remove the provider's stored credential and unset its credential
   * reference. Settings profile fields are left untouched.
   * @param request - provider route key.
   * @returns accepted.
   */
  @Remote('disconnect')
  async disconnect(request: OauthProviderRequest): Promise<OauthResult<OauthAccepted>> {
    const { provider } = request
    if (!this.flows.has(provider)) {
      return this.fail('provider-unknown', `oauth: no flow serves provider "${provider}"`)
    }
    const login = this.logins.get(provider)
    if (login !== undefined) login.abort()
    this.loginStates.delete(provider)
    this.failures.delete(provider)
    if (this.store[provider] !== undefined) await this.removeCredential(provider)
    this.emitView(provider)
    return { ok: true, value: { accepted: true } }
  }

  /** Start one provider's login and keep the view current through `oauth/state`. */
  private startLogin(provider: string, flow: OauthFlow): void {
    const controller = new AbortController()
    this.logins.set(provider, controller)
    this.failures.delete(provider)
    this.loginStates.set(provider, { phase: 'connecting' })
    this.emitView(provider)
    const timeout = setTimeout(() => { controller.abort() }, this.loginTimeoutMs)
    void flow.login(
      (event) => { this.onLoginEvent(provider, event) },
      controller.signal,
    ).then(async (credential) => {
      await this.commitCredential(provider, flow, credential, true)
      this.loginStates.delete(provider)
      this.emitView(provider)
    }).catch((error: unknown) => {
      const message = controller.signal.aborted
        ? 'Login cancelled'
        : error instanceof Error ? error.message : String(error)
      this.failures.set(provider, message)
      this.loginStates.set(provider, { phase: 'failed', message })
      this.ctx.logger.warn('llm-oauth: login failed for provider "%s"', provider)
      this.ctx.logger.warn(error)
      this.emitView(provider)
    }).finally(() => {
      clearTimeout(timeout)
      this.logins.delete(provider)
    })
  }

  /** Fold one flow progress report into the provider's view. */
  private onLoginEvent(provider: string, event: OauthLoginEvent): void {
    if (event.type === 'device-code') {
      this.loginStates.set(provider, {
        phase: 'device-code',
        device: { verificationUri: event.verificationUri, userCode: event.userCode },
      })
    } else {
      this.loginStates.set(provider, { phase: 'connecting', message: event.message })
    }
    this.emitView(provider)
  }

  /**
   * Persist one credential and publish its derived bearer key: the store file
   * commit, the credentials seam write, and — for a fresh login — the
   * settings profile fields that make the consuming adapter resolve that key.
   */
  private async commitCredential(
    provider: string,
    flow: OauthFlow,
    credential: OAuthCredential,
    touchSettings: boolean,
  ): Promise<void> {
    const auth = await flow.toAuth(credential)
    if (auth.apiKey === undefined || auth.apiKey.length === 0) {
      throw new Error(`llm-oauth: provider "${provider}" toAuth produced no bearer key`)
    }
    await withFileLock(this.storePath, async () => {
      await this.loadStoreUnlocked()
      this.store[provider] = credential
      await this.persistUnlocked()
    })
    const ref = this.refFor(provider)
    await this.ctx.credentials.set(ref, auth.apiKey)
    if (touchSettings) await this.ensureProfileAuth(provider, ref, auth.baseUrl)
  }

  /** Remove one provider's credential and reference. */
  private async removeCredential(provider: string): Promise<void> {
    await withFileLock(this.storePath, async () => {
      await this.loadStoreUnlocked()
      this.store = Object.fromEntries(
        Object.entries(this.store).filter(([key]) => key !== provider),
      )
      await this.persistUnlocked()
    })
    try {
      await this.ctx.credentials.unset(this.refFor(provider))
    } catch (error) {
      this.ctx.logger.warn('llm-oauth: could not unset the credential for provider "%s"', provider)
      this.ctx.logger.warn(error)
    }
  }

  /**
   * Run one refresh scan now: every stored provider whose token is due (its
   * expiry within {@link Config.refreshAheadMs}) gets one serialized refresh.
   * The interval timer calls this; tests and operators may call it directly.
   */
  scanRefresh(): void {
    const now = Date.now()
    for (const [provider, credential] of Object.entries(this.store)) {
      if (credential.expires - now > this.refreshAheadMs) continue
      if (this.loginStates.has(provider)) continue
      void this.refreshProvider(provider)
    }
  }

  /** Re-mint one provider's access token, serialized behind its prior refresh. */
  private refreshProvider(provider: string): Promise<void> {
    const previous = this.refreshTails.get(provider) ?? Promise.resolve()
    const run = previous.then(async () => {
      const flow = this.flows.get(provider)
      const credential = this.store[provider]
      if (flow === undefined || credential === undefined) return
      try {
        const refreshed = await flow.refresh(credential)
        await this.commitCredential(provider, flow, refreshed, false)
        this.failures.delete(provider)
        this.emitView(provider)
      } catch (error) {
        this.failures.set(provider, isOauthRefreshRejected(error)
          ? 'The GitHub authorization expired — reconnect to keep using this provider'
          : error instanceof Error ? error.message : String(error))
        this.ctx.logger.warn('llm-oauth: background refresh failed for provider "%s"', provider)
        this.ctx.logger.warn(error)
        this.emitView(provider)
      }
    })
    const tail = run.then(() => undefined, () => undefined)
    this.refreshTails.set(provider, tail)
    return run
  }

  /**
   * Record the connection on the consuming adapter's profile: name the
   * credential reference (when no layer named one) and pin the derived base
   * URL (when none is pinned), so a fresh connect works with no manual step.
   */
  private async ensureProfileAuth(provider: string, ref: CredentialRef, baseUrl: string | undefined): Promise<void> {
    try {
      const section = this.ctx.settings.get(this.settingsNs) as
        | { providers?: Record<string, { apiKeyEnv?: unknown; baseURL?: unknown }> }
        | undefined
      const profile = section?.providers?.[provider]
      const ops: SettingsPathOp[] = []
      const base = ['providers', provider]
      if (profile === undefined) ops.push({ op: 'set', path: base, value: {} })
      if (profile === undefined || typeof profile.apiKeyEnv !== 'string' || profile.apiKeyEnv.length === 0) {
        ops.push({ op: 'set', path: [...base, 'apiKeyEnv'], value: ref })
      }
      if (baseUrl !== undefined
        && (profile === undefined || typeof profile.baseURL !== 'string' || profile.baseURL.length === 0)) {
        ops.push({ op: 'set', path: [...base, 'baseURL'], value: baseUrl })
      }
      if (ops.length > 0) await this.ctx.settings.mutate(this.settingsNs, ops)
    } catch (error) {
      this.ctx.logger.warn('llm-oauth: could not record the connection in settings for provider "%s"', provider)
      this.ctx.logger.warn(error)
    }
  }

  /** The credential reference one provider publishes refreshed tokens into. */
  private refFor(provider: string): CredentialRef {
    const configured = this.credentialRefs[provider]
    if (configured !== undefined && configured.length > 0) return credentialRef(configured)
    return credentialRef(`${provider.replaceAll('-', '_').toUpperCase()}_API_KEY`)
  }

  /** The current surface view, joining login state, stored state, and failures. */
  private viewOf(provider: string): OauthConnectionView {
    const ref = this.refFor(provider)
    const loginState = this.loginStates.get(provider)
    if (loginState !== undefined) {
      if (loginState.phase === 'device-code') {
        return { provider, phase: 'device-code', device: loginState.device, credentialRef: ref, autoRefresh: false }
      }
      if (loginState.phase === 'failed') {
        return { provider, phase: 'failed', message: loginState.message, credentialRef: ref, autoRefresh: false }
      }
      return {
        provider,
        phase: 'connecting',
        ...(loginState.message === undefined ? {} : { message: loginState.message }),
        credentialRef: ref,
        autoRefresh: false,
      }
    }
    const stored = this.store[provider]
    const failure = this.failures.get(provider)
    if (stored !== undefined) {
      return {
        provider,
        phase: 'connected',
        ...(failure === undefined ? {} : { message: failure }),
        expiresAt: stored.expires,
        credentialRef: ref,
        autoRefresh: this.timer !== undefined,
      }
    }
    if (failure !== undefined) {
      return { provider, phase: 'failed', message: failure, credentialRef: ref, autoRefresh: false }
    }
    return { provider, phase: 'disconnected', credentialRef: ref, autoRefresh: false }
  }

  /** Emit one provider's current view as the forwarded `oauth/state` event. */
  private emitView(provider: string): void {
    // A login or refresh settled by the teardown's abort must not project a
    // state after the service left the context.
    if (this.closed) return
    this.ctx.emit('oauth/state', this.viewOf(provider))
  }

  /** One business rejection. */
  private fail(code: OauthErrorCode, message: string): OauthResult<never> {
    return { ok: false, error: { code, message } }
  }

  /** Read the store file into {@link store}; an absent or invalid file starts empty. */
  private async loadStoreUnlocked(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.storePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.store = {}
        return
      }
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      this.ctx.logger.warn('llm-oauth: store file "%s" is not valid JSON; starting with an empty store', this.storePath)
      this.ctx.logger.warn(error)
      this.store = {}
      return
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      this.ctx.logger.warn('llm-oauth: store file "%s" has an invalid root; starting with an empty store', this.storePath)
      this.store = {}
      return
    }
    const store: Record<string, OAuthCredential> = {}
    for (const [provider, value] of Object.entries(parsed as Record<string, unknown>)) {
      const credential = value as Partial<OAuthCredential> | null | undefined
      if (value === null || typeof value !== 'object' || credential?.type !== 'oauth'
        || typeof credential.refresh !== 'string' || credential.refresh.length === 0
        || typeof credential.access !== 'string' || credential.access.length === 0
        || typeof credential.expires !== 'number') {
        this.ctx.logger.warn('llm-oauth: skipping invalid store entry for provider "%s"', provider)
        continue
      }
      store[provider] = {
        type: 'oauth',
        refresh: credential.refresh,
        access: credential.access,
        expires: credential.expires,
      }
    }
    this.store = store
  }

  /** Atomically replace the store file, owner-only. */
  private async persistUnlocked(): Promise<void> {
    await writeFileAtomic(this.storePath, `${JSON.stringify(this.store, null, 2)}\n`, {
      mode: 0o600,
      dirMode: 0o700,
    })
  }
}

export type { OauthFailure }
export default LlmOauthService
