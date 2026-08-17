/**
 * Plugin entry: mount the OAuth service on `ctx.oauth`. The service is a
 * Typert Remote, so the generated descriptor serves the `oauth` namespace
 * once a Remote-serving host mounts this plugin.
 * @module @deepseek-ai/dsh-llm-oauth
 */

import type { Context } from '@deepseek-ai/cordis'
import { LlmOauthService } from './service.ts'
import type { Config } from './service.ts'

export { LlmOauthService } from './service.ts'
export { githubCopilotFlow, isOauthRefreshRejected } from './github-copilot.ts'
export type { Config, OauthFlow, OauthLoginEvent } from './service.ts'
export type * from './types.ts'

/**
 * Mount the OAuth service.
 * @param ctx - Host context carrying the credentials and settings seams.
 * @param config - store path, provider selection, and refresh policy.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.plugin(LlmOauthService, config)
}

export default apply
