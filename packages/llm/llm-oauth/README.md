# @deepseek-ai/dsh-llm-oauth

English | [中文](README.zh.md)

First-class OAuth login for LLM providers that authenticate by subscription rather than API key. The service owns the full lifecycle of one provider connection: a device-flow login driven over a forwarded event, durable credential storage, a background refresher that re-mints the short-lived access token and publishes it into the credentials seam, and a disconnect path. The Models settings page renders the connect flow for every provider whose adapter advertises an OAuth method.

The GitHub Copilot and OpenAI Codex (ChatGPT Plus/Pro) flows ship built in; other providers register their flow at runtime.

## Plugin

`apply(ctx, config)` mounts the `oauth` service, a Typert Remote whose generated `oauth.*` namespace the browser client calls.

| Config | Default | Meaning |
|---|---|---|
| `storePath` | — | Path of the durable credential store file (JSON, owner-only). |
| `providers` | `['github-copilot', 'openai-codex']` | Provider route keys whose built-in flows activate. |
| `credentialRefs` | `{}` | Credential-reference overrides by provider; absent derives `<PROVIDER>_API_KEY`. |
| `refreshIntervalMs` | `60_000` | Cadence of the background refresh scan. |
| `refreshAheadMs` | `300_000` | How early before expiry a refresh is due. |
| `loginTimeoutMs` | `900_000` | Guard cancelling a login whose browser authorization never arrives. |
| `settingsNs` | `llm-pi-ai` | Settings namespace whose provider profiles record the connection. |

## Remote contract

| Method | Behavior |
|---|---|
| `status` | Reports one provider's connection view: `disconnected`, `connecting`, `device-code` (with URL and code), `connected` (with expiry), or `failed` (with message). |
| `login` | Starts the device-flow login; progress flows through the forwarded `oauth/state` event. Idempotent while connected; rejects while a login is in flight. |
| `cancel` | Aborts one in-flight login. |
| `disconnect` | Removes the stored credential and unsets its credential reference. |

## Connection lifecycle

A login runs the flow's device authorization: the service emits `oauth/state` with the verification URL and user code, then the exchange. On success it commits three artifacts atomically enough that each is retryable on its own:

1. the durable store gains the credential (`type: 'oauth'`, refresh material, access token, expiry),
2. the credentials seam gains the minted bearer key under the provider's reference — the consuming LLM adapter's request path stays unchanged, and
3. the settings profile gains `apiKeyEnv` and `baseURL` when no layer pinned them, so a fresh connect needs no manual step.

The background scan re-mints tokens due within `refreshAheadMs` and republishes them; a refresh rejection keeps the last token and records the failure in the view. On boot the service republishes every stored token, and a flow registering later republishes its own stored credential.

## Security

The store file is written with `mode 0600` under `dirMode 0700` through `dsh-atomic-write`, and the service never loads it into the process environment. The credentials seam keeps its existing semantics; the store is a service-owned state file, not user-editable configuration.

## Extension point

`ctx.oauth.registerFlow(flow)` activates one provider's `login`/`refresh`/`toAuth` implementation; the disposer removes it. The built-in GitHub Copilot flow implements the device-code login and the `/copilot_internal/v2/token` exchange directly (pi-ai's own `login` also runs a rate-limit-hungry model-policy burst that can reject a login that already obtained its token), while base-URL derivation stays upstream in pi-ai's `toAuth`. The built-in OpenAI Codex flow runs OpenAI's `auth.openai.com` device authorization (whose completion yields an authorization code plus PKCE verifier), exchanges it through the ordinary `authorization_code` grant, and refreshes through the `refresh_token` grant; `toAuth` is again the catalog provider's own, deriving `https://chatgpt.com/backend-api`.

## Model Experience

Indirectly, through the bearer credential published into the credentials seam and the LLM adapter that serializes it into provider requests.

#### KV Cache effect

The published access token changes the request's Authorization header, not request content; whether a rotated token invalidates reuse depends on the consuming adapter's serialization of that header.

## Known Limitations and Deferred Work

- **Public github.com only** — the built-in flow assumes the public GitHub domain; enterprise domains are deferred.
- **OpenAI device login only** — the built-in flow implements the device path; pi-ai's browser PKCE fallback (loopback callback) is deferred.
- **Short-lived access tokens** — Copilot tokens expire in ~30 minutes; the service refreshes them, but the GitHub authorization itself expires after hours and then requires a fresh device login, surfaced as the `failed` phase.
- **Store is JSON, not YAML** — a service-owned state file, unlike the user-editable credentials document.
- **No policy/model enabling** — the flow skips pi-ai's model-policy burst; a model the account has not enabled is refused by the provider mid-turn.
