# 公开之前

这个目录还不是 Git 仓库，也还没有推到 GitHub。下面这些事留到真的要公开时再做。

## 机器相关的值不在仓库里

SSH 主机、私钥路径、回环端口、额度桥地址和凭据名都只放在 `~/.dsh/antigravity-acp.local.json`。源码没有这些默认值。

不要把私钥、凭据文件、OAuth token 或 `sessions.json` 放进仓库。提交前用 `git grep` 再确认没有主机名、用户目录和具体端口。

## 还没定的事

- 许可证。没有 `LICENSE` 之前不要标成某个协议。
- 包名。现在是 `@local/dsh-antigravity-acp`，只适合本机 `link:`。公开给别人安装时要换成可发布的名字，并去掉 `"private": true`（仅在真的要发到 registry 时）。
- `peerDependencies`。本插件没有直接 `import` `@deepseek-ai/*`，依赖由 DSH 在运行时注入。要上架插件列表时再按那个列表的要求补，不要提前写一串对不上的版本。

## 建议放进仓库说明的风险

README 里已经写了：插件会在远端启动 `agy`，会建立 SSH，会把工具经反向隧道送回本机。公开时保留这段，不要只写「一个 Gemini 模型」。

## 安装路径

本机 profile 的依赖是：

```text
@local/dsh-antigravity-acp → <本目录>/antigravity-acp
```

整理文档时不要把 `antigravity-acp/` 改名或搬走，除非同时用 DSH 的插件安装入口改掉这个 link。只改 profile 里的 `package.json` 不会走插件管理器的加载。
