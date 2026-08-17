/**
 * Client-side view store for the llm-oauth service: per-provider connection
 * states fed by `oauth/state` pushes, with status/login/cancel/disconnect
 * actions over the `ctx.remote.oauth` Remote.
 * @module dsh-client-ui-settings-models/client/oauth-store
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { OauthConnectionView } from '@deepseek-ai/dsh-api-remotes/client'

/** The surface consumers and test doubles implement against. */
export interface OauthView {
  /** Subscribe to view changes; returns the unsubscriber. */
  subscribe(listener: () => void): () => void
  /** The last published view for one provider, or undefined before the first answer. */
  get(provider: string): OauthConnectionView | undefined
  /** Refetch one provider's state from the host. */
  load(provider: string): Promise<void>
  /** Start the device-flow login; resolves with a failure message or undefined. */
  login(provider: string): Promise<string | undefined>
  /** Cancel one in-flight login. */
  cancel(provider: string): Promise<void>
  /** Remove the provider's stored connection. */
  disconnect(provider: string): Promise<string | undefined>
  /** Publish one view — pushed by the host or fetched through `load`. */
  publish(view: OauthConnectionView): void
}

/** Live connection state for one provider plus the Remote actions that move it. */
export class OauthViewStore implements OauthView {
  private readonly views = new Map<string, OauthConnectionView>()
  private readonly listeners = new Set<() => void>()
  private readonly ctx: ClientContext

  /**
   * @param ctx - client root carrying the mounted `oauth` Remote.
   */
  constructor(ctx: ClientContext) {
    this.ctx = ctx
  }

  /** Subscribe to view changes; returns the unsubscriber. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** The last published view for one provider, or undefined before the first answer. */
  get(provider: string): OauthConnectionView | undefined {
    return this.views.get(provider)
  }

  /** Refetch one provider's state from the host. */
  async load(provider: string): Promise<void> {
    const result = await this.ctx.remote.oauth.status({ provider })
    if (result.ok && result.value.ok) this.publish(result.value.value)
  }

  /** Start the device-flow login; resolves with a failure message or undefined. */
  async login(provider: string): Promise<string | undefined> {
    const result = await this.ctx.remote.oauth.login({ provider })
    if (!result.ok) return result.error.message
    return result.value.ok ? undefined : result.value.error.message
  }

  /** Cancel one in-flight login. */
  async cancel(provider: string): Promise<void> {
    await this.ctx.remote.oauth.cancel({ provider })
  }

  /** Remove the provider's stored connection. */
  async disconnect(provider: string): Promise<string | undefined> {
    const result = await this.ctx.remote.oauth.disconnect({ provider })
    if (!result.ok) return result.error.message
    return result.value.ok ? undefined : result.value.error.message
  }

  /** Publish one view — pushed by the host or fetched through `load`. */
  publish(view: OauthConnectionView): void {
    this.views.set(view.provider, view)
    for (const listener of this.listeners) listener()
  }
}
