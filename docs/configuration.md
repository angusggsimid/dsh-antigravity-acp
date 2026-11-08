# 配置

仓库里没有某台机器的默认值。连接信息放在本机文件 `~/.dsh/antigravity-acp.local.json`，不要提交。同名环境变量优先于这个文件。示例见仓库根目录的 `antigravity-acp.local.example.json`。

一条路线用下面的平铺字段。多条路线时改用 `routes` 数组，每一项都是同样的字段（`sshHost`、`sshKey`、`mcpPort`、`quotaUrl`、`quotaCredential`，以及可选的 `home` 和 `agent`）。插件不会为某一条路线另写一套行为。

## 多台机器

`routes` 里每一项是一条独立的隧道：自己的 SSH 主机、自己的密钥、自己的本机端口、自己的 `agy` 进程。模型选择器里选哪一项，就只用那一条。两项的 `provider` 不能相同。`modelName` 如果一样，选择器会自动加上 `providerName` 来区分。

没有 `routes` 时，文件顶层的 `sshHost` / `sshKey` 仍表示唯一的一条。

## 本机文件

| 字段 | 作用 |
| --- | --- |
| `sshHost` | 远端 `user@host`。不设就不能连 SSH |
| `sshKey` | SSH 私钥路径。不设就不能连 SSH |
| `mcpPort` | 本机 MCP 回环端口。`0` 表示由系统分配 |
| `quotaUrl` | 额度桥的基址。不设则额度面板不可用，聊天不受影响 |
| `quotaCredential` | DSH 凭据库里的引用名。不设则额度面板不可用 |
| `clientName` | ACP `clientInfo.name`。不设则用 `dsh` |
| `screenshotDir` | Playwright 截图目录。不设则用 `~/.dsh/cache/screenshots` |

## 连接

| 变量 | 对应字段 |
| --- | --- |
| `DSH_AGY_SSH_HOST` | `sshHost` |
| `DSH_AGY_SSH_KEY` | `sshKey` |
| `DSH_AGY_MCP_PORT` | `mcpPort` |
| `DSH_AGY_QUOTA_URL` | `quotaUrl` |
| `DSH_AGY_QUOTA_CREDENTIAL` | `quotaCredential` |
| `DSH_AGY_CLIENT_NAME` | `clientName` |
| `DSH_AGY_SCREENSHOT_DIR` | `screenshotDir` |
| `DSH_AGY_HOME` | 远端 `--gemini-dir`。默认 `$HOME/.dsh-antigravity`，由远端 shell 展开 |
| `DSH_AGY_AGENT` | 远端 agent 名，默认 `dsh-bridge` |
| `DSH_AGY_ACP_COMMAND` | 不用 SSH、改跑本地命令。测试用 |
| `DSH_AGY_NO_TUNNEL` | 设为 `1` 时不建反向隧道。测试用 |

## 容量

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `DSH_AGY_MAX_SESSIONS` | `3` | 软上限。超出时关掉最久未用的空闲会话 |
| `DSH_AGY_MAX_SESSIONS_HARD` | `4` | 硬上限。空闲会话也不够腾时，新会话直接报错 |
| `DSH_AGY_IDLE_MS` | `120000` | 空闲多久后 `session/close`（2 分钟） |
| `DSH_AGY_SWEEP_MS` | `60000` | 多久扫一次空闲会话 |

每个会话都会留下一个 worker，远端机器小就保持默认上限。机器更大时再调高。

## 一轮对话

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `DSH_AGY_IDLE_TIMEOUT_MS` | `600000` | 没有新输出多久算这一轮卡死（10 分钟） |
| `DSH_AGY_WORK_IDLE_TIMEOUT_MS` | `3600000` | 工具还挂着时的空闲上限（60 分钟） |
| `DSH_AGY_WATCHDOG_TICK_MS` | `2000` | 看门狗间隔 |
| `DSH_AGY_RELAY_AFTER_MS` | `85000` | 长工具先回一条「仍在运行」，避免 ACP 侧 3 分钟超时 |
| `DSH_AGY_CONTINUATIONS` | `3` | `max_tokens` 时在同一轮里续写的次数 |
| `DSH_AGY_REPLAY_BYTES` | `160000` | 不得不重放时，转录的字节上限 |
| `DSH_AGY_QUIET_MS` | `250` | 旧版 agy 上，等迟到片段的时间。1.5.1 及以后不用 |
| `DSH_AGY_META_SYSTEM_PROMPT` | 开启 | 设为 `0` 则不发送未写入文档的 `_meta` 系统提示。规则仍在 agent 正文里 |

## 行为开关

| 变量 | 默认 |
| --- | --- |
| `DSH_AGY_RESUME` | 开启。设为 `0` 则每次都新建 ACP 会话 |
| `DSH_AGY_WARMUP` | 开启。加载插件时先拉起前台进程 |
| `DSH_AGY_CONTEXT_WINDOW` | `256000`。向 DSH 声明的上下文，不是去改 agy 的窗口 |
| `DSH_AGY_CLIENT_NAME` | 见上面的本机文件。1.5.1 之后官方不再按客户端名隐藏模型 |
| `DSH_AGY_CWD` | 空则用远端隔离目录里的 workspace |
| `DSH_AGY_SESSION_STORE` | `~/.dsh/cache/antigravity-acp/sessions.json` |
