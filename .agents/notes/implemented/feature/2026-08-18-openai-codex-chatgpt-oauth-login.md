# Agent Note: OpenAI Codex (ChatGPT) OAuth login and the OAuth-only directory offer

Status: implemented

English | [中文](2026-08-18-openai-codex-chatgpt-oauth-login.zh.md)

## Problem

ChatGPT Plus/Pro subscription models (`gpt-5.4`, `gpt-5.5`, `gpt-5.6-*`) authenticate through the subscription's OAuth, not an API key. The harness had the generic machinery — the [llm-oauth service](../../implemented/feature/2026-08-16-llm-oauth-provider-login-and-refresh.md) and its device-code surface — but no OpenAI flow, and the earlier directory decision that withheld OAuth-only providers (consolidated into this note's alternatives) kept `openai-codex` out of the configurable-provider directory entirely, so the Models page could not even offer a connect for it. The request: the same Connect → type-a-code → authorized experience Copilot has, using the ChatGPT subscription instead of an API key.

## Decision

**A built-in `openai-codex` flow.** `packages/llm/llm-oauth/src/openai-codex.ts` implements OpenAI's protocol end to end and registers in the service's `BUILTIN_FLOWS`; the service default `providers` is now `['github-copilot', 'openai-codex']`. The flow runs OpenAI's device authorization: `POST auth.openai.com/api/accounts/deviceauth/usercode` (`{client_id}`) yields `device_auth_id`, `user_code`, and a poll `interval` (a string on the wire); the user authorizes at `auth.openai.com/codex/device`; polling `deviceauth/token` treats 403/404 and `deviceauth_authorization_pending` as still pending and `slow_down` as a poll-rate increase, and completes with an **authorization code plus PKCE verifier** rather than tokens. The flow then exchanges them through the ordinary `authorization_code` grant at `auth.openai.com/oauth/token` (redirect `auth.openai.com/deviceauth/callback`) and refreshes through the same endpoint's `refresh_token` grant. The client id (`app_EMoamEEZ73f0CkXaXp7hrann`), endpoints, and redirect are OpenAI's protocol constants, not deployment tunables. `toAuth` delegates to the catalog provider's own method, which derives `https://chatgpt.com/backend-api`.

**Standalone, never Codex's file.** The flow never reads `~/.codex/auth.json`: login, storage, and background refresh live entirely in the harness's service-owned store (`$DSH_HOME/oauth-credentials.json`), exactly like Copilot's. The token endpoint rotates refresh tokens, and two concurrent refreshers on one file would invalidate each other; a single writer owns the lifecycle.

**The directory offers OAuth-only providers again.** `catalogProviderHasOAuth()` joins the catalog surface, and `directoryEntries()` now declares every installed catalog provider that offers an api-key method **or** an OAuth method. The Models page therefore shows the "OpenAI (ChatGPT Plus/Pro)" card with the same connect block Copilot uses, and the adapter request path stays unchanged: a connect writes `apiKeyEnv` and `baseURL` into the settings profile, `routeAuth` adds the harness api-key method beside the catalog's OAuth, and the seam's minted bearer rides as pi-ai's `apiKey` override. Endpoint specifics the spike established: `/backend-api/codex/models` requires a `client_version` query value, and `/backend-api/codex/responses` requires `store: false` plus streaming; pi-ai's `openai-codex-responses` api handles the request path (it appends `/codex/responses` and derives the account id from the access token's JWT claim), so no adapter change was needed.

## Alternatives considered

- **Reusing Codex's `~/.codex/auth.json` directly.** Rejected: it binds the harness to another tool's private file format, and the rotation race between two writers (Codex and the harness) can log one side out; a standalone flow with one store owner has neither defect.
- **Delegating login/refresh to pi-ai's own `openaiCodexOAuth`.** Rejected for the same reason as the Copilot flow: that implementation serves the pi CLI's credential store and interaction surface, while the harness service owns storage, publication into the credentials seam, and the background refresh scan.
- **Keeping the OAuth-only withholding.** Superseded — the offer was broken only because nothing in the harness ran a login, and llm-oauth now supplies exactly that. This note absorbs the withheld note's rationale, including its two boundaries, which remain in force: catalog *membership* is unchanged (so `declared` still means "no installed provider answers for this route"), and the profile half of the directory union stays unconditional (a stored profile remains visible and deletable).
- **Enforcing the offer in `resolveProfiles` instead of the directory.** Still rejected, preserving the old note's reasoning: `validate` runs at boot as well as at write time, so a stale keyless OAuth profile would fail the whole namespace's registration rather than one provider.

## Consequences

Every deployment now offers the OpenAI (ChatGPT Plus/Pro) connect card by default (inert until someone connects), and a connected provider contributes `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.5`, and `gpt-5.6-*` models to the picker through the untouched adapter path. Refresh rotation is contained: the service stores the rotated token set it receives. The web e2e goldens that lost the `openai-codex` option line regain it. The browser PKCE fallback (pi-ai's loopback-callback login) is deferred; the built-in flow implements the device path only.

## Testing

The flow has a dedicated unit spec with a mocked `fetch` (device login happy path incl. exchange body, 403-pending polling, refresh, and invalid-response failures). The directory test now asserts the offer (`openai-codex` present with `oauth: true`) instead of the withholding. The `models-settings` and `onboarding-usable-provider` web e2e goldens are re-recorded with the regained option line. A live probe of `deviceauth/usercode` returned 200 with the expected fields, confirming the device login is enabled for the public server.

## Related

- [OAuth provider login with background token refresh (llm-oauth)](../../implemented/feature/2026-08-16-llm-oauth-provider-login-and-refresh.md) — the service this flow extends.
- The withheld-OAuth-only-providers decision this change reverses is consolidated into this note's alternatives.
