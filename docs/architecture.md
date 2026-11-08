# 架构

当前实现。最初的计划图在 [history/architecture-diagram.svg](history/architecture-diagram.svg)，计划正文在 [history/migration-plan.md](history/migration-plan.md)。和计划不一致的地方以本文和 [decisions.md](decisions.md) 为准。

## 两条互不替代的路

```
聊天
  DSH stream()
    → 本插件（antigravity-acp）
    → SSH stdio 上的 JSON-RPC
    → 远端 agy acp --process-per-session
    → Google 只看到官方 agy

工具
  agy 调 MCP
    → 反向隧道
    → 本机 127.0.0.1 上的 MCP
    → DSH 执行，再把结果写回挂起的调用

额度
  设置页 / 输入框徽章
    → 本插件的 /api/agy-subscription/status
    → 本机配置里的 HTTP 桥
    → 远端 agy -p /usage
```

聊天不经过 HTTP 桥。额度不从 ACP 会话里读。`session/prompt` 返回的 `usage` 只是这一轮的 token。

## 进程

远端只有一个常驻的 `agy acp` 前台。每个 ACP 会话再起一个 worker。`agy` 不会因为空闲而关掉这些 worker。本插件在空闲到期或需要给新会话腾位置时发送 `session/close`，worker 随之退出。worker 不小，会话上限按远端机器自己定。

本机到远端的 ACP 通道是一条 SSH。工具用同一条连接上的反向端口转发。额度桥是另一条隧道，地址只写在本机配置里。

## 会话对应

DSH 的会话号和 ACP 的会话号不是同一个值。本机 `~/.dsh/cache/antigravity-acp/sessions.json` 记下映射。键是 `DSH会话:用途`，所以同一个 DSH 会话里的主对话、标题和子任务可以各有一个 ACP 会话。

空闲被关掉之后，下一次发言优先 `session/resume` 原来的 ACP 会话。只有远端会话已经不在、历史对不上、或中间用过别的模型时，才 `session/new` 并重放。

DSH 没有「这个会话结束了」的适配器回调。插件只能看到 `stream()` 被调用。所以回收靠两件事：太久没人用，以及新会话需要名额时淘汰最久未用、且当前不忙的会话。正在跑的会话不会被挤掉。

## 隔离

远端使用单独的 `--gemini-dir`（默认 `$HOME/.dsh-antigravity`）和名为 `dsh-bridge` 的 agent。这个 agent 不带内置文件和终端工具。每个 DSH 会话有自己的 MCP tenant 和 bearer，工具调用靠 URL 认领会话，而不是靠猜「现在谁在说话」。

## 额度显示

设置页和输入框徽章读同一份缓存。页面先画出上次的数字；超过 1 分钟才在后台刷新；之后大约每 5 分钟再查一次。点设置里的刷新走的也是这一次查询。
