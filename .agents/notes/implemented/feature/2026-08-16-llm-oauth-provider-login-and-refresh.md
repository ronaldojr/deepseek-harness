# Agent Note: OAuth provider login with background token refresh (llm-oauth)

Status: implemented

English | [中文](2026-08-16-llm-oauth-provider-login-and-refresh.zh.md)

## Problem

Subscription-authenticated LLM providers have no API key to paste. GitHub Copilot authenticates through an OAuth device flow whose access token expires in ~30 minutes, so the Models page's key-only card could not connect it at all, and any token obtained outside the harness went stale within half an hour. pi-ai ships the flow (`githubCopilotOAuth`), but its `login` also runs an "enable every model" policy burst and a `/models` availability fetch whose rate-limit footprint can reject a login that already obtained its token (observed: `429 Too Many Requests` after device authorization completed), and `llm-pi-ai` deliberately builds `Models` without a credential store, so nothing in the harness ran login or refresh.

## Decision

**A new host service, `packages/llm/llm-oauth`.** `ctx.oauth` owns one provider connection end to end: a device-flow login driven over a forwarded `oauth/state` Cordis event, a durable owner-only store (`$DSH_HOME/oauth-credentials.json`, written through `dsh-atomic-write`), a background scan that re-mints tokens due within `refreshAheadMs` and publishes them into the **credentials seam** under the provider's reference, and a disconnect path. Publishing through the credentials seam keeps `llm-pi-ai`'s request path unchanged: the adapter resolves an API key exactly as before; the plugin just keeps that key fresh. On connect the service also records `apiKeyEnv` and `baseURL` on the profile when no layer pinned them, so a fresh connect needs no manual step. On boot it republishes every stored token, and a flow registered later republishes its own stored credential.

**Hand-rolled exchange, upstream `toAuth`.** The GitHub Copilot flow implements the two GitHub endpoints directly (device-code + `/copilot_internal/v2/token`) instead of pi-ai's `login`/`refresh`, whose policy-burst tail is the failure mode above; base-URL derivation from the token's `proxy-ep` claim stays upstream in pi-ai's `toAuth`. The OpenAI Codex (ChatGPT) flow ships beside it in the same shape; its protocol facts live in the [OpenAI Codex OAuth note](2026-08-18-openai-codex-chatgpt-oauth-login.md). The flow interface (`login`/`refresh`/`toAuth`) is the runtime extension point: `ctx.oauth.registerFlow(flow)`.

**Typert Remote `oauth`.** The service is a `TypertRemoteService` (`status`/`login`/`cancel`/`disconnect`); the generated `oauth.*` namespace mounts in the api-remotes client assembly, `oauth/state` joins `API_REMOTE_FORWARDED_EVENTS`, and the payload vocabulary re-exports through `@deepseek-ai/dsh-api-remotes/client`.

**Models page connect block.** `LlmConfigurableProvider` gains an `oauth` fact (`catalogProvider(provider)?.auth.oauth !== undefined`), carried through apiproxy's `ConfigurableProviderView`. `ui-settings-models` renders an `OauthConnectBlock` (sign-in button, device-code panel with copy buttons, live states, disconnect) for providers with the fact, fed by an `OauthViewStore` over `ctx.remote.oauth` — the client plugin injects the `remote.oauth` namespace itself, the same pattern `ui-commands` uses for `remote.commands`. A missing oauth face degrades to an inert stub so compositions without the service render unchanged.

**Teardown quiescence.** The teardown effect sets a `closed` flag before aborting in-flight logins; `emitView` drops post-disposal emissions, which the package's invariant companion (`oauth/state` requires a live service) now pins.

## Alternatives considered

**Wiring pi-ai's `Models` credential store through a seam.** The library's designed path (store-driven refresh, per-credential baseUrl, model filtering by `availableModelIds`). Rejected: it reverses `llm-pi-ai`'s reviewed decision that `Models` never holds a credential store, and the api-key override path already reaches the same wire result.

**pi-ai's `login` as-is.** Rejected for the policy-burst tail; a successful device authorization could still throw and lose the credential.

**A generic settings-page section for OAuth state.** Rejected: the connect affordance belongs on the provider card beside the key field, where the connection is made and judged.

## Consequences

`dsh web` compositions can mount the service (`storePath: !!js dshHomePath('oauth-credentials.json')`); the Models page offers the connect block — "Connect GitHub" and "Connect OpenAI (ChatGPT Plus/Pro)" — for every OAuth-capable catalog provider, and connected providers refresh without user action until the authorization itself expires (~hours for GitHub), which surfaces as the `failed` phase. The store is service-owned JSON, not user-editable configuration. Enterprise GitHub domains and per-account model-policy enabling remain deferred.
