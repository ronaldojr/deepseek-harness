/**
 * Client-safe type surface of the llm-oauth service: connection views, the
 * `oauth/state` Cordis event, and the Remote request/result vocabulary. Types
 * only — no runtime code — so a Client compilation face reads exactly the
 * signature the Host emits.
 * @module @deepseek-ai/dsh-llm-oauth/types
 */

import type { CredentialRef } from '@deepseek-ai/dsh-credentials'

/** One provider connection's lifecycle phase. */
export type OauthPhase =
  | 'disconnected'
  | 'connecting'
  | 'device-code'
  | 'connected'
  | 'failed'

/** Device-flow facts the connecting surface shows while phase is `device-code`. */
export interface OauthDeviceCode {
  /** URL the user opens in a browser. */
  verificationUri: string
  /** Code the user enters there. */
  userCode: string
}

/** One provider's connection state, as both an RPC answer and an event payload. */
export interface OauthConnectionView {
  /** Provider route key this view describes. */
  provider: string
  /** Current lifecycle phase. */
  phase: OauthPhase
  /** Device-flow facts; present only while {@link phase} is `device-code`. */
  device?: OauthDeviceCode
  /**
   * Human-readable state message. Present for `connecting`, `failed`, and a
   * `connected` provider whose background refresh failed.
   */
  message?: string
  /** Epoch millis the stored access token expires; present only while `connected`. */
  expiresAt?: number
  /** Reference the service writes refreshed access tokens into. */
  credentialRef?: CredentialRef
  /** Human name the connect surface labels this provider with, from the catalog's OAuth method when present. */
  name?: string
  /** Whether the background refresher is scheduled for this provider. */
  autoRefresh: boolean
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * A provider connection moved to a new lifecycle phase (device code
     * ready, connected, failed, disconnected). The payload is the full
     * post-transition view, so a consumer never needs to join this event
     * against a query.
     * @param view - the provider's new connection state.
     * @mode emit
     */
    'oauth/state'(view: OauthConnectionView): void
  }
}

/** One provider-scoped Remote request. */
export interface OauthProviderRequest {
  /** Provider route key the request addresses. */
  provider: string
}

/** Business rejection codes one Remote method may return. */
export type OauthErrorCode =
  | 'provider-unknown'
  | 'provider-no-oauth'
  | 'login-in-flight'
  | 'not-connected'
  | 'login-failed'

/** One business rejection. */
export interface OauthFailure {
  code: OauthErrorCode
  message: string
}

/** Result union every Remote method answers with. */
export type OauthResult<T> = { ok: true; value: T } | { ok: false; error: OauthFailure }

/** Accepted acknowledgement shared by login, cancel, and disconnect. */
export interface OauthAccepted {
  accepted: true
}
