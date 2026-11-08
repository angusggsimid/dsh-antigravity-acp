# Antigravity ACP

A DeepSeek Harness plugin that runs Gemini 3.8 Flash through the official Antigravity ACP server. Harness tools still execute on the local machine. The same plugin shows the Antigravity subscription in Settings and the 5-hour / weekly remainder next to the model selector.

The installable package is [`antigravity-acp/`](antigravity-acp/). DeepSeek Harness loads `cordis.patch.yml` from that directory.

## What it does

- Registers the `antigravity` provider and `gemini-3.8-flash`.
- Talks JSON-RPC to `agy acp` over SSH. Google only sees the official client.
- Exposes Harness tools to that client through a local MCP server and a reverse tunnel.
- Shows subscription quota in Settings and, while Gemini is selected, beside the composer.

## What it does not do

- It does not impersonate a client or reimplement the Gemini HTTP API.
- It does not read the 5-hour or weekly quota from the ACP session. ACP reports tokens for the current turn only. Those windows still come from the existing HTTP bridge.
- It does not perform Google sign-in. `agy` on the remote host owns the OAuth token.

## Requirements

- A host that can run official `agy`, and SSH from this machine to it.
- `agy` on that host already signed in to Google AI Pro / Antigravity.
- For the quota badge only: a separate local HTTP bridge, plus a credential already stored by DeepSeek Harness. The bridge address and the credential name live in local configuration, not in this repository. Chat does not use that bridge.

Host, key path, ports, and the quota bridge are read from `~/.dsh/antigravity-acp.local.json` or from environment variables. The repository ships with no machine defaults. See [docs/configuration.md](docs/configuration.md).

## Develop

```bash
cd antigravity-acp
npm test
```

`npm test` uses a local mock and does not spend quota. `npm run test:real` talks to a real `agy acp`.

This repository is not published and has no license yet. `"private": true` is intentional.
