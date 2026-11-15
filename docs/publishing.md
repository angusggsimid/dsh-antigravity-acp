# 公开时守住的边界

仓库在 GitHub 上公开。别人用 `github:angusggsimid/dsh-antigravity-acp` 安装时，读的是仓库根目录的 `package.json`，其中的入口指向 `antigravity-acp/`。本机开发仍用 `link:` 指到 `antigravity-acp/`。两份 `package.json` 的 `"private": true` 都留着，避免被误发布到 registry。

许可证是 [MIT](../LICENSE)。

## 不要进仓库的东西

SSH 主机、私钥路径、回环端口、额度桥地址和凭据名只放在 `~/.dsh/antigravity-acp.local.json`。源码没有这些默认值。

不要把私钥、凭据文件、OAuth token 或 `sessions.json` 放进仓库。提交前用 `git grep` 再确认没有主机名、用户目录和具体端口。

## 说明里必须写明的行为

README 要保留这三件事，不要只写成「一个 Gemini 模型」：

- 插件会在远端启动官方 `agy`。
- 它会建立 SSH。
- 它会把工具调用经反向隧道送回运行 DSH 的机器。

## 安装路径

按仓库地址安装时，依赖是 `github:angusggsimid/dsh-antigravity-acp`，不要再写成子目录。本机 `link:` 仍指向 `antigravity-acp/`：

```text
github:angusggsimid/dsh-antigravity-acp → 仓库根目录
@local/dsh-antigravity-acp → <clone>/antigravity-acp
```

不要把 `antigravity-acp/` 改名或搬走，除非同时改掉 profile 里的 `link:` 和根目录 `package.json` 的入口。只改 profile 的 `package.json` 文本、却不重新安装，插件管理器不会跟着走。

## 还没做的事

- 包名仍然是 `@local/dsh-antigravity-acp`。GitHub 安装用这个名字当依赖名，spec 写仓库地址。要发到 registry 时再换名，并去掉 `"private": true`。
- `peerDependencies` 先不写。本插件没有直接 `import` `@deepseek-ai/*`，这些依赖由 DSH 在运行时注入。上架插件列表时再按那个列表的要求补。
