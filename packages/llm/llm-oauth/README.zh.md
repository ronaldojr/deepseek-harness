# @deepseek-ai/dsh-llm-oauth

[English](README.md) | 中文

为「按订阅鉴权、而非 API 密钥」的 LLM 提供方提供一等公民的 OAuth 登录能力。该服务拥有一条提供方连接的完整生命周期：通过转发事件驱动的设备码登录、持久化凭证存储、在后台重新签发短期访问令牌并写入凭证接缝的续期器，以及断开连接路径。「模型」设置页会为每个适配器声明了 OAuth 方法的提供方渲染连接流程。

GitHub Copilot 与 OpenAI Codex（ChatGPT Plus/Pro）流程内置提供；其他提供方可在运行时注册自己的流程。

## 插件

`apply(ctx, config)` 挂载 `oauth` 服务——一个 Typert Remote，浏览器客户端通过生成的 `oauth.*` 命名空间调用。

| 配置 | 默认值 | 含义 |
|---|---|---|
| `storePath` | — | 持久化凭证存储文件路径（JSON，仅属主可读写）。 |
| `providers` | `['github-copilot', 'openai-codex']` | 启用内置流程的提供方路由键。 |
| `credentialRefs` | `{}` | 按提供方覆盖凭证引用；缺省时派生 `<PROVIDER>_API_KEY`。 |
| `refreshIntervalMs` | `60_000` | 后台续期扫描的周期。 |
| `refreshAheadMs` | `300_000` | 到期前多久视为需要续期。 |
| `loginTimeoutMs` | `900_000` | 浏览器授权迟迟不来的登录守卫超时。 |
| `settingsNs` | `llm-pi-ai` | 记录连接状态的设置命名空间。 |

## Remote 契约

| 方法 | 行为 |
|---|---|
| `status` | 报告某提供方的连接视图：`disconnected`、`connecting`、`device-code`（含 URL 与代码）、`connected`（含到期时间）或 `failed`（含消息）。 |
| `login` | 启动设备码登录；进度通过转发的 `oauth/state` 事件流动。已连接时幂等；登录进行中时拒绝。 |
| `cancel` | 中止一次进行中的登录。 |
| `disconnect` | 删除存储的凭证并取消其凭证引用。 |

## 连接生命周期

登录执行流程的设备授权：服务发出携带验证 URL 与用户代码的 `oauth/state` 事件，随后完成交换。成功后提交三件各自可重试的事项：

1. 持久化存储写入凭证（`type: 'oauth'`、刷新材料、访问令牌、到期时间）；
2. 凭证接缝在该提供方的引用下写入新签发的 bearer 密钥——消费方 LLM 适配器的请求路径保持不变；
3. 当没有任何层固定 `apiKeyEnv` 与 `baseURL` 时，设置档案写入这两项，使全新连接无需任何手动步骤。

后台扫描会在 `refreshAheadMs` 内到期前重新签发令牌并重新发布；续期被拒绝时保留旧令牌并把失败记入视图。启动时服务会重新发布所有已存储令牌；稍后注册的流程也会重新发布自己的已存储凭证。

## 安全

存储文件通过 `dsh-atomic-write` 以 `mode 0600`、目录 `dirMode 0700` 写入，服务从不把它载入进程环境。凭证接缝保持其既有语义；存储文件是服务自有的状态文件，而非用户可编辑配置。

## 扩展点

`ctx.oauth.registerFlow(flow)` 激活某提供方的 `login`/`refresh`/`toAuth` 实现；返回的 disposer 将其移除。内置的 GitHub Copilot 流程直接实现设备码登录与 `/copilot_internal/v2/token` 交换（pi-ai 自带的 `login` 还会执行一串极易触发限流的模型策略请求，可能拒绝一个已经拿到令牌的登录），而 base URL 推导仍沿用上游 pi-ai 的 `toAuth`。内置的 OpenAI Codex 流程执行 OpenAI 的 `auth.openai.com` 设备授权（完成时返回授权码加 PKCE verifier），经普通 `authorization_code` grant 交换、经 `refresh_token` grant 续期；`toAuth` 同样沿用目录提供方自己的方法，推导出 `https://chatgpt.com/backend-api`。

## 模型体验

间接地，通过发布到凭证接缝的 bearer 凭证以及将其序列化进提供方请求的 LLM 适配器。

#### KV Cache 效果

发布的访问令牌改变请求的 Authorization 头，而非请求内容；令牌轮换是否使复用失效，取决于消费方适配器如何序列化该请求头。

## 已知限制与待办

- **仅支持公开 github.com** —— 内置流程假定公开 GitHub 域；企业域推迟支持。
- **OpenAI 仅设备登录** —— 内置流程只实现设备路径；pi-ai 的浏览器 PKCE 兜底（loopback 回调）推迟支持。
- **短期访问令牌** —— Copilot 令牌约 30 分钟过期；服务会自动续期，但 GitHub 授权本身数小时后过期，需要一次新的设备登录，以 `failed` 阶段呈现。
- **存储为 JSON 而非 YAML** —— 服务自有状态文件，不同于用户可编辑的凭证文档。
- **不做模型策略启用** —— 流程跳过 pi-ai 的模型策略请求；账号未启用的模型会被提供方在中途拒绝。
