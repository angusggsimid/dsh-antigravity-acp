# Antigravity ACP

DeepSeek Harness 插件：用官方 Antigravity CLI 的 ACP 跑 Gemini 3.8 Flash，工具仍在本机执行。同一个插件里带订阅额度：设置页，以及选中 Gemini 时输入框旁边的 5 小时 / 每周剩余。

可安装的包在 [`antigravity-acp/`](antigravity-acp/)。DSH 通过这个目录的 `cordis.patch.yml` 加载它。

英文说明见 [README.en.md](README.en.md)。

## 它做什么

- 在模型列表里提供 `antigravity` / `gemini-3.8-flash`。
- 通过 SSH 在远端跑 `agy acp`。发往 Google 的请求由官方进程发出。
- 把 DSH 的工具经本机 MCP 暴露给远端，执行和审批仍留在 DSH。
- 设置里显示 Antigravity 订阅；输入框在选中 Gemini 时显示剩余额度。

## 它不做什么

- 不伪造客户端标识，不复刻 Gemini HTTP 接口。
- 不从 ACP 对话里读 5 小时 / 每周额度。ACP 只返回这一轮的 token。额度来自原来的 HTTP 桥。
- 不在这里管理云端账号或 OAuth。登录在远端的 `agy` 里完成。

## 使用前要有的东西

- 一台能跑官方 `agy` 的机器，以及从本机到它的 SSH。
- 远端已经用 `agy` 登录 Google AI Pro / Antigravity。
- 额度徽章需要一条单独的本地 HTTP 桥，以及 DSH 凭据库里的一把钥匙。地址和凭据名都在本机配置里，不在这个仓库。聊天不依赖这条桥。

主机、密钥、端口和额度桥都写在本机的 `~/.dsh/antigravity-acp.local.json`（或同名环境变量）里。仓库不带默认值。见 [docs/configuration.md](docs/configuration.md)。

## 安装到当前 DSH profile

插件目录就是 `antigravity-acp/`。本机 profile 已经用 `link:` 指到这里。换机器时把这个目录装进目标 profile，不要另拷一份再改代码。

装好后重新加载页面（`Cmd+R`）。Host 侧改动需要 DSH 重新加载该插件。

## 开发

```bash
cd antigravity-acp
npm test
```

`npm test` 使用本地 mock，不连远端，也不消耗额度。`npm run test:real` 会连真实的 `agy acp`。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | 现在的结构 |
| [docs/configuration.md](docs/configuration.md) | 环境变量 |
| [docs/decisions.md](docs/decisions.md) | 已经定下来的取舍 |
| [docs/publishing.md](docs/publishing.md) | 以后放到 GitHub 之前要处理的事 |
| [docs/history/migration-plan.md](docs/history/migration-plan.md) | 最初的改造计划（部分已被后来的决定取代） |

## 发布状态

还没有放到 GitHub，也还没有选许可证。`package.json` 里的 `"private": true` 是故意留下的。
