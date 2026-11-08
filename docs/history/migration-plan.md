> 这是动手之前写的改造计划，不是当前实现说明。
> 聊天已经改走 ACP。额度徽章没有改走 ACP，仍用原来的 HTTP 桥。会话上限、空闲回收和「订阅并入 ACP 插件」都是后来定的，见 [../decisions.md](../decisions.md) 和 [../architecture.md](../architecture.md)。

# Antigravity ACP 接入方案（改造计划）

> 目标：把现在的「反向 HTTP 桥」换成**官方 ACP 协议**，同时保持「工具在 Mac 本地执行」和「不用本地 VPN」。

---

## 一、已经验证过的事实（不是设想）

我在远端主机上跑了四组原型，全部通过：

| 验证项 | 结果 |
| --- | --- |
| **SSH stdio 上跑 ACP** | `ssh 服务器 agy acp` + 换行分隔 JSON-RPC → `initialize` 返回 `protocolVersion: 1`，`agentInfo: Antigravity ACP Server 1.5.3` |
| **建会话 + 模型目录** | `session/new` 返回 `sessionId` 与 `availableModels`，含 `gemini-3.8-flash-low/medium/high`；`configOptions` 有 `model`、`thought_level`(`low/medium/high`)、`mode` |
| **真实提问** | `session/prompt` 流式返回 `agent_message_chunk`，3.3 秒收到「通了」，`stopReason: end_turn` |
| **真实用量** | `usage: {inputTokens: 6914, outputTokens: 136, thoughtTokens: 134, totalTokens: 7050}` —— 这是现在 HTTP 桥拿不到的精度 |
| **工具回到 Mac 执行** | Mac 上起 MCP 服务 + `ssh -R` 反向隧道，会话里声明 `mcpServers: [{type:'http', url:'http://127.0.0.1:PORT/mcp'}]`；模型调 `echo_tool` → **Mac 收到调用** → 返回 `ECHO_FROM_MAC:hello` → 模型继续作答 |
| **受限密钥能做反向转发** | 现有 `restrict,port-forwarding,permitopen=...` 密钥下，`ssh -R 127.0.0.1:18992:...` 在服务器上成功监听 |
| **无僵尸进程** | 关闭 SSH stdin 后，服务器上的 `agy acp` 自动退出 |

**结论：方案可行，且比现方案在协议真实性、用量精度、上下文可见性上都更好。**

---

## 二、目标架构

```
┌──────────────────── Mac (DSH Host) ────────────────────┐
│  DSH agent loop                                        │
│    │  llm.stream()                                     │
│    ▼                                                   │
│  AntigravityAdapter (LlmAdapter)                       │
│    ├── runtime: ACP 会话池 / 配置项 / 流映射            │
│    ├── transport: ssh -T → JSON-RPC peer               │
│    └── mcp-bridge: 127.0.0.1:PORT (DSH 工具暴露为 MCP)  │
└───────────────┬───────────────────────────▲────────────┘
                │ SSH stdio (ACP JSON-RPC)  │ 反向隧道 -R (MCP HTTP)
                ▼                           │
┌──────────────── 远端主机 ─────────────────┴───────────┐
│  agy acp --process-per-session                          │
│    └── 官方进程：自己登录、自己发请求、带真实设备指纹     │
└────────────────────────────────────────────────────────┘
```

关键点：**所有发往 Google 的请求都由官方 `agy` 发出**。插件只跟它说 JSON-RPC，不伪造 UA、不伪造设备 ID、不复刻接口。

---

## 三、组件拆解

| 模块 | 职责 | 复杂度 |
| --- | --- | --- |
| `transport.ts` | spawn `ssh -T`，JSON-RPC 收发（换行分隔），进程退出/超时/重连，stderr 尾部留档 | 中 |
| `adapter.ts` | 实现 `LlmAdapter`：`providerInfo` / `listModels` / `resolveModel` / `stream` | 低 |
| `runtime.ts` | ACP 会话池（DSH session ↔ ACP session）、配置项设置（model/thought_level）、`session/update` → `StreamChunk` 映射、取消 | **高** |
| `mcp-bridge.ts` | Mac 侧 Streamable HTTP MCP：`initialize`/`tools/list`/`tools/call`，把调用**挂起**交给 DSH | **高** |
| `tunnel.ts` | 反向隧道生命周期（`-R 127.0.0.1:PORT`）、健康检查、断线重连 | 中 |
| `history.ts` | DSH 历史 → ACP 转录：增量发送、分叉重建、字节预算 | **高** |
| `quota.ts` | 复用 `agy -p /usage`（不消耗模型额度） | 低 |
| `client.js` | 设置页 + 输入框额度徽章（沿用现 UI，数据源换成 ACP usage） | 中 |

---

## 四、核心机制：工具如何「挂起 → 本地执行 → 回填」

这是整个方案最关键、也最容易做错的部分：

```
1. DSH 调 stream()
2. adapter 在 ACP 会话上发 session/prompt
3. 模型决定调用 MCP 工具 → agy POST 到 Mac 的 /mcp/<tenant>
4. mcp-bridge 登记这次调用，【挂起 HTTP 响应不返回】
5. adapter 感知到挂起 → 当前 stream 以 finish(tool-calls) 结束，
   把 tool-call block 交给 DSH
6. DSH 走自己的权限与执行管线（审批、bash、读文件……）
7. DSH 下一次 stream() 调用进来 → adapter 把工具结果写回第 4 步的挂起响应
8. agy 继续生成 → 新内容继续流式回传
```

**长工具的特殊处理**（bash 可能跑几分钟，而 agy 对单次 MCP 调用有 ~180 秒上限）：

- 超过 `relayAfterMs`（默认 85 秒）先回一条「仍在运行」+ MCP progress 通知，维持连接与缓存活跃
- 模型改用 `dsh_await_result` 继续等同一结果
- DSH 侧仍然只看到**一次**工具调用

---

## 五、协议映射表

| ACP 事件 | → DSH `StreamChunk` |
| --- | --- |
| `agent_message_chunk`(text) | `text-delta` |
| `agent_thought_chunk` | `reasoning-delta` |
| `tool_call` / `tool_call_update` | 不直接透传（工具走 MCP 挂起通道） |
| `session/prompt` 结果里的 `usage` | `usage` chunk（含 cacheRead/thought） |
| `stopReason: end_turn` | `finish: stop` |
| `stopReason: max_tokens` | `finish: length` → 可续写 |
| `stopReason: cancelled` | `finish: aborted` |
| `session/request_permission` | 一律拒绝（工具由 DSH 执行，不需要 agy 自己跑） |

---

## 六、分阶段实施

每个阶段都能独立验收，失败可停在上一阶段。

### P0 · 环境准备（约 30 分钟）
- 服务器与 Mac 的 `agy` 升级到最新（`agy update`）——**这是降风险前提**
- 固定一个本机 MCP 端口，并在 `authorized_keys` 里只允许监听这个回环端口
- 保留现有 HTTP 桥不删，作为回退
- **验收**：`agy acp` 在新版本上仍能完成 `initialize` 握手

### P1 · 传输层（约 0.5 天）
- `transport.ts`：spawn `ssh -T 服务器 agy acp`，JSON-RPC 编解码，超时与退出处理
- **验收**：脚本能打 `initialize` 并打印 `agentInfo`，进程关闭后服务器无残留

### P2 · 纯文本对话（约 1 天）
- `adapter.ts` + `runtime.ts` 的会话创建、`session/prompt`、流式文本、usage
- 模型选择与 `thought_level` 设置
- **验收**：DSH 里选 Antigravity 模型，正常对话，返回答复且 usage 有非零值

### P3 · 工具桥（约 1.5 天，最难）
- `mcp-bridge.ts` + `tunnel.ts`：DSH 工具经 MCP 暴露、反向隧道、挂起/回填、长工具中继
- **验收**：DSH 里让模型跑 `bash ls`，命令在 Mac 上执行，结果显示在对话里；再跑一次 2 分钟以上的命令，验证中继不死

### P4 · 会话与历史（约 1 天）
- 同一 DSH 会话复用同一 ACP 会话，只发增量
- 压缩/编辑/回退时按 DSH 历史重建（字节预算保护）
- 取消（`session/cancel`）、错误映射（AUTH/QUOTA/RATE_LIMIT/TIMEOUT/TRANSPORT）
- **验收**：连续 10 轮对话上下文正确；中途压缩后不丢；点停止能中断

### P5 · 观测（约 0.5 天）
- 用量与上下文表盘（用 ACP 返回的真实 usage，不需要读服务器 sqlite）
- 额度：`agy -p /usage`，沿用现设置页与徽章
- **验收**：设置页显示账号/模型/额度；输入框旁显示 5 小时与每周

### P6 · 切换与清理（约 0.5 天）
- 停用 HTTP 桥与伪造 UA 路径
- 移除 `llm-pi-ai` 里的 gemini 路由
- **验收**：关掉桥后 DSH 仍能正常用 Gemini，且流量里不再有伪造头

---

## 七、风险与退路

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| ACP 协议版本漂移 | 插件失效 | 启动时 preflight 校验 `protocolVersion` 与 `agentInfo`，不匹配则拒绝启用并提示 |
| `agy` 升级改行为 | 会话/工具异常 | P0~P5 期间保留旧 HTTP 桥，一键切回 |
| 反向隧道不可用 | 工具无法回到本地 | 明确报错并降级为「仅对话」，不静默失败 |
| 上下文默认 256K | 长任务被截断 | **不做二进制 patch**（风险大）；按 256K 声明，触发 DSH 压缩 |
| 同账号双地点 | 风控 | 建议服务器为唯一使用点；Mac 本地不再跑 `agy` |
| 服务器残留进程 | 占资源 | 已验证 stdin 关闭即退出；再加 systemd 兜底清理 |

---

## 八、对照：值不值得换

| 维度 | 现在的 HTTP 桥 | ACP 方案 |
| --- | --- | --- |
| 客户端特征 | 伪造 UA/版本，缺 device_id | 全部真实 |
| 工具调用 | 我做 JSON Schema 清洗（已踩 3 次坑） | 无需清洗 |
| 用量精度 | 轮末汇总 | 每步真实 input/cache/thought |
| 上下文可见 | 无 | 有 |
| 子代理并发 | 串行 | `--process-per-session` 原生并发 |
| 接口变更抗性 | 低（我复刻的） | 高（官方协议） |
| 工程量 | 已投入 | 约 4~5 个工作日 |

---

## 九、需要你确认的四件事

1. **是否升级 `agy` 到最新版本**（P0 前提，也直接降低风控）
2. **MCP 桥端口**用哪个回环端口
3. **是否保留旧 HTTP 桥**作为回退（建议保留到 P6 验收后再删）
4. **只要 Gemini，还是也要同一 CLI 里的其他模型**。早期客户端名会影响模型列表；1.5.1 之后不再按客户端名隐藏。本仓库默认用普通客户端名，具体名字放在本机配置里。
