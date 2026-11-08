# 复现

这份说明只写行为，不写某一台机器的主机名、账号或密钥。把文中的占位符换成你自己的值，即可搭出和当前方案相同的结构。

## 一条路线里有什么

每条路线是三件东西：

- 一个 DSH 模型
- 一台已经装好官方 `agy` 并完成登录的远端机器
- 一条只在你自己电脑上的配置

聊天、工具回传、额度展示都是同一段插件代码。路线表有几行，这段代码就跑几遍。没有第二套插件。

## 远端机器

每台机器各自安装**同一个版本**的官方 `agy`，并各自登录**自己的** Google 账号。登录用：

```bash
agy acp --login
```

完成后，令牌在该用户家目录的 `.gemini/antigravity-cli/antigravity-oauth-token`。不要把这个文件拷到别的机器，也不要放进仓库。

`agy` 的执行权限只改隔离目录里的设置，不改这台机器上别的登录方式：

```json
{
  "toolPermission": "always-proceed",
  "agentMode": ""
}
```

文件位置是 `$HOME/.dsh-antigravity/agy/settings.json`。`always-proceed` 让 MCP、命令和网页工具不再逐次询问。拒绝规则仍然有效。

隔离目录里还有一个名为 `dsh-bridge` 的 agent：

- `plugin.json` 只有名字 `dsh-bridge`
- agent 文件的 front matter 是 `tools: []`、`excludeDefaultComponents: true`、`mainAgent: true`
- 正文是系统提示：只用 DSH 交来的工具，不要使用内置终端或文件工具；展示图片时写绝对路径的 Markdown，不要贴 base64

插件在**每一条路线启动时**都会重写这三样：agent 文件、`plugin.json`、上面的 `settings.json`，并把该机器自己的令牌复制进隔离目录（权限 `600`）。所以改插件里的这段准备逻辑，重新加载后会写到每一台已配置的机器上。

工作区信任是每台机器自己的家目录，例如该登录用户的 `$HOME`。不要把 A 机器的路径抄到 B 机器。

## 本机插件

配置放在 `~/.dsh/antigravity-acp.local.json`，不要提交。一条路线用平铺字段。多条路线用 `routes` 数组，每一项字段相同：

| 字段 | 作用 |
| --- | --- |
| `id` | 路线名。第一条用 `primary` 时，已有会话记录的键保持不变 |
| `provider` | DSH 里的提供方 id，每条路线各不相同 |
| `providerName` / `modelName` | 模型列表里看到的名字 |
| `sshHost` | `user@host` |
| `sshKey` | 私钥路径。权限应为只有本人可读 |
| `mcpPort` | 本机回环上的工具端口。每条路线用不同端口，`0` 表示由系统分配 |
| `home` | 远端隔离目录。默认 `$HOME/.dsh-antigravity`。必须让远端 shell 能展开，不要写成字面量 `$HOME` |
| `quotaUrl` | 这条路线的额度桥，仅本机回环 |
| `quotaCredential` | DSH 凭据库里的钥匙名。桥只接受同名的 Bearer |

改 `index.js`、`quota.js` 或 `client.js` 后重新加载插件，所有路线一起生效。这包括系统提示、会话上限、空闲回收、工具隧道和设置页怎么画额度。

## 额度桥

额度不从 ACP 会话里读。每台远端机器上跑**同一份**本地 HTTP 程序，只监听 `127.0.0.1`。它用这台机器自己的 `agy` 执行 `/usage` 和 `models`。本机为每条路线单独做 SSH 本地转发，把一个本机端口转到该机器上的桥。

插件不会把额度桥的程序推送到远端。桥的源文件要自己保持一致：改了一份，就把同一份部署到每一台机器，并重启那里的桥进程。钥匙各台可以不同，但每条路线的 `quotaCredential` 必须对上该台桥所检查的那把钥匙。

没有额度桥的路线仍然可以聊天。设置页那一行会显示还没有额度数据。

## 加载之后会看到什么

- 模型列表里每条路线一个 Gemini 3.8 Flash。选哪一个，聊天就走哪一台机器。
- 设置里的「Antigravity 订阅」每条路线一行。
- 输入框旁边的剩余额度只属于当前选中的路线。
- 两条路线的会话、worker 和额度互不相通。一台机器的内存上限只约束那一台。
