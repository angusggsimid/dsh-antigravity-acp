# dsh-antigravity-acp

DeepSeek Harness 插件包。通过 SSH 上的官方 `agy acp` 运行 Gemini。默认模型是 Gemini 3.8 Flash，路线上的 `modelId` 可以改成那台机器的 `agy` 所接受的其他模型。工具在运行 DSH 的机器上执行。项目说明、安装方式和许可证在仓库根目录：

- [../README.md](../README.md)
- [../README.en.md](../README.en.md)
- [../docs/architecture.md](../docs/architecture.md)
- [../docs/configuration.md](../docs/configuration.md)
- [../LICENSE](../LICENSE)

按仓库地址安装时用根目录的 `package.json`。本目录仍是 profile 里 `link:` 的目标。不要单独搬走，也不要发布到 npm。

```bash
npm test
```
