# Agent Note：OpenAI Codex（ChatGPT）OAuth 登录与 OAuth-only 提供方的目录展示

Status: implemented

[English](2026-08-18-openai-codex-chatgpt-oauth-login.md) | 中文

## 问题

ChatGPT Plus/Pro 订阅模型（`gpt-5.4`、`gpt-5.5`、`gpt-5.6-*`）按订阅的 OAuth 鉴权，而非 API 密钥。harness 已有通用机制——[llm-oauth 服务](../../implemented/feature/2026-08-16-llm-oauth-provider-login-and-refresh.md)及其设备码界面——但没有 OpenAI 流程，且早期「目录不展示 OAuth-only 提供方」的决策（已并入本笔记的备选方案）把 `openai-codex` 完全挡在可配置提供方目录之外，使「模型」页连连接入口都无法提供。需求：获得与 Copilot 相同的「连接 → 输入代码 → 授权」体验，但用的是 ChatGPT 订阅而不是 API 密钥。

## 决策

**内置 `openai-codex` 流程。** `packages/llm/llm-oauth/src/openai-codex.ts` 端到端实现 OpenAI 的协议，并注册进服务的 `BUILTIN_FLOWS`；服务默认 `providers` 现为 `['github-copilot', 'openai-codex']`。流程执行 OpenAI 的设备授权：`POST auth.openai.com/api/accounts/deviceauth/usercode`（`{client_id}`）返回 `device_auth_id`、`user_code` 与轮询 `interval`（线上为字符串）；用户在 `auth.openai.com/codex/device` 授权；轮询 `deviceauth/token` 时把 403/404 与 `deviceauth_authorization_pending` 视为仍待授权、把 `slow_down` 视为拉长轮询间隔，完成时返回的是**授权码加 PKCE verifier** 而非令牌。流程随后用普通 `authorization_code` grant 在 `auth.openai.com/oauth/token` 交换（redirect `auth.openai.com/deviceauth/callback`），并经同一端点的 `refresh_token` grant 续期。客户端 id（`app_EMoamEEZ73f0CkXaXp7hrann`）、端点与 redirect 是 OpenAI 的协议常量，不是部署可调项。`toAuth` 沿用目录提供方自己的方法，推导出 `https://chatgpt.com/backend-api`。

**完全独立，绝不读取 Codex 的文件。** 流程从不读取 `~/.codex/auth.json`：登录、存储与后台续期完全在 harness 服务自有的存储（`$DSH_HOME/oauth-credentials.json`）内完成，与 Copilot 一致。令牌端点会轮换 refresh token，同一文件上的两个并发续期方会互相注销对方；单一写入方拥有完整生命周期。

**目录重新展示 OAuth-only 提供方。** 目录表面新增 `catalogProviderHasOAuth()`，`directoryEntries()` 现在声明所有提供 api-key 方法**或** OAuth 方法的已安装目录提供方。「模型」页因此展示「OpenAI（ChatGPT Plus/Pro）」卡片与 Copilot 相同的连接区块，而适配器请求路径保持不变：连接把 `apiKeyEnv` 与 `baseURL` 写入设置档案，`routeAuth` 在目录 OAuth 旁补充 harness 的 api-key 方法，接缝签发的 bearer 以 pi-ai 的 `apiKey` 覆盖随请求送达。实测确立的端点事实：`/backend-api/codex/models` 需要 `client_version` 查询值，`/backend-api/codex/responses` 需要 `store: false` 且必须流式；pi-ai 的 `openai-codex-responses` api 已处理请求路径（自行追加 `/codex/responses`，并从访问令牌的 JWT 声明推导账号 id），因此无需改动适配器。

## 备选方案

- **直接复用 Codex 的 `~/.codex/auth.json`。** 否决：把 harness 绑在另一工具的私有文件格式上，且两个写入方（Codex 与 harness）之间的轮换竞态可能把其中一方登出；独立流程 + 单一存储属主没有这两个缺陷。
- **把 login/refresh 委托给 pi-ai 自带的 `openaiCodexOAuth`。** 与 Copilot 流程同理否决：该实现服务于 pi CLI 的凭证存储与交互界面，而 harness 服务拥有存储、向凭证接缝发布与后台续期扫描。
- **保留 OAuth-only 不展示。** 已被取代——此前展示入口之所以破损，只是因为 harness 内没有任何环节执行登录，而 llm-oauth 恰好补上了这一点。本笔记吸收旧笔记的理由，包括其两条仍有效的边界：目录*成员资格*不变（`declared` 仍表示「没有已安装提供方对此路由负责」），目录并集的档案半边保持无条件（已存储的档案仍可见可删）。
- **在 `resolveProfiles` 里强制该展示，而非目录层。** 仍否决，保留旧笔记的推理：`validate` 在启动与写入时都会运行，陈旧的 keyless OAuth 档案会拖垮整个命名空间的注册，而非只影响一个提供方。

## 后果

每个部署现在默认展示 OpenAI（ChatGPT Plus/Pro）连接卡片（未连接前保持惰性），连接成功后 `gpt-5.4`、`gpt-5.4-mini`、`gpt-5.5` 与 `gpt-5.6-*` 模型经未改动的适配器路径进入选择器。续期轮换被收拢：服务保存它收到的轮换后令牌组。曾丢失 `openai-codex` 选项行的 web e2e 黄金文件恢复该行。浏览器 PKCE 兜底（pi-ai 的 loopback 回调登录）推迟；内置流程仅实现设备路径。

## 测试

流程有独立的单元 spec，以 mock `fetch` 覆盖（设备登录 happy path 含交换请求体、403-视为待授权的轮询、续期与非法响应失败）。目录测试现断言展示（`openai-codex` 存在且 `oauth: true`）而非不展示。`models-settings` 与 `onboarding-usable-provider` 两个 web e2e 黄金文件以恢复的选项行重新录制。对 `deviceauth/usercode` 的实测探针返回 200 与预期字段，确认公开服务器已启用设备登录。

## 相关

- [OAuth 提供方登录与后台令牌续期（llm-oauth）](../../implemented/feature/2026-08-16-llm-oauth-provider-login-and-refresh.md) —— 本流程所扩展的服务。
- 本变更所推翻的「目录不展示 OAuth-only 提供方」决策已并入本笔记的备选方案。
