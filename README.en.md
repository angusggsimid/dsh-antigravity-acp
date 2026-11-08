# Antigravity ACP

[中文](README.md)

A DeepSeek Harness plugin that runs Gemini 3.8 Flash through the official Antigravity CLI (`agy acp`). Google only sees that official process. File and command tools still run on the machine where DeepSeek Harness is running.

While this model is selected, Settings and the composer show the 5-hour and weekly windows of the Antigravity subscription quota.

The installable package is [`antigravity-acp/`](antigravity-acp/). DeepSeek Harness loads `cordis.patch.yml` from that directory.

## What it touches

After installation this plugin will:

- Start `agy acp` over SSH on a remote machine you provide.
- Open a local MCP server and a reverse tunnel, so tool calls from that remote process come back to this machine.
- Prepare an isolated `agy` home on the remote host, with an agent that has no built-in file or terminal tools.

It does not sign you in to Google, and it does not ship a host, a key, or a port. Those live in a file on your machine.

## What it does

- Registers the `antigravity` provider and the `gemini-3.8-flash` model.
- Lets more than one DeepSeek Harness session use the model at once. Each ACP session has its own worker.
- Resumes the previous ACP session after idle time or a dropped connection, instead of replaying the whole transcript.
- Adds an Antigravity subscription section in Settings, and a quota badge beside the composer while Gemini is selected.

## What it does not do

- It does not impersonate another client, and it does not reimplement the Gemini HTTP API.
- It does not read the 5-hour or weekly quota from the ACP session. ACP reports tokens for the current turn only. Those windows come from a separate local HTTP bridge. Chat still works without that bridge.
- It does not manage the cloud account. Sign-in stays inside `agy` on the remote host.
- It is not published to npm. `"private": true` in `package.json` is intentional.

## Requirements

- DeepSeek Harness.
- A machine that can run official `agy`, and SSH from this computer to it.
- `agy` on that machine already signed in to Google AI Pro / Antigravity.
- The local HTTP bridge, and a credential in the DeepSeek Harness store, only if you want the quota badge.

## Install

Clone this repository and point your DeepSeek Harness profile at the `antigravity-acp/` directory. Add the package to `dsh.profile.bundles`:

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

Install dependencies in the profile, then reload DeepSeek Harness. A page refresh is not enough for host-side changes.

## Configure

Copy [`antigravity-acp.local.example.json`](antigravity-acp.local.example.json) to `~/.dsh/antigravity-acp.local.json` and fill in your SSH host, private-key path, and the optional quota bridge. Environment variables with the same meaning override that file.

The repository has no default host and no default port. See [docs/configuration.md](docs/configuration.md).

## Develop

```bash
cd antigravity-acp
npm test
```

`npm test` uses a local mock. It does not contact a remote host and does not spend quota. `npm run test:real` talks to the real `agy acp` from your local configuration.

## License

[MIT](LICENSE)
