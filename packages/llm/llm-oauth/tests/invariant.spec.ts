/**
 * Invariant companion suite: `oauth/state` is a live-service projection, so
 * it must only fire while an llm-oauth service is mounted.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { LlmOauthService } from '../src/index.ts'
import type { OauthConnectionView } from '../src/types.ts'
import * as LlmOauthInvariant from '../src/invariant.ts'
import { MemoryCredentials, MemorySettings } from './memory.ts'

const VIEW: OauthConnectionView = { provider: 'github-copilot', phase: 'disconnected', autoRefresh: false }

describe('llm-oauth invariant companion', () => {
  it('accepts a state event emitted by a live service', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(LlmOauthInvariant)
    await ctx.plugin(MemoryCredentials)
    await ctx.plugin(MemorySettings)
    const storePath = join(mkdtempSync(join(tmpdir(), 'llm-oauth-')), 'oauth-credentials.json')
    await ctx.plugin(LlmOauthService, { storePath, providers: [] })

    expect(() => { ctx.emit('oauth/state', VIEW) }).not.toThrow()
  })

  it('fails a state event emitted without a live service', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(LlmOauthInvariant)

    expect(() => { ctx.emit('oauth/state', VIEW) }).toThrow(/invariant violated by "@deepseek-ai\/dsh-llm-oauth"/)
  })

  it('reserves the package name against duplicate registration', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(LlmOauthInvariant)

    expect(() => {
      ctx.invariants.register('@deepseek-ai/dsh-llm-oauth', () => {})
    }).toThrow(/already registered/)
  })
})
