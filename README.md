# Antigravity ACP

[English](README.en.md)

DeepSeek Harness 插件。用官方 Antigravity CLI（`agy acp`）把 Gemini 3.8 Flash 接进 DSH。发往 Google 的请求由官方进程发出。读文件、跑命令这些工具仍在运行 DSH 的这台机器上执行。

选中这个模型时，设置页和输入框旁会显示订阅额度里的 5 小时窗口和每周窗口。

代码在 [`antigravity-acp/`](antigravity-acp/)。仓库根目录的 `package.json` 指向这个目录，所以按仓库地址安装即可。本机开发仍可 `link:` 到该目录。

## 它会动到什么

装上之后，这个插件会：

- 通过 SSH 在你自己的远端机器上启动 `agy acp`。
- 在本机开一个 MCP 服务，并用反向隧道把远端的工具调用送回来。
- 在远端准备一个隔离的 `agy` 家目录，并写入一个不带内置文件和终端工具的 agent。

它不会替你登录 Google，也不会把主机、密钥或端口写进仓库。这些都在你本机的配置文件里。

## 它做什么

- 在模型列表里提供 Gemini 3.8 Flash。同一份插件可以登记多条路线，每条路线是一个模型、一台远端机器、一个登录。
- 多个 DSH 会话可以同时使用这个模型。每个 ACP 会话有自己的 worker。
- 断线或空闲之后，优先恢复原来的 ACP 会话，而不是整段重放。
- 工具被退回 `unknown tool` 时，下一轮自动换一个新的 ACP 会话：先确认反向隧道可通，再把当前对话重放进去。每个会话最多重建两次，之后照常失败并报错，不会无限重连。
- 远端转发端口被上一次 DSH 留下的会话占用时，自动换一个远端端口重连，并让受影响的会话重建。需要固定端口时在该路线写 `remotePort`。
- 设置里有一节「Antigravity 订阅」；输入框在选中 Gemini 时显示剩余额度。

## 拓展

路线写在本机配置里，不写进仓库。聊天、工具回传和额度展示都走同一段代码：加一条路线不会分出第二套插件。设置页按路线各显示一行额度，输入框只显示当前选中的那一条。某条路线没有额度桥时，聊天不受影响。

## 它不做什么

- 不伪装成别的客户端，也不复刻 Gemini 的 HTTP 接口。
- 不从 ACP 对话里读取 5 小时 / 每周额度。ACP 只返回这一轮的 token。额度来自一条单独的本地 HTTP 桥，没有这条桥时聊天仍然可用。
- 不在这里管理云端账号。登录在远端的 `agy` 里完成。
- 不发布到 npm。`package.json` 里的 `"private": true` 是故意留下的。

## 使用前要有的东西

- DeepSeek Harness。
- 一台能运行官方 `agy` 的机器，以及从本机到它的 SSH。
- 远端的 `agy` 已经登录 Google AI Pro / Antigravity。
- 只有在要显示额度时，才需要那条本地 HTTP 桥，以及 DSH 凭据库里对应的钥匙。
- 建议在那台机器上跑一次 [`scripts/server-guard.sh`](scripts/server-guard.sh)：加 swap、限制日志、每 5 分钟记录资源并回收无主 worker。理由和做法见 [docs/ops/server.md](docs/ops/server.md)。没装也能用，但那台机器的内存见底时整机会连同 SSH 一起卡死。

## 安装

按仓库地址安装，把下面这一行加进 profile 的 `dependencies`，并把 `@local/dsh-antigravity-acp` 加进 `dsh.profile.bundles`：

```json
"@local/dsh-antigravity-acp": "github:angusggsimid/dsh-antigravity-acp"
```

命令行等价于 `dsh plugin --profile <profile> add github:angusggsimid/dsh-antigravity-acp`。桌面版的 profile 名是 `desktop`，不是 `web`。装完后重新加载 DSH。Host 侧的改动只刷新页面不够。

本机改代码时，仍把依赖指到克隆下来的 `antigravity-acp/` 目录：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@local/dsh-antigravity-acp"]
    }
  },
  "dependencies": {
    "@local/dsh-antigravity-acp": "link:/absolute/path/to/dsh-antigravity-acp/antigravity-acp"
  }
}
```

然后在 profile 目录安装依赖，再重新加载 DSH。Host 侧的改动需要重新加载插件，只刷新页面不够。

## 配置

复制 [`antigravity-acp.local.example.json`](antigravity-acp.local.example.json) 为 `~/.dsh/antigravity-acp.local.json`，填上你自己的 SSH 主机、私钥路径，以及可选的额度桥。同名环境变量会覆盖这个文件。

仓库里没有默认主机，也没有默认端口。字段说明见 [docs/configuration.md](docs/configuration.md)。

## 开发

```bash
cd antigravity-acp
npm test
```

`npm test` 使用本地 mock，不连接远端，也不消耗额度。`npm run test:real` 会连你配置好的真实 `agy acp`。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/setup.md](docs/setup.md) | 怎样复现整套路线，不含任何一台机器的秘密 |
| [docs/architecture.md](docs/architecture.md) | 现在的结构 |
| [docs/configuration.md](docs/configuration.md) | 本机配置和环境变量 |
| [docs/decisions.md](docs/decisions.md) | 已经定下来的取舍 |
| [docs/publishing.md](docs/publishing.md) | 公开仓库时守住的边界 |
| [docs/ops/server.md](docs/ops/server.md) | 远端机器上要装的东西：swap、看护、无主 worker 回收 |
| [docs/history/migration-plan.md](docs/history/migration-plan.md) | 最初的改造计划，其中一部分已被后来的决定取代 |

## 许可证

[MIT](LICENSE)
