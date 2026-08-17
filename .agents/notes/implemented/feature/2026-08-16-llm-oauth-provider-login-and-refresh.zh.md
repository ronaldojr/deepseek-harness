# Agent Note：OAuth 提供方登录与后台令牌续期（llm-oauth）

Status: implemented

[English](2026-08-16-llm-oauth-provider-login-and-refresh.md) | 中文

## 问题

按订阅鉴权的 LLM 提供方没有可粘贴的 API 密钥。GitHub Copilot 通过 OAuth 设备流鉴权，其访问令牌约 30 分钟过期，因此「模型」页仅有的密钥卡片根本无法连接它，而任何在外部取得的令牌半小时内就会失效。pi-ai 自带了流程（`githubCopilotOAuth`），但其 `login` 还会执行一串「启用所有模型」的策略请求和一次 `/models` 可用性拉取，其限流足迹可能拒绝一个已经拿到令牌的登录（实测：设备授权完成后收到 `429 Too Many Requests`）；同时 `llm-pi-ai` 有意让 `Models` 不持有凭证存储，因此整个 harness 中没有环节执行登录或续期。

## 决策

**新增宿主服务 `packages/llm/llm-oauth`。** `ctx.oauth` 端到端拥有一条提供方连接：通过转发的 `oauth/state` Cordis 事件驱动的设备码登录、持久化且仅属主可读写的存储（`$DSH_HOME/oauth-credentials.json`，经 `dsh-atomic-write` 写入）、在 `refreshAheadMs` 内到期时重新签发令牌并发布到**凭证接缝**的后台扫描，以及断开连接路径。经凭证接缝发布使 `llm-pi-ai` 的请求路径保持不变：适配器照旧解析 API 密钥，插件只负责让这把密钥保持新鲜。连接成功后，若没有任何层固定 `apiKeyEnv` 与 `baseURL`，服务会把这两项写入档案，使全新连接无需手动步骤。启动时重新发布所有已存储令牌；稍后注册的流程也会重新发布自己的已存储凭证。

**手写交换、沿用上游 `toAuth`。** GitHub Copilot 流程直接实现两个 GitHub 端点（设备码 + `/copilot_internal/v2/token`），避开 pi-ai `login`/`refresh` 中上述失败模式的策略请求尾部；从令牌 `proxy-ep` 声明推导 base URL 仍沿用上游 pi-ai 的 `toAuth`。流程接口（`login`/`refresh`/`toAuth`）即运行时扩展点：`ctx.oauth.registerFlow(flow)`。

**Typert Remote `oauth`。** 服务是 `TypertRemoteService`（`status`/`login`/`cancel`/`disconnect`）；生成的 `oauth.*` 命名空间挂载进 api-remotes 客户端装配，`oauth/state` 加入 `API_REMOTE_FORWARDED_EVENTS`，载荷词汇经 `@deepseek-ai/dsh-api-remotes/client` 再导出。

**模型页连接区。** `LlmConfigurableProvider` 新增 `oauth` 事实（`catalogProvider(provider)?.auth.oauth !== undefined`），经 apiproxy 的 `ConfigurableProviderView` 传递。`ui-settings-models` 为带该事实的提供方渲染 `OauthConnectBlock`（登录按钮、带复制按钮的设备码面板、实时状态、断开连接），由 `OauthViewStore` 通过 `ctx.remote.oauth` 供数——客户端插件自行注入 `remote.oauth` 命名空间，与 `ui-commands` 注入 `remote.commands` 的模式一致。缺少 oauth 面时退化为惰性桩，未挂载该服务的组合渲染不变。

**卸载静默。** 卸载 effect 先置 `closed` 标志再中止进行中的登录；`emitView` 丢弃卸载后的发射——本包的 invariant 伴生件（`oauth/state` 要求存在活跃服务）现在将其钉死。

## 备选方案

**经接缝接入 pi-ai 的 `Models` 凭证存储。** 库的设计路径（存储驱动续期、按凭证的 baseUrl、按 `availableModelIds` 过滤模型）。否决：它推翻了 `llm-pi-ai` 已评审的「`Models` 不持有凭证存储」决策，且 api-key 覆盖路径本就能达成相同的线上结果。

**原样使用 pi-ai 的 `login`。** 因策略请求尾部否决：设备授权成功仍可能抛出并丢失凭证。

**为 OAuth 状态增设通用设置页分区。** 否决：连接入口属于提供方卡片、密钥字段旁——连接在此建立、也在此判断。

## 后果

`dsh web` 组合可挂载该服务（`storePath: !!js dshHomePath('oauth-credentials.json')`）；模型页为每个支持 OAuth 的目录提供方显示「连接 GitHub」，已连接的提供方在 GitHub 授权本身过期（约数小时）前无需人工干预即可自动续期，过期以 `failed` 阶段呈现。存储为服务自有 JSON，而非用户可编辑配置。企业 GitHub 域与按账号的模型策略启用仍为待办。
