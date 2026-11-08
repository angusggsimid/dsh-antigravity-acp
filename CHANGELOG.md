# Changelog

## 5.5.0

- 订阅设置页、输入框额度徽章和 `gemini_quota` 工具并入本插件。额度仍通过原来的 HTTP 桥读取，数据格式和刷新节奏不变。
- 不再单独安装 `@local/dsh-gemini-quota`。

## 5.4.0

- 前台进程被替换时，未完成的调用会失败，而不是一直等。
- 看门狗发现链路已死就结束这一轮，并在工具步骤之间保持布防。
- 会话记下自己属于哪一次前台进程；前台换过之后用 `session/resume` 接回同一个 ACP 会话。
- 默认容量保持在较小的软上限和硬上限。每个 ACP 会话会留下自己的 worker，远端机器较小就不要再调高。
- 空闲回收默认 2 分钟。`agy` 不会自己回收 ACP worker，只有 `session/close` 会让 worker 退出。

## 5.3.0

- 静态系统提示写进远端 agent 文件正文。`_meta` 只附带 DSH 这一轮传来的系统提示。正文这条路在关掉 `_meta` 之后仍然有效。

## 5.2.0

- 隔离目录的 `toolPermission` 使用官方值 `always-proceed`。
- 修正传给远端的路径引号，`--gemini-dir` 会展开成真实家目录，而不是一个名字就叫 `$HOME` 的目录。

## 5.1.0

- 1.5.1 及以后的 agent 不再为了静默排空多等一轮。更早的版本仍保留排空。
- 认证失败按 JSON-RPC `-32000` 识别。
- 工具声明带 `antigravity/alwaysLoad`。
- `session/new` 同时发送 `cwd` 和 `additionalDirectories`。
