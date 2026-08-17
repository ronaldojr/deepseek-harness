/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-llm-oauth`.
 * @module @deepseek-ai/dsh-llm-oauth/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-llm-oauth'

/** Cordis companion plugin name. */
export const name = 'llm-oauth-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Install the event-lifecycle contract: `oauth/state` is a live-service
 * projection, so it can only fire while an llm-oauth service is mounted — an
 * emission after disposal means a login or refresh leaked work past its
 * teardown quiescence.
 */
const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure) => {
  ctx.on('oauth/state', (view) => {
    if (ctx.get('oauth') === undefined) {
      fail(`oauth/state for "${view.provider}" emitted without a live llm-oauth service`)
    }
  })
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
